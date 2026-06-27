"""
Cost Explorer queries — fetch a specific month's bill broken down by service.

Cost Explorer is a global service that lives in us-east-1; we always use
that region regardless of the user's "default region". The data lags by
24-48 hours, so current-month figures are estimates that settle later.

Permissions required: `ce:GetCostAndUsage` on the calling identity.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.shared.errors import BadRequest, UpstreamError

_CE_REGION = "us-east-1"


def _month_window(year: int, month: int) -> tuple[str, str]:
    """Return Cost Explorer's `[start, end)` window for one calendar month.

    Cost Explorer expects YYYY-MM-DD strings; `end` is exclusive."""
    if month < 1 or month > 12:
        raise BadRequest(f"invalid month: {month}")
    start = date(year, month, 1)
    end = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    return start.isoformat(), end.isoformat()


def _is_current_month(year: int, month: int) -> bool:
    today = date.today()
    return today.year == year and today.month == month


def get_monthly_cost(creds: Creds, year: int, month: int) -> dict[str, Any]:
    """
    Return cost for a specific calendar month, broken down by service.

    Response shape:
      {
        "year": int,
        "month": int,
        "start": "YYYY-MM-DD",
        "end":   "YYYY-MM-DD" (exclusive),
        "currency": "USD",
        "total": float,
        "services": [
          {"service": "Amazon Elastic Compute Cloud - Compute", "amount": 12.34},
          ...  sorted descending by amount
        ],
        "is_current_month": bool,
        "is_estimate": bool,         # true while month is still in progress
      }
    """
    start, end = _month_window(year, month)

    # For the current month, Cost Explorer needs `end` capped at tomorrow
    # (it rejects end > today + 1). For past months use the full window.
    current = _is_current_month(year, month)
    if current:
        end = (date.today() + timedelta(days=1)).isoformat()

    ce = get_client(creds, "ce", _CE_REGION)
    try:
        resp = ce.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in {"AccessDeniedException", "UnauthorizedOperation"}:
            raise BadRequest(
                "无权访问 Cost Explorer (需要 ce:GetCostAndUsage 权限)"
            ) from e
        if code in {"DataUnavailableException"}:
            return {
                "year": year,
                "month": month,
                "start": start,
                "end": end,
                "currency": "USD",
                "total": 0.0,
                "services": [],
                "is_current_month": current,
                "is_estimate": current,
                "note": "该月份无可用账单数据 (新账号或月份太久远)",
            }
        raise UpstreamError(f"get_cost_and_usage failed: {code} - {msg}") from e

    services: list[dict[str, Any]] = []
    currency = "USD"
    results = resp.get("ResultsByTime", [])
    if results:
        groups = results[0].get("Groups", [])
        for g in groups:
            keys = g.get("Keys", [])
            service_name = keys[0] if keys else "Unknown"
            metrics = g.get("Metrics", {}).get("UnblendedCost", {})
            amount_str = metrics.get("Amount", "0")
            currency = metrics.get("Unit", currency)
            try:
                amount = float(amount_str)
            except (TypeError, ValueError):
                amount = 0.0
            if amount > 0:
                services.append({"service": service_name, "amount": amount})

    services.sort(key=lambda x: x["amount"], reverse=True)
    total = sum(s["amount"] for s in services)

    return {
        "year": year,
        "month": month,
        "start": start,
        "end": end,
        "currency": currency,
        "total": round(total, 4),
        "services": [{"service": s["service"], "amount": round(s["amount"], 4)} for s in services],
        "is_current_month": current,
        "is_estimate": current,
    }


def get_recent_months_summary(creds: Creds, months: int = 6) -> dict[str, Any]:
    """Return the totals for the last `months` calendar months (oldest first).

    Useful as a trend overview without dragging in the per-service breakdown."""
    if months < 1 or months > 24:
        raise BadRequest("months must be between 1 and 24")

    today = date.today()
    end_excl = (date(today.year, today.month, 1) + timedelta(days=32)).replace(day=1)
    # Walk back `months` calendar months.
    start = end_excl
    for _ in range(months):
        if start.month == 1:
            start = date(start.year - 1, 12, 1)
        else:
            start = date(start.year, start.month - 1, 1)

    ce = get_client(creds, "ce", _CE_REGION)
    try:
        resp = ce.get_cost_and_usage(
            TimePeriod={"Start": start.isoformat(), "End": end_excl.isoformat()},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
        )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        if code in {"AccessDeniedException"}:
            raise BadRequest("无权访问 Cost Explorer") from e
        raise UpstreamError(f"get_cost_and_usage failed: {code}") from e

    rows: list[dict[str, Any]] = []
    for r in resp.get("ResultsByTime", []):
        period = r.get("TimePeriod", {})
        amount_str = r.get("Total", {}).get("UnblendedCost", {}).get("Amount", "0")
        try:
            amount = float(amount_str)
        except (TypeError, ValueError):
            amount = 0.0
        rows.append(
            {
                "start": period.get("Start"),
                "end": period.get("End"),
                "amount": round(amount, 4),
            }
        )

    return {"months": rows, "currency": "USD"}
