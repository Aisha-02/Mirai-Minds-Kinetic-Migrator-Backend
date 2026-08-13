"""Exceptions for SAP key-field resolution."""

from __future__ import annotations


class KeyResolverError(Exception):
    """Base class for key resolution errors."""


class BusinessObjectNotFoundError(KeyResolverError):
    """Raised when a business object or sheet cannot be mapped to SAP metadata."""

    def __init__(
        self,
        name: str,
        *,
        supported: tuple[str, ...] | None = None,
    ) -> None:
        self.name = name
        self.supported = supported
        message = f"Business object not found or not supported: '{name}'"
        if supported:
            message += f". Supported: {', '.join(supported)}"
        super().__init__(message)


class AmbiguousSheetMappingError(KeyResolverError):
    """Raised when a sheet name maps to multiple business objects."""

    def __init__(self, sheet_name: str, candidates: list[str]) -> None:
        self.sheet_name = sheet_name
        self.candidates = candidates
        super().__init__(
            f"Ambiguous sheet mapping for '{sheet_name}': "
            f"matched {', '.join(candidates)}"
        )


class SapApiConnectionError(KeyResolverError):
    """Raised when the SAP metadata API is unreachable or times out."""

    def __init__(self, message: str, *, cause: Exception | None = None) -> None:
        self.cause = cause
        super().__init__(message)


class SapApiResponseError(KeyResolverError):
    """Raised when SAP returns an error or no usable key fields."""

    def __init__(self, message: str, *, code: str | None = None) -> None:
        self.code = code
        super().__init__(message)


class MissingKeyFieldsError(KeyResolverError):
    """Raised when SAP metadata returns no identifier columns."""

    def __init__(self, business_object: str) -> None:
        self.business_object = business_object
        super().__init__(
            f"No key fields returned from SAP for business object '{business_object}'"
        )
