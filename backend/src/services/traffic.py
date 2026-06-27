"""
EC2 instance network traffic query — backed by CloudWatch metrics.

We pull `NetworkIn` and `NetworkOut` from the AWS/EC2 namespace with the
Sum statistic, which gives per-period total bytes. The choice of period
is auto-tuned to the requested range so the response is bounded:

  range ≤ 1 day  →  300 s   (5 min buckets)
  ≤ 30 days      →  3600 s  (1 hour buckets)
  > 30 days      →  86400 s (1 day buckets)

We then re-bucket the raw datapoints into calendar-day rows for the UI
table, while reporting the total bytes for the entire range.

CloudWatch retention reminder:
  period < 60 s  → 3 h
  ≥ 60 s         → 15 days  (only datapoints with 1 min granularity)
  ≥ 300 s        → 63 days
  ≥ 3600 s       → 455 days
So 86400 s period works for queries up to ~15 months; older data falls
off and the response will simply be missing those days.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.shared.errors import BadRequest, UpstreamError


def _parse_iso(value: str, name: str) -> datetime:
    try:
        # Accept 'Z' suffix and naive ISO; force UTC if no tzinfo.
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
    instance_id: str,
    metric: str,
    start: datetime,
    end: datetime,
    period: int,
) -> list[dict[str, Any]]:
    cw = get_client(creds, "cloudwatch", region)
    try:
        resp = cw.get_metric_statistics(
            Namespace="AWS/EC2",
            MetricName=metric,
            Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
            StartTime=start,
            EndTime=end,
            Period=period,
            Statistics=["Sum"],
            Unit="Bytes",
        )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        raise UpstreamError(f"get_metric_statistics({metric}) failed: {code}") from e
    return resp.get("Datapoints", [])


def query_instance_traffic(
    creds: Creds,
    region: str,
    instance_id: str,
    start: str,
    end: str,
) -> dict[str, Any]:
    """Return network traffic for `instance_id` between `start` and `end` (ISO)."""
    start_dt = _parse_iso(start, "start")
    end_dt = _parse_iso(end, "end")
    if end_dt <= start_dt:
        raise BadRequest("'end' must be after 'start'")
    # Cap absurdly long ranges that would balloon the response — 455 days max.
    if (end_dt - start_dt) > timedelta(days=455):
        raise BadRequest("查询时间跨度过长 (最长 455 天)")

    period = _choose_period(start_dt, end_dt)

    in_points = _fetch_metric(creds, region, instance_id, "NetworkIn", start_dt, end_dt, period)
    out_points = _fetch_metric(creds, region, instance_id, "NetworkOut", start_dt, end_dt, period)

    # Bucket each datapoint by its UTC calendar day.
    daily: dict[str, dict[str, float]] = {}

    def _accumulate(points: list[dict[str, Any]], key: str) -> None:
        for p in points:
            day = p["Timestamp"].astimezone(timezone.utc).date().isoformat()
            slot = daily.setdefault(day, {"in_bytes": 0.0, "out_bytes": 0.0})
            slot[key] += float(p.get("Sum") or 0)

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
