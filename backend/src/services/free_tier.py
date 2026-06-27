"""
Free Tier API — primarily for the new (post 2025-07) $200 credit plans.

`get_account_plan_state` is the most useful call: returns the plan type,
expiration, and remaining credit balance. `get_free_tier_usage` lists
each offer's usage versus its limit (e.g. EC2 t2.micro 750 hr/mo) but
isn't really the "remaining $200" view.

Like Cost Explorer, the Free Tier API is global — always us-east-1.
"""

from __future__ import annotations

from typing import Any

from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.shared.errors import BadRequest, UpstreamError

_FT_REGION = "us-east-1"


def get_account_plan_state(creds: Creds) -> dict[str, Any]:
    """
    Return the Free Tier plan state with remaining credit balance.

    Response shape:
      {
        "account_id": "876611282625",
        "plan_type": "PAID" | "FREE" | "UNKNOWN",
        "status":    "ACTIVE" | "EXPIRED" | "NOT_STARTED" | "UNKNOWN",
        "expiration_date": "2026-07-15T00:00:00+00:00" | null,
        "remaining_credits": {"amount": 175.50, "unit": "USD"} | null,
      }

    Older accounts (pre 2025-07) don't have a credit-based plan; the
    response may report status `NOT_STARTED` with null credits.
    """
    ft = get_client(creds, "freetier", _FT_REGION)
    try:
        resp = ft.get_account_plan_state()
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in {"AccessDeniedException", "UnauthorizedOperation"}:
            raise BadRequest("无权访问 Free Tier API") from e
        if code in {"ResourceNotFoundException"}:
            # Account doesn't have a free-tier plan attached (older or org-managed)
            return {
                "account_id": None,
                "plan_type": "UNKNOWN",
                "status": "NOT_STARTED",
                "expiration_date": None,
                "remaining_credits": None,
                "note": "该账号无 Free Tier 计划记录 (可能是老账号或组织成员)",
            }
        raise UpstreamError(f"get_account_plan_state failed: {code} - {msg}") from e

    expiration = resp.get("accountPlanExpirationDate")
    if expiration is not None and not isinstance(expiration, str):
        expiration = expiration.isoformat()

    remaining = resp.get("accountPlanRemainingCredits")
    if remaining:
        remaining = {
            "amount": float(remaining.get("amount", 0)),
            "unit": remaining.get("unit", "USD"),
        }

    return {
        "account_id": resp.get("accountId"),
        "plan_type": resp.get("accountPlanType") or "UNKNOWN",
        "status": resp.get("accountPlanStatus") or "UNKNOWN",
        "expiration_date": expiration,
        "remaining_credits": remaining,
    }


def get_free_tier_usage(creds: Creds) -> dict[str, Any]:
    """
    Return per-offer Free Tier usage (EC2 hours, EBS GB-Mo, etc.).

    Most useful for legacy 12-month Free Tier accounts (pre 2025-07).
    New credit-based accounts mostly care about `get_account_plan_state`.
    """
    ft = get_client(creds, "freetier", _FT_REGION)
    try:
        resp = ft.get_free_tier_usage()
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in {"AccessDeniedException", "UnauthorizedOperation"}:
            raise BadRequest("无权访问 Free Tier API") from e
        raise UpstreamError(f"get_free_tier_usage failed: {code} - {msg}") from e

    offers: list[dict[str, Any]] = []
    for u in resp.get("freeTierUsages", []):
        offers.append(
            {
                "service": u.get("service"),
                "operation": u.get("operation"),
                "usage_type": u.get("usageType"),
                "region": u.get("region"),
                "actual": float(u.get("actualUsageAmount", 0)),
                "forecasted": float(u.get("forecastedUsageAmount", 0)),
                "limit": float(u.get("limit", 0)),
                "unit": u.get("unit"),
                "description": u.get("description"),
                "tier_type": u.get("freeTierType"),
            }
        )
    return {"offers": offers}
