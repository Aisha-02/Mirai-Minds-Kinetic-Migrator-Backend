"""Write one downloadable file per classified scenario (.xlsx or .csv)."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import pandas as pd

from validation_engine.constants import VALIDATION_ERRORS_COL, VALIDATION_STATUS_COL


def normalize_output_format(value: str | None, source_suffix: str) -> str:
    suffix = str(value or "").strip().lower().lstrip(".")
    if suffix in {"xlsx", "csv"}:
        return suffix
    return "csv" if str(source_suffix or "").lower() == ".csv" else "xlsx"


def scenario_output_filename(scenario: str, source_name: str, output_format: str) -> str:
    safe_scenario = _slug(scenario)
    safe_source = _slug(source_name)
    return f"{safe_scenario}__{safe_source}_validated.{output_format}"


def write_frames(frames: Iterable[pd.DataFrame], path: Path, output_format: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    iterator = iter(frames)
    try:
        first = next(iterator)
    except StopIteration:
        empty = pd.DataFrame(columns=[VALIDATION_STATUS_COL, VALIDATION_ERRORS_COL])
        if output_format == "csv":
            empty.to_csv(path, index=False)
        else:
            empty.to_excel(path, index=False, engine="openpyxl")
        return

    if output_format == "csv":
        first.to_csv(path, mode="w", header=True, index=False)
        for frame in iterator:
            frame.to_csv(path, mode="a", header=False, index=False)
        return

    collected = [first, *iterator]
    combined = pd.concat(collected, ignore_index=True)
    combined.to_excel(path, index=False, engine="openpyxl")


def _slug(value: str) -> str:
    cleaned = "".join(
        ch if ch.isalnum() or ch in frozenset({"-", "_"}) else "_"
        for ch in str(value or "")
    ).strip("_")
    return cleaned or "table"
