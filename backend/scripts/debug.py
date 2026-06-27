"""
Local debug script — tests boto3 calls without going through Lambda/SAM.

Usage:
    cd backend
    uv run python scripts/debug.py whoami           # sts get-caller-identity
    uv run python scripts/debug.py ec2 us-east-1    # list EC2 in one region
    uv run python scripts/debug.py ec2-all          # list EC2 across all regions (concurrent)
    uv run python scripts/debug.py quota us-east-1  # vCPU running on-demand quota

Pass credentials via env vars or ~/.aws/credentials.
For one-off testing without writing to disk:
    AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... uv run python scripts/debug.py whoami
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

import aioboto3
import boto3
from botocore.config import Config

CFG = Config(retries={"max_attempts": 2, "mode": "standard"}, connect_timeout=3, read_timeout=10)


def whoami() -> dict[str, Any]:
    sts = boto3.client("sts", config=CFG)
    return sts.get_caller_identity()


def list_ec2(region: str) -> list[dict[str, Any]]:
    ec2 = boto3.client("ec2", region_name=region, config=CFG)
    out: list[dict[str, Any]] = []
    for page in ec2.get_paginator("describe_instances").paginate():
        for r in page["Reservations"]:
            for i in r["Instances"]:
                out.append(
                    {
                        "id": i["InstanceId"],
                        "type": i["InstanceType"],
                        "state": i["State"]["Name"],
                        "public_ip": i.get("PublicIpAddress"),
                        "private_ip": i.get("PrivateIpAddress"),
                        "region": region,
                    }
                )
    return out


def get_vcpu_quota(region: str) -> dict[str, Any]:
    """Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances vCPU quota."""
    sq = boto3.client("service-quotas", region_name=region, config=CFG)
    # L-1216C47A = Running On-Demand Standard instances
    resp = sq.get_service_quota(ServiceCode="ec2", QuotaCode="L-1216C47A")
    q = resp["Quota"]
    return {"region": region, "name": q["QuotaName"], "value": q["Value"]}


async def list_ec2_all_regions() -> list[dict[str, Any]]:
    """Concurrent EC2 list across every opted-in region — proves the Lambda pattern works."""
    session = aioboto3.Session()
    async with session.client("ec2", region_name="us-east-1", config=CFG) as ec2:
        regions_resp = await ec2.describe_regions(AllRegions=False)
    regions = [r["RegionName"] for r in regions_resp["Regions"]]
    print(f"  scanning {len(regions)} regions concurrently...", file=sys.stderr)

    async def one(r: str) -> list[dict[str, Any]]:
        try:
            async with session.client("ec2", region_name=r, config=CFG) as c:
                paginator = c.get_paginator("describe_instances")
                rows: list[dict[str, Any]] = []
                async for page in paginator.paginate():
                    for resv in page["Reservations"]:
                        for i in resv["Instances"]:
                            rows.append(
                                {
                                    "id": i["InstanceId"],
                                    "type": i["InstanceType"],
                                    "state": i["State"]["Name"],
                                    "public_ip": i.get("PublicIpAddress"),
                                    "region": r,
                                }
                            )
                return rows
        except Exception as e:  # opt-in regions, expired creds, etc.
            print(f"  [{r}] skipped: {type(e).__name__}", file=sys.stderr)
            return []

    results = await asyncio.gather(*(one(r) for r in regions))
    return [row for sub in results for row in sub]


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd, *args = sys.argv[1:]

    if cmd == "whoami":
        print(json.dumps(whoami(), indent=2, default=str))
    elif cmd == "ec2":
        region = args[0] if args else "us-east-1"
        print(json.dumps(list_ec2(region), indent=2, default=str))
    elif cmd == "ec2-all":
        rows = asyncio.run(list_ec2_all_regions())
        print(json.dumps(rows, indent=2, default=str))
        print(f"\n  total: {len(rows)} instances", file=sys.stderr)
    elif cmd == "quota":
        region = args[0] if args else "us-east-1"
        print(json.dumps(get_vcpu_quota(region), indent=2, default=str))
    else:
        print(f"unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
