import pandas as pd

from tests.conftest import mm_rules
from validation_engine.constants import STATUS_FAIL, VALIDATION_STATUS_COL
from validation_engine.evaluate import (
    FindingAccumulator,
    annotate_and_collect,
    collect_key_values,
    duplicate_value_sets,
)
from validation_engine.rules import prepare_fields


def test_key_null_duplicate_and_net_vs_gross():
    fields = prepare_fields(mm_rules())
    frame = pd.DataFrame(
        {
            "MATERIAL_NUMBER": ["A1", "A1", None, "B2"],
            "MATERIAL_TYPE": ["FERT", "ROH", "HALB", None],
            "GROSS_WEIGHT": ["10", "5", "3", "8"],
            "NET_WEIGHT": ["4", "9", "1", "2"],
            "BEDAT": ["20240101", "2024-01-01", "20240101", "20240101"],
        }
    )
    store: dict = {}
    collect_key_values(frame, fields, store, 0)
    dups = duplicate_value_sets(store)
    acc = FindingAccumulator()
    annotated = annotate_and_collect(
        frame,
        fields,
        row_offset=0,
        accumulator=acc,
        duplicate_values=dups,
    )
    findings = acc.to_findings()
    findings_by_rule = {(item["fieldName"], item["ruleName"]): item for item in findings}

    assert ("MATERIAL_NUMBER", "Duplicate Check") in findings_by_rule
    assert set(findings_by_rule[("MATERIAL_NUMBER", "Duplicate Check")]["affectedRows"]) >= {1, 2}
    assert findings_by_rule[("MATERIAL_NUMBER", "Null/Empty Value Check")]["affectedCount"] >= 1
    assert ("NET_WEIGHT", "Net Weight Not Exceeding Gross Weight") in findings_by_rule
    assert ("MATERIAL_TYPE", "MTART_Valid_Domain_Value") in findings_by_rule
    assert findings_by_rule[("BEDAT", "SAP DATS Format Check")]["affectedCount"] >= 1
    assert annotated[VALIDATION_STATUS_COL].iloc[1] == STATUS_FAIL
