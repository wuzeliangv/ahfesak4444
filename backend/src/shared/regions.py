"""
Region utilities.

We cache the opted-in region list per-account in the Lambda execution environment.
The list rarely changes; refreshing once per warm container is enough.
"""

from __future__ import annotations

from typing import Any

from src.aws.clients import Creds, get_client

# us-east-1 is always available and is where we ask for "list me all regions".
_BOOTSTRAP_REGION = "us-east-1"

# Per-(account, ttl) cache. Real TTL is "lifetime of execution environment" —
# good enough since opt-in changes are rare.
_REGION_CACHE: dict[str, list[str]] = {}


def list_opted_in_regions(creds: Creds, refresh: bool = False) -> list[str]:
    """Return regions the account has opted into, plus always-on regions.

    Set `refresh=True` to bypass the per-execution-env cache (used after the
    user explicitly enables a new region in the AWS console).
    """
    cache_key = creds.cache_key
    if not refresh:
        cached = _REGION_CACHE.get(cache_key)
        if cached is not None:
            return cached

    ec2 = get_client(creds, "ec2", _BOOTSTRAP_REGION)
    # AllRegions=False filters to opted-in + always-on
    resp = ec2.describe_regions(AllRegions=False)
    regions = sorted(r["RegionName"] for r in resp["Regions"])
    _REGION_CACHE[cache_key] = regions
    return regions


def clear_region_cache() -> None:
    _REGION_CACHE.clear()
