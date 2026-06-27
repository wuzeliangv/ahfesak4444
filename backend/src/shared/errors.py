"""
Domain errors. Each maps to an HTTP status; the router converts them to
standard error responses. Internal exceptions are caught at the boundary
and converted to a generic 500 without leaking traceback.
"""

from __future__ import annotations


class PanelError(Exception):
    code: str = "PanelError"
    status: int = 500

    def __init__(self, message: str, **extra: object) -> None:
        super().__init__(message)
        self.message = message
        self.extra = extra


class BadRequest(PanelError):
    code = "BadRequest"
    status = 400


class Unauthorized(PanelError):
    code = "Unauthorized"
    status = 401


class InvalidCredentials(PanelError):
    """AK/SK rejected by AWS (signature mismatch, deactivated, expired)."""

    code = "InvalidCredentials"
    status = 401


class NotFound(PanelError):
    code = "NotFound"
    status = 404


class UpstreamError(PanelError):
    """AWS returned a non-credential error (throttling, region issue, etc.)."""

    code = "UpstreamError"
    status = 502
