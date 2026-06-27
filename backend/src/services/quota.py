"""
Service Quotas — vCPU limits for the account card UI.

Frontend card shows:
  - Big number  = us-east-1 vCPU quota for Standard on-demand
  - Ball icon   = vCPU quotas across all opted-in regions

L-1216C47A is the Service Quota code for "Running On-Demand Standard
(A, C, D, H, I, M, R, T, Z) instances" — this matches what the screenshot
labels as 'vCPU'. Other quota codes (GPU/HPC families) can be added later.
"""

from __future__ import annotations

import asyncio
from typing import Any

import aioboto3
from botocore.config import Config
from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.shared.errors import UpstreamError
from src.shared.regions import list_opted_in_regions

# Standard on-demand vCPU quota — what the card displays
STANDARD_VCPU_QUOTA = "L-1216C47A"

# All-Standard Spot Instance Requests vCPU quota
SPOT_VCPU_QUOTA = "L-34B43A08"

# Async client config — shorter timeouts since we fan out across many regions
_ASYNC_CFG = Config(
    retries={"max_attempts": 2, "mode": "standard"},
    connect_timeout=3,
    read_timeout=8,
)


def get_vcpu_quota(creds: Creds, region: str, quota_code: str = STANDARD_VCPU_QUOTA) -> dict[str, Any]:
    """Fetch a single region's vCPU quota. Synchronous — used by single-region UI calls."""
    sq = get_client(creds, "service-quotas", region)
    try:
        resp = sq.get_service_quota(ServiceCode="ec2", QuotaCode=quota_code)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        # NoSuchResourceException = quota not applicable in this region
        if code == "NoSuchResourceException":
            return {"region": region, "quota_code": quota_code, "value": None, "name": None}
        raise UpstreamError(f"get_service_quota failed in {region}: {code}") from e

    q = resp["Quota"]
    return {
        "region": region,
        "quota_code": quota_code,
        "value": q["Value"],
        "name": q["QuotaName"],
        "adjustable": q.get("Adjustable", False),
    }


def _instance_vcpus(inst: dict[str, Any]) -> int:
    """vCPUs of an instance = CoreCount * ThreadsPerCore (from CpuOptions)."""
    cpu = inst.get("CpuOptions") or {}
    cores = cpu.get("CoreCount") or 0
    threads = cpu.get("ThreadsPerCore") or 1
    return int(cores) * int(threads)


# Standard instance families (A,C,D,H,I,M,R,T,Z) — these count toward the
# Standard On-Demand / Spot vCPU quotas we display.
_STANDARD_FAMILY_FIRST = set("acdhimrtz")


def _is_standard_family(instance_type: str) -> bool:
    fam = (instance_type or "").split(".")[0]
    return bool(fam) and fam[0] in _STANDARD_FAMILY_FIRST


async def _fetch_usage(
    session: aioboto3.Session,
    creds: Creds,
    region: str,
) -> tuple[int | None, int | None]:
    """Running+pending Standard vCPUs in a region, split into (on-demand, spot).

    Used / total then gives the headroom shown in the card UI. Best-effort:
    returns (None, None) if the region is disabled or DescribeInstances is denied.
    """
    try:
        async with session.client(
            "ec2",
            region_name=region,
            aws_access_key_id=creds.access_key,
            aws_secret_access_key=creds.secret_key,
            aws_session_token=creds.session_token,
            config=_ASYNC_CFG,
        ) as ec2:
            used_od = 0
            used_spot = 0
            paginator = ec2.get_paginator("describe_instances")
            async for page in paginator.paginate(
                Filters=[{"Name": "instance-state-name", "Values": ["running", "pending"]}]
            ):
                for res in page.get("Reservations", []):
                    for inst in res.get("Instances", []):
                        if not _is_standard_family(inst.get("InstanceType", "")):
                            continue
                        v = _instance_vcpus(inst)
                        if inst.get("InstanceLifecycle") == "spot":
                            used_spot += v
                        else:
                            used_od += v
            return used_od, used_spot
    except Exception:  # noqa: BLE001 — region disabled / no permission / blip
        return None, None


