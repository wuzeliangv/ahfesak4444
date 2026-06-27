"""
API Gateway HTTP API v2 response helpers.

All API responses follow:
    success: {"ok": true, "data": ...}
    error:   {"ok": false, "error": {"code": "...", "message": "..."}}

CORS headers are added here so every response carries them. The actual CORS
allowed-origin is configured at the API Gateway level via SAM template; we
just echo the safe defaults so OPTIONS preflight and direct curl both work.
"""

from __future__ import annotations

import json
from typing import Any

# Headers attached to every response. The API Gateway template also sets
# CORS via its own config, but having these on the Lambda response means
# `sam local start-api` works without API Gateway CORS rewriting.
_BASE_HEADERS: dict[str, str] = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
}


def _serialize(payload: Any) -> str:
    return json.dumps(payload, default=str, ensure_ascii=False, separators=(",", ":"))


def ok(data: Any, *, status: int = 200) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": _BASE_HEADERS,
        "body": _serialize({"ok": True, "data": data}),
    }


def err(code: str, message: str, *, status: int = 400, **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"code": code, "message": message}
    if extra:
        body.update(extra)
    return {
        "statusCode": status,
        "headers": _BASE_HEADERS,
        "body": _serialize({"ok": False, "error": body}),
    }
