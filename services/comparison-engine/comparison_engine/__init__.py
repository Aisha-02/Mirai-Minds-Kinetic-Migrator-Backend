"""Directional dataset comparison — pure logic, no I/O dependencies."""

from comparison_engine.core import (
    ComparisonConfig,
    ComparisonError,
    build_identifier,
    compare_datasets,
    dataframe_to_rows,
    validate_identifier_columns,
)

__all__ = [
    "ComparisonConfig",
    "ComparisonError",
    "build_identifier",
    "compare_datasets",
    "dataframe_to_rows",
    "validate_identifier_columns",
]
