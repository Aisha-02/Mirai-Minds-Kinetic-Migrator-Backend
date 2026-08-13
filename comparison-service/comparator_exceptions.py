"""Exceptions for dataset comparison."""

from __future__ import annotations


class ComparisonError(Exception):
    """Base class for comparison errors."""


class MissingKeyColumnsError(ComparisonError):
    """Raised when requested key columns are absent from a dataset."""

    def __init__(self, missing: list[str], *, sheet_name: str | None = None) -> None:
        self.missing = missing
        self.sheet_name = sheet_name
        prefix = f"Sheet '{sheet_name}': " if sheet_name else ""
        super().__init__(f"{prefix}Missing key columns: {', '.join(missing)}")


class SheetStructureMismatchError(ComparisonError):
    """Raised when source and target workbook structures are incompatible."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
