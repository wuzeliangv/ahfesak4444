"""
Direct-invoke harness — exercises the Lambda handler without Docker.

Constructs synthetic API Gateway HTTP API v2 events and feeds them to
src.handlers.api.handler. Because the handler doesn't depend on any
Lambda-runtime-specific feature, this is functionally identical to
`sam local invoke` for correctness verification.

Usage:
    AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
        uv run python scripts/invoke_local.py <route>

Routes:
    health
    verify
    quota-region [region]
    quota-all
    ec2-list
    ec2-list-region [region]

API key (PANEL_API_KEY) is set automatically for this harness.
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any

# Set the API key BEFORE importing the handler so its module-level checks pass
os.environ.setdefault("PANEL_API_KEY", "local-dev-key-1234567890abcdef")

# Make src/ importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.handlers.api import handler  # noqa: E402


def _creds_from_env() -> dict[str, str]:
    ak = os.environ.get("AWS_ACCESS_KEY_ID")
    sk = os.environ.get("AWS_SECRET_ACCESS_KEY")
    if not ak or not sk:
        raise SystemExit(
            "ERROR: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY before running"
        )
    return {"access_key": ak, "secret_key": sk}


def _make_event(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "version": "2.0",
        "routeKey": f"{method} {path}",
        "rawPath": path,
        "rawQueryString": "",
        "headers": {
            "content-type": "application/json",
            "x-api-key": os.environ["PANEL_API_KEY"],
            "user-agent": "invoke-local-harness",
        },
        "requestContext": {
            "http": {
                "method": method,
                "path": path,
                "sourceIp": "127.0.0.1",
                "userAgent": "invoke-local-harness",
            },
            "requestId": f"local-{int(time.time() * 1000)}",
        },
        "body": json.dumps(body) if body is not None else None,
        "isBase64Encoded": False,
    }


def call(method: str, path: str, body: dict[str, Any] | None = None) -> None:
    label = f"{method} {path}"
    event = _make_event(method, path, body)

    started = time.perf_counter()
    response = handler(event, None)
    elapsed_ms = (time.perf_counter() - started) * 1000

    status = response["statusCode"]
    parsed = json.loads(response["body"]) if response.get("body") else {}

    print(f"\n{'=' * 70}")
    print(f"{label}  →  HTTP {status}  ({elapsed_ms:.0f} ms)")
    print("=" * 70)
    print(json.dumps(parsed, indent=2, default=str)[:4000])


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    route, *args = sys.argv[1:]

    if route == "health":
        call("GET", "/health")
        return

    creds = _creds_from_env()

    if route == "verify":
        call("POST", "/accounts/verify", {"credentials": creds})
    elif route == "quota-region":
        region = args[0] if args else "us-east-1"
        call("POST", "/quota/region", {"credentials": creds, "region": region})
    elif route == "quota-all":
        call("POST", "/quota/all-regions", {"credentials": creds})
    elif route == "ec2-list":
        call("POST", "/ec2/list", {"credentials": creds})
    elif route == "ec2-list-region":
        region = args[0] if args else "us-east-1"
        call("POST", "/ec2/list-region", {"credentials": creds, "region": region})
    elif route == "all":
        # Run the whole suite end-to-end
        call("GET", "/health")
        call("POST", "/accounts/verify", {"credentials": creds})
        call("POST", "/quota/region", {"credentials": creds, "region": "us-east-1"})
        call("POST", "/quota/all-regions", {"credentials": creds})
        call("POST", "/ec2/list", {"credentials": creds})
    else:
        print(f"unknown route: {route}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
