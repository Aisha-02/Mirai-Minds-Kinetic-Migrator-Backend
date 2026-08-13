from pathlib import Path

import pandas as pd

from tests.conftest import HeaderClassifier, mm_rules, so_rules
from validation_engine.constants import VALIDATION_STATUS_COL
from validation_engine.engine import validate_preload
from validation_engine.readers import TableRef, iter_table_chunks
from validation_engine.rules import InMemoryRulesProvider


def _provider():
    return InMemoryRulesProvider({"MM": mm_rules(), "SO": so_rules()})


def test_single_sheet_single_scenario(tmp_path: Path):
    source = tmp_path / "mm.xlsx"
    pd.DataFrame(
        {
            "MATERIAL_NUMBER": ["100", "200"],
            "MATERIAL_TYPE": ["FERT", "ROH"],
            "GROSS_WEIGHT": ["10", "12"],
            "NET_WEIGHT": ["8", "9"],
            "BEDAT": ["20240101", "20240201"],
        }
    ).to_excel(source, index=False, sheet_name="Materials")

    result = validate_preload(
        source,
        rules_provider=_provider(),
        classifier=HeaderClassifier(),
        output_dir=tmp_path / "out",
        output_format="xlsx",
    )
    assert len(result.scenarios) == 1
    assert not result.unclassified
    scenario = result.scenarios[0]
    assert scenario.scenario == "MATERIAL_MASTER"
    assert scenario.rules_business_object == "MM"
    assert scenario.output_path.exists()
    assert scenario.output_path.suffix == ".xlsx"
    written = pd.read_excel(scenario.output_path)
    assert VALIDATION_STATUS_COL in written.columns
    assert len(written) == 2


def test_multi_sheet_multi_scenario(tmp_path: Path):
    source = tmp_path / "mixed.xlsx"
    with pd.ExcelWriter(source, engine="openpyxl") as writer:
        pd.DataFrame(
            {
                "MATNR": ["100"],
                "MTART": ["FERT"],
                "GROSS_WEIGHT": ["10"],
                "NET_WEIGHT": ["8"],
                "BEDAT": ["20240101"],
            }
        ).to_excel(writer, index=False, sheet_name="MMData")
        pd.DataFrame(
            {
                "VBELN": ["9001", "9002"],
                "POSNR": ["10", "20"],
            }
        ).to_excel(writer, index=False, sheet_name="SOData")

    result = validate_preload(
        source,
        rules_provider=_provider(),
        classifier=HeaderClassifier(),
        output_dir=tmp_path / "out",
        output_format="xlsx",
    )
    scenarios = {item.scenario: item for item in result.scenarios}
    assert set(scenarios) == {"MATERIAL_MASTER", "SALES_ORDER"}
    assert not result.unclassified
    assert scenarios["MATERIAL_MASTER"].output_path.exists()
    assert scenarios["SALES_ORDER"].output_path.exists()
    assert scenarios["MATERIAL_MASTER"].output_path != scenarios["SALES_ORDER"].output_path
    so_df = pd.read_excel(scenarios["SALES_ORDER"].output_path)
    assert len(so_df) == 2


def test_unmatched_sheet_is_not_forced(tmp_path: Path):
    source = tmp_path / "unknown.xlsx"
    with pd.ExcelWriter(source, engine="openpyxl") as writer:
        pd.DataFrame(
            {
                "MATERIAL_NUMBER": ["100"],
                "MATERIAL_TYPE": ["FERT"],
                "GROSS_WEIGHT": ["10"],
                "NET_WEIGHT": ["8"],
                "BEDAT": ["20240101"],
            }
        ).to_excel(writer, index=False, sheet_name="Known")
        pd.DataFrame({"FOO": ["a"], "BAR": ["b"], "BAZ": ["c"]}).to_excel(
            writer, index=False, sheet_name="Noise"
        )

    result = validate_preload(
        source,
        rules_provider=_provider(),
        classifier=HeaderClassifier(),
        output_dir=tmp_path / "out",
    )
    assert len(result.scenarios) == 1
    assert result.scenarios[0].scenario == "MATERIAL_MASTER"
    assert len(result.unclassified) == 1
    unknown = result.unclassified[0]
    assert unknown.source_name == "Noise"
    assert unknown.detection.business_object == "NONE_MATCHED"
    assert unknown.detection.needs_manual_selection
    assert len(list((tmp_path / "out").glob("*"))) == 1


