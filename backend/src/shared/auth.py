"""
Request parsing + credential extraction.

Two layers:
  1. API key  — guards the API Gateway endpoint itself (set via x-api-key header,
                value comes from PANEL_API_KEY env var on the Lambda).
                Without this, anyone who finds the URL could invoke our Lambdas.
  2. AWS AK/SK — supplied by the frontend in the request body for each call.
                  We only hold them in memory for the duration of the invocation.

Never log credential values. Helpers here only ever expose AK prefix (first 8
chars) for cache keys and debug breadcrumbs.
"""

from __future__ import annotations

import json
import os
from typing import Any

from src.aws.clients import Creds
from src.shared.errors import BadRequest, Unauthorized


def parse_body(event: dict[str, Any]) -> dict[str, Any]:
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        import base64

        raw = base64.b64decode(raw).decode("utf-8")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise BadRequest(f"invalid JSON body: {e.msg}") from e
    if not isinstance(parsed, dict):
        raise BadRequest("body must be a JSON object")
    return parsed


def require_api_key(event: dict[str, Any]) -> None:
    """Validate the x-api-key header against PANEL_API_KEY env var.

    If PANEL_API_KEY is unset (e.g. local sam invoke without env), auth is skipped
    and a warning is logged. Production deploys MUST set PANEL_API_KEY.
    """
    expected = os.environ.get("PANEL_API_KEY", "").strip()
    if not expected:
        # Dev mode — skip auth but log so it's visible in CloudWatch
        print("WARN: PANEL_API_KEY not set, skipping auth (dev mode only)")
        return

    headers = event.get("headers") or {}
    # API Gateway HTTP API v2 lowercases header keys
    provided = headers.get("x-api-key") or headers.get("X-Api-Key") or ""
    if not provided or provided != expected:
        raise Unauthorized("invalid or missing x-api-key")


def extract_creds(body: dict[str, Any]) -> Creds:
    creds = body.get("credentials")
    if not isinstance(creds, dict):
        raise BadRequest("missing 'credentials' object in body")

    ak = creds.get("access_key") or creds.get("accessKey")
    sk = creds.get("secret_key") or creds.get("secretKey")
    token = creds.get("session_token") or creds.get("sessionToken")

    if not isinstance(ak, str) or not ak.startswith(("AKIA", "ASIA")) or len(ak) < 16:
        raise BadRequest("invalid access_key format")
    if not isinstance(sk, str) or len(sk) < 20:
        raise BadRequest("invalid secret_key format")
    if token is not None and not isinstance(token, str):
        raise BadRequest("session_token must be a string if provided")

    return Creds(access_key=ak, secret_key=sk, session_token=token)
