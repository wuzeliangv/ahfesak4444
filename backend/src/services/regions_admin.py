"""
Account-level region management — list all regions with opt-in status,
enable / disable opt-in regions.

The `account` SDK lives in us-east-1 only (it's a global service surfaced
through one endpoint). Permissions needed:
    account:ListRegions
    account:GetRegionOptStatus
    account:EnableRegion
    account:DisableRegion

Opt-in status values from AWS:
    ENABLED              – default-on region; can't be disabled
    ENABLED_BY_DEFAULT   – always-on for the account
    DISABLED             – opt-in region not enabled
    ENABLING             – enable in progress (takes minutes to hours)
    DISABLING            – disable in progress
"""

from __future__ import annotations

from typing import Any

from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.shared.errors import BadRequest, UpstreamError

_ACCOUNT_REGION = "us-east-1"

# Opt-in statuses that the user may want to flip via the UI.
_FLIPPABLE_STATUSES = {"ENABLED", "DISABLED", "ENABLING", "DISABLING"}


def list_all_regions(creds: Creds) -> dict[str, Any]:
    """List every AWS region the account knows about, with opt-in status.

    Response shape:
      {
        "regions": [
          {"region": "us-east-1", "status": "ENABLED_BY_DEFAULT", "opt_in_required": false},
          {"region": "ap-east-1", "status": "DISABLED",           "opt_in_required": true},
          ...
        ]
      }
    """
    acct = get_client(creds, "account", _ACCOUNT_REGION)

    regions: list[dict[str, Any]] = []
    next_token: str | None = None
    try:
        while True:
            params: dict[str, Any] = {"MaxResults": 50}
            if next_token:
                params["NextToken"] = next_token
            resp = acct.list_regions(**params)
            for r in resp.get("Regions", []):
                status = r.get("RegionOptStatus", "UNKNOWN")
                regions.append(
                    {
                        "region": r.get("RegionName"),
                        "status": status,
                        "opt_in_required": status in _FLIPPABLE_STATUSES,
                    }
                )
            next_token = resp.get("NextToken")
            if not next_token:
                break
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in {"AccessDeniedException", "UnauthorizedOperation"}:
            raise BadRequest(
                "无权访问 account:ListRegions (需要 AdministratorAccess 或 IAMFullAccess)"
            ) from e
        raise UpstreamError(f"list_regions failed: {code} - {msg}") from e

    regions.sort(key=lambda x: x["region"] or "")
    return {"regions": regions}


def enable_region(creds: Creds, region_name: str) -> dict[str, Any]:
    """Opt the account into `region_name`. Returns the new status.

    Enabling is asynchronous — status will be ENABLING for minutes to hours
    before flipping to ENABLED. Calling again while ENABLING is a no-op.
    """
    if not region_name or not isinstance(region_name, str):
        raise BadRequest("missing 'region_name' string")

    acct = get_client(creds, "account", _ACCOUNT_REGION)
    try:
        acct.enable_region(RegionName=region_name)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in {"ConflictException"}:
            # Region already enabled or in an unexpected state — fetch the
            # current status so the UI knows.
            pass
        elif code in {"ValidationException"}:
            raise BadRequest(f"区域名无效: {region_name}") from e
        elif code in {"AccessDeniedException"}:
            raise BadRequest("无权启用区域 (需要 account:EnableRegion)") from e
        else:
            raise UpstreamError(f"enable_region failed: {code} - {msg}") from e

    # Re-read status to give the UI an authoritative answer.
    try:
        status_resp = acct.get_region_opt_status(RegionName=region_name)
        status = status_resp.get("RegionOptStatus", "ENABLING")
    except ClientError:
        status = "ENABLING"

    return {"region": region_name, "status": status}


def disable_region(creds: Creds, region_name: str) -> dict[str, Any]:
    """Opt the account out of `region_name`. Returns the new status."""
    if not region_name or not isinstance(region_name, str):
        raise BadRequest("missing 'region_name' string")

    acct = get_client(creds, "account", _ACCOUNT_REGION)
    try:
        acct.disable_region(RegionName=region_name)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in {"ConflictException"}:
            pass
        elif code in {"ValidationException"}:
            raise BadRequest(f"区域名无效或不支持禁用: {region_name}") from e
        elif code in {"AccessDeniedException"}:
            raise BadRequest("无权禁用区域 (需要 account:DisableRegion)") from e
        else:
            raise UpstreamError(f"disable_region failed: {code} - {msg}") from e

    try:
        status_resp = acct.get_region_opt_status(RegionName=region_name)
        status = status_resp.get("RegionOptStatus", "DISABLING")
    except ClientError:
        status = "DISABLING"

    return {"region": region_name, "status": status}