def test_large_csv_processed_in_chunks(tmp_path: Path, monkeypatch):
    rows = 25
    source = tmp_path / "large_mm.csv"
    pd.DataFrame(
        {
            "MATERIAL_NUMBER": [f"M{i:04d}" for i in range(rows)],
            "MATERIAL_TYPE": ["FERT"] * rows,
            "GROSS_WEIGHT": ["10"] * rows,
            "NET_WEIGHT": ["8"] * rows,
            "BEDAT": ["20240101"] * rows,
        }
    ).to_csv(source, index=False)

    monkeypatch.setattr("validation_engine.readers.CSV_CHUNK_THRESHOLD_BYTES", 1)
    seen_chunksize: list[int] = []
    import pandas as pd_mod

    original = pd_mod.read_csv

    def wrapped_read_csv(*args, **kwargs):
        if "chunksize" in kwargs:
            seen_chunksize.append(kwargs["chunksize"])
        return original(*args, **kwargs)

    monkeypatch.setattr(pd_mod, "read_csv", wrapped_read_csv)

    result = validate_preload(
        source,
        rules_provider=_provider(),
        classifier=HeaderClassifier(),
        output_dir=tmp_path / "out",
        output_format="csv",
        chunksize=10,
    )
    assert len(result.scenarios) == 1
    scenario = result.scenarios[0]
    assert scenario.row_count == rows
    assert scenario.chunks_processed == 3
    assert 10 in seen_chunksize
    assert seen_chunksize.count(10) >= 1
    assert scenario.output_path.suffix == ".csv"
    written = pd.read_csv(scenario.output_path)
    assert len(written) == rows
    assert VALIDATION_STATUS_COL in written.columns


def test_excel_sheet_is_read_in_row_batches(tmp_path: Path, monkeypatch):
    rows = 45
    source = tmp_path / "batched.xlsx"
    pd.DataFrame(
        {
            "MATERIAL_NUMBER": [f"M{i}" for i in range(rows)],
            "MATERIAL_TYPE": ["ROH"] * rows,
            "GROSS_WEIGHT": ["4"] * rows,
            "NET_WEIGHT": ["2"] * rows,
            "BEDAT": ["20240101"] * rows,
        }
    ).to_excel(source, index=False, sheet_name="MM")

    import validation_engine.readers as readers

    batch_sizes: list[int] = []
    original = readers._iter_excel_sheet_chunks

    def wrapped(*args, **kwargs):
        for chunk in original(*args, **kwargs):
            batch_sizes.append(len(chunk))
            yield chunk

    monkeypatch.setattr(readers, "_iter_excel_sheet_chunks", wrapped)

    result = validate_preload(
        source,
        rules_provider=_provider(),
        classifier=HeaderClassifier(),
        output_dir=tmp_path / "out",
        chunksize=15,
    )
    scenario = result.scenarios[0]
    assert scenario.chunks_processed == 3
    assert scenario.row_count == 45
    assert all(size <= 15 for size in batch_sizes)
    assert 15 in batch_sizes


def test_iter_csv_uses_pandas_chunksize(tmp_path: Path, monkeypatch):
    source = tmp_path / "tiny.csv"
    pd.DataFrame(
        {"MATERIAL_NUMBER": ["1", "2", "3"], "MATERIAL_TYPE": ["A", "B", "C"]}
    ).to_csv(source, index=False)
    monkeypatch.setattr("validation_engine.readers.CSV_CHUNK_THRESHOLD_BYTES", 1)
    table = TableRef(name="tiny", path=source)
    chunks = list(iter_table_chunks(table, chunksize=1))
    assert tuple(chunk["MATERIAL_NUMBER"].iloc[0] for chunk in chunks) == ("1", "2", "3")
    assert tuple(chunk["MATERIAL_TYPE"].iloc[0] for chunk in chunks) == ("A", "B", "C")


def test_one_bad_table_does_not_fail_batch(tmp_path: Path):
    good = tmp_path / "mm.csv"
    pd.DataFrame(
        {
            "MATERIAL_NUMBER": ["100"],
            "MATERIAL_TYPE": ["FERT"],
            "GROSS_WEIGHT": ["10"],
            "NET_WEIGHT": ["8"],
            "BEDAT": ["20240101"],
        }
    ).to_csv(good, index=False)
    bad = tmp_path / "broken.csv"
    bad.write_text("not,a,valid\n", encoding="utf-8")

    class BoomClassifier(HeaderClassifier):
        def classify(self, columns, sample_rows=None, table=None):
            if table and table.path == bad:
                raise RuntimeError("classifier exploded")
            return super().classify(columns, sample_rows, table)

    result = validate_preload(
        [good, bad],
        rules_provider=_provider(),
        classifier=BoomClassifier(),
        output_dir=tmp_path / "out",
    )
    assert len(result.scenarios) == 1
    assert len(result.errors) == 1
    assert "exploded" in result.errors[0].error
