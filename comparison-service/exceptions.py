"""Custom exceptions for the file parsing module."""

from __future__ import annotations


class ParseError(Exception):
    """Base class for parsing-related errors."""


class UnsupportedFileTypeError(ParseError):
    """Raised when the file extension is not supported."""

    def __init__(self, extension: str, *, allowed: tuple[str, ...]) -> None:
        self.extension = extension
        self.allowed = allowed
        super().__init__(
            f"Unsupported file type '{extension}'. "
            f"Allowed extensions: {', '.join(allowed)}"
        )


class ParseFileNotFoundError(ParseError):
    """Raised when a file path does not exist."""

    def __init__(self, path: str) -> None:
        self.path = path
        super().__init__(f"File not found: {path}")


class CorruptedFileError(ParseError):
    """Raised when a file cannot be read due to corruption or invalid format."""

    def __init__(self, message: str, *, cause: Exception | None = None) -> None:
        self.cause = cause
        super().__init__(message)


class EmptySheetError(ParseError):
    """Raised when a sheet or file contains no data rows."""

    def __init__(self, *, sheet_name: str | None = None) -> None:
        self.sheet_name = sheet_name
        if sheet_name:
            super().__init__(f"Sheet '{sheet_name}' contains no data rows")
        else:
            super().__init__("File contains no data rows")


class LazyModeNotSupportedError(ParseError):
    """Raised when lazy parsing is requested for an unsupported format."""

    def __init__(self, extension: str) -> None:
        self.extension = extension
        super().__init__(
            f"Lazy parsing is not supported for '{extension}' files. "
            "Use lazy=False for Excel workbooks."
        )


class MissingFilenameError(ParseError):
    """Raised when bytes input is provided without a filename for extension detection."""

    def __init__(self) -> None:
        super().__init__(
            "filename is required when source is bytes so the file type "
            "can be determined from the extension"
        )
