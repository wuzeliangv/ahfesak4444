"""Quick error-path verification — exercises the validation/auth layer."""

from __future__ import annotations

import json
import os
import sys

os.environ["PANEL_API_KEY"] = "secret-key-test"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.handlers.api import handler  # noqa: E402


def call(method: str, path: str, body=None, api_key: str | None = "secret-key-test"):
    headers = {"content-type": "application/json"}
    if api_key is not None:
        headers["x-api-key"] = api_key
    event = {
        "version": "2.0",
        "rawPath": path,
        "headers": headers,
        "requestContext": {
            "http": {"method": method, "path": path, "sourceIp": "127.0.0.1"},
            "requestId": "err-test",
        },
        "body": json.dumps(body) if body else None,
        "isBase64Encoded": False,
    }
    resp = handler(event, None)
    return resp["statusCode"], json.loads(resp["body"]) if resp.get("body") else {}


cases = [
    # (label, expected_status, expected_code, args, kwargs)
    ("unknown route",        404, "NotFound",          ("GET",  "/nope")),
    ("missing api key",      401, "Unauthorized",      ("POST", "/accounts/verify", {"credentials": {"access_key": "AKIA" + "X"*16, "secret_key": "x"*40}}, None)),
    ("wrong api key",        401, "Unauthorized",      ("POST", "/accounts/verify", {"credentials": {"access_key": "AKIA" + "X"*16, "secret_key": "x"*40}}, "wrong")),
    ("malformed json",       400, "BadRequest",        ("POST", "/accounts/verify", "not-a-dict")),
    ("missing creds field",  400, "BadRequest",        ("POST", "/accounts/verify", {})),
    ("bad AK format",        400, "BadRequest",        ("POST", "/accounts/verify", {"credentials": {"access_key": "garbage", "secret_key": "x"*40}})),
    ("missing region",       400, "BadRequest",        ("POST", "/quota/region", {"credentials": {"access_key": "AKIA" + "X"*16, "secret_key": "x"*40}})),
    ("bad instance_id",      400, "BadRequest",        ("POST", "/ec2/start", {"credentials": {"access_key": "AKIA" + "X"*16, "secret_key": "x"*40}, "region": "us-east-1", "instance_id": "wrong"})),
    ("CORS preflight",       204, None,                ("OPTIONS", "/anything")),
]

failures = 0
for label, want_status, want_code, args in cases:
    args = list(args)
    if len(args) == 2:
        args.append(None)
    if len(args) == 3:
        args.append("secret-key-test")
    method, path, body, api_key = args
    # special-case malformed: pass raw string as body
    if body == "not-a-dict":
        # craft an event manually with raw non-JSON body
        event = {
            "version": "2.0",
            "rawPath": path,
            "headers": {"content-type": "application/json", "x-api-key": api_key or ""},
            "requestContext": {"http": {"method": method, "path": path}, "requestId": "x"},
            "body": "not json {{{",
            "isBase64Encoded": False,
        }
        resp = handler(event, None)
        status = resp["statusCode"]
        parsed = json.loads(resp["body"]) if resp.get("body") else {}
    else:
        status, parsed = call(method, path, body, api_key)

    got_code = parsed.get("error", {}).get("code") if not parsed.get("ok", True) else None
    ok_status = status == want_status
    ok_code = (want_code is None) or (got_code == want_code)
    flag = "PASS" if ok_status and ok_code else "FAIL"
    if not (ok_status and ok_code):
        failures += 1
    print(f"  [{flag}] {label:25s} want=({want_status},{want_code})  got=({status},{got_code})")

print()
if failures:
    print(f"{failures} failure(s)")
    sys.exit(1)
print("All error-path tests passed")