async def _fetch_one(
    session: aioboto3.Session,
    creds: Creds,
    region: str,
    od_code: str,
    spot_code: str,
) -> dict[str, Any]:
    """One region's On-Demand + Spot vCPU quota totals AND live usage."""

    async def _quotas() -> tuple[float | None, float | None]:
        async def _q(sq: Any, code: str) -> float | None:
            try:
                resp = await sq.get_service_quota(ServiceCode="ec2", QuotaCode=code)
                return resp["Quota"]["Value"]
            except ClientError:
                # NoSuchResourceException / quota-level error → unknown
                return None

        try:
            async with session.client(
                "service-quotas",
                region_name=region,
                aws_access_key_id=creds.access_key,
                aws_secret_access_key=creds.secret_key,
                aws_session_token=creds.session_token,
                config=_ASYNC_CFG,
            ) as sq:
                return await asyncio.gather(_q(sq, od_code), _q(sq, spot_code))
        except Exception:  # noqa: BLE001
            return None, None

    (value, spot), (used_od, used_spot) = await asyncio.gather(
        _quotas(), _fetch_usage(session, creds, region)
    )
    return {
        "region": region,
        "value": value,
        "spot": spot,
        "used": used_od,
        "used_spot": used_spot,
        "ok": value is not None or spot is not None,
    }


async def _all_regions_async(
    creds: Creds,
    od_code: str,
    spot_code: str,
    regions: list[str] | None,
) -> list[dict[str, Any]]:
    if regions is None:
        # list_opted_in_regions is sync but cheap — and cached in execution env
        regions = list_opted_in_regions(creds)
    session = aioboto3.Session()
    results = await asyncio.gather(
        *(_fetch_one(session, creds, r, od_code, spot_code) for r in regions)
    )
    return sorted(results, key=lambda x: x["region"])


def get_region_quota_detail(
    creds: Creds,
    region: str,
    quota_code: str = STANDARD_VCPU_QUOTA,
) -> dict[str, Any]:
    """One region's rich On-Demand + Spot vCPU quota totals + live usage.

    Same per-region shape as a row of get_vcpu_quota_all_regions — exposed as a
    single-region call so the frontend can fan out across regions through the
    per-region worker nodes (each region egresses from its own node IP).
    """

    async def _run() -> dict[str, Any]:
        session = aioboto3.Session()
        return await _fetch_one(session, creds, region, quota_code, SPOT_VCPU_QUOTA)

    return asyncio.run(_run())


def get_vcpu_quota_all_regions(
    creds: Creds,
    quota_code: str = STANDARD_VCPU_QUOTA,
    regions: list[str] | None = None,
) -> dict[str, Any]:
    """Fan out across all opted-in regions concurrently.

    Each region row carries On-Demand + Spot vCPU quota totals (``value`` /
    ``spot``) plus live usage (``used`` / ``used_spot``).
    """
    rows = asyncio.run(_all_regions_async(creds, quota_code, SPOT_VCPU_QUOTA, regions))

    # Summary stats for the card
    od = [r for r in rows if r.get("value") is not None]
    spot_rows = [r for r in rows if r.get("spot") is not None]
    total_vcpu = sum(r["value"] for r in od)
    total_spot = sum(r["spot"] for r in spot_rows)
    total_used = sum(r["used"] for r in rows if r.get("used") is not None)
    total_used_spot = sum(r["used_spot"] for r in rows if r.get("used_spot") is not None)
    max_region = max(od, key=lambda r: r["value"], default=None)

    return {
        "quota_code": quota_code,
        "spot_quota_code": SPOT_VCPU_QUOTA,
        "regions": rows,
        "summary": {
            "regions_scanned": len(rows),
            "regions_with_quota": len(od),
            "total_vcpu": total_vcpu,
            "total_spot": total_spot,
            "total_used": total_used,
            "total_used_spot": total_used_spot,
            "max_region": max_region["region"] if max_region else None,
            "max_value": max_region["value"] if max_region else None,
        },
    }
