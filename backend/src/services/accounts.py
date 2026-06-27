"""
Account service — verify credentials and fetch identity metadata.

The 'verify' endpoint is what the frontend hits when adding a new account
card. It must:
  1. Confirm the AK/SK actually work (sts.get_caller_identity)
  2. Return useful display metadata (account id, ARN, alias, is-root flag)

We deliberately swallow IAM permission errors: many restricted users won't
have iam:ListAccountAliases, and that's fine — alias is optional polish.
"""

from __future__ import annotations

import csv
import io
import time
from typing import Any

from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.shared.errors import InvalidCredentials, UpstreamError

# Errors AWS returns when AK/SK are bad
_CRED_ERROR_CODES = frozenset(
    {
        "InvalidClientTokenId",
        "SignatureDoesNotMatch",
        "AuthFailure",
        "UnrecognizedClientException",
        "ExpiredToken",
        "TokenRefreshRequired",
    }
)


def _classify(e: ClientError, action: str) -> Exception:
    code = e.response.get("Error", {}).get("Code", "Unknown")
    message = e.response.get("Error", {}).get("Message", str(e))
    if code in _CRED_ERROR_CODES:
        return InvalidCredentials(f"AWS rejected credentials on {action}: {code}")
    return UpstreamError(f"{action} failed: {code} - {message}")


def _registered_country(creds: Creds) -> str | None:
    """ISO-3166 country code from the account's primary contact address.

    Uses the Account Management API (account:GetContactInformation). For a
    standalone account we call it with no AccountId, using the account's own
    credentials. Best-effort: many restricted IAM users lack the permission,
    so any failure just yields None.
    """
    try:
        acct = get_client(creds, "account", "us-east-1")
        info = acct.get_contact_information().get("ContactInformation", {})
        cc = info.get("CountryCode")
        return cc or None
    except ClientError:
        return None
    except Exception:  # noqa: BLE001 — never let optional polish break verify
        return None


def _account_created_at(creds: Creds) -> str | None:
    """Account creation time, taken from the IAM credential report.

    The report has a row for ``<root_account>`` whose ``user_creation_time``
    equals when the AWS account was opened. The report is generated
    asynchronously (and cached ~4h), so we poll generate() until COMPLETE
    before downloading. Best-effort: returns None on any failure.
    """
    try:
        iam = get_client(creds, "iam", "us-east-1")

        # Usually already COMPLETE (cached); only first/stale needs polling.
        for _ in range(8):
            state = iam.generate_credential_report().get("State")
            if state == "COMPLETE":
                break
            time.sleep(1)

        content = iam.get_credential_report()["Content"].decode("utf-8")
        for row in csv.DictReader(io.StringIO(content)):
            if row.get("user") == "<root_account>":
                t = row.get("user_creation_time")
                return t if t and t not in ("N/A", "not_supported") else None
    except ClientError:
        return None
    except Exception:  # noqa: BLE001
        return None
    return None


def verify(creds: Creds) -> dict[str, Any]:
    """Validate AK/SK, return identity + display metadata."""
    sts = get_client(creds, "sts", "us-east-1")

    try:
        ident = sts.get_caller_identity()
    except ClientError as e:
        raise _classify(e, "sts.get_caller_identity") from e

    arn: str = ident["Arn"]
    account_id: str = ident["Account"]
    user_id: str = ident["UserId"]

    is_root = arn.endswith(":root")

    # Best-effort alias lookup — not all credentials have iam:ListAccountAliases
    alias: str | None = None
    try:
        iam = get_client(creds, "iam", "us-east-1")
        resp = iam.list_account_aliases()
        aliases = resp.get("AccountAliases", [])
        if aliases:
            alias = aliases[0]
    except ClientError:
        # Restricted IAM user without iam:ListAccountAliases — silently skip
        pass

    # Optional polish — registered country + account age. Both degrade to None
    # when the credentials lack permission, so they never block verification.
    country_code = _registered_country(creds)
    created_at = _account_created_at(creds)

    return {
        "account_id": account_id,
        "arn": arn,
        "user_id": user_id,
        "alias": alias,
        "is_root": is_root,
        "ak_prefix": creds.access_key[:8],
        "country_code": country_code,
        "created_at": created_at,
    }
