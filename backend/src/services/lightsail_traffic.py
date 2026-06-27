"""
Lightsail instance network traffic query.

Lightsail exposes per-instance metrics via its OWN API
(`get_instance_metric_data`) rather than CloudWatch. The semantics and
data shape mirror what we did for EC2 in `services/traffic.py` so the
frontend can present them identically, but the SDK call is different:

  - Metric names: `NetworkIn`, `NetworkOut` (same as CloudWatch)
  - Statistic: `Sum` (per-period total bytes)
  - Unit: `Bytes`
  - Period: 60..86400, must be a multiple of 60

Period auto-selection matches the EC2 module so the daily-rollup logic on
the frontend stays the same:
  range ≤ 1 day  →  300 s   (5 min)
  ≤ 30 days      →  3600 s  (1 hour)
  > 30 days      →  86400 s (1 day)

Retention is comparable to CloudWatch — the longest-bucket period (86400)
covers ~15 months. Older data simply isn't returned.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.shared.errors import BadRequest, UpstreamError


def _parse_iso(value: str, name: str) -> datetime:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as e:
        raise BadRequest(f"'{name}' must be an ISO-8601 timestamp") from e
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _choose_period(start: datetime, end: datetime) -> int:
    span = end - start
    days = span.total_seconds() / 86400
    if days <= 1.5:
        return 300
    if days <= 31:
        return 3600
    return 86400


def _fetch_metric(
    creds: Creds,
    region: str,
    instance_name: str,
    metric: str,
    start: datetime,
    end: datetime,
    period: int,
) -> list[dict[str, Any]]:
    ls = get_client(creds, "lightsail", region)
    try:
        resp = ls.get_instance_metric_data(
            instanceName=instance_name,
            metricName=metric,
            period=period,
            startTime=start,
            endTime=end,
            unit="Bytes",
            statistics=["Sum"],
        )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        if code in {"NotFoundException", "DoesNotExist"}:
            raise BadRequest(f"lightsail instance {instance_name} not found") from e
        raise UpstreamError(f"get_instance_metric_data({metric}) failed: {code}") from e
    return resp.get("metricData") or []


def query_instance_traffic(
    creds: Creds,
    region: str,
    instance_name: str,
    start: str,
    end: str,
) -> dict[str, Any]:
    """Return network traffic for `instance_name` between `start` and `end`."""
    start_dt = _parse_iso(start, "start")
    end_dt = _parse_iso(end, "end")
    if end_dt <= start_dt:
        raise BadRequest("'end' must be after 'start'")
    if (end_dt - start_dt) > timedelta(days=455):
        raise BadRequest("查询时间跨度过长 (最长 455 天)")

    period = _choose_period(start_dt, end_dt)

    in_points = _fetch_metric(
        creds, region, instance_name, "NetworkIn", start_dt, end_dt, period
    )
    out_points = _fetch_metric(
        creds, region, instance_name, "NetworkOut", start_dt, end_dt, period
    )

    # Lightsail returns the Sum under the lowercase 'sum' key (vs CloudWatch's
    # 'Sum'); aside from that, bucketing is identical.
    daily: dict[str, dict[str, float]] = {}

    def _accumulate(points: list[dict[str, Any]], key: str) -> None:
        for p in points:
            ts = p.get("timestamp")
            if ts is None:
                continue
            day = ts.astimezone(timezone.utc).date().isoformat()
            slot = daily.setdefault(day, {"in_bytes": 0.0, "out_bytes": 0.0})
            slot[key] += float(p.get("sum") or 0)

    _accumulate(in_points, "in_bytes")
    _accumulate(out_points, "out_bytes")

    rows = sorted(
        (
            {
                "date": day,
                "in_bytes": int(slot["in_bytes"]),
                "out_bytes": int(slot["out_bytes"]),
            }
            for day, slot in daily.items()
        ),
        key=lambda r: r["date"],
    )

    total_in = sum(r["in_bytes"] for r in rows)
    total_out = sum(r["out_bytes"] for r in rows)

    return {
        "start": start_dt.isoformat(),
        "end": end_dt.isoformat(),
        "period_seconds": period,
        "in_bytes": total_in,
        "out_bytes": total_out,
        "total_bytes": total_in + total_out,
        "daily": rows,
    }
