"""
Per-region zone management — list Availability Zones, Local Zones, and
Wavelength Zones within one region, and opt into Local/Wavelength zone
groups.

Unlike opt-in Regions (handled by the `account` API in regions_admin.py),
zones live inside a region and are managed through EC2:

  - `ec2.describe_availability_zones(AllAvailabilityZones=True)` returns
    every zone in the region — including Local/Wavelength zones the
    account hasn't opted into yet — with ZoneType, GroupName, OptInStatus.
  - `ec2.modify_availability_zone_group(GroupName, OptInStatus='opted-in')`
    opts into a Local/Wavelength zone group.

IMPORTANT: AWS only allows opting IN via the API. The only valid
OptInStatus value is 'opted-in'; opting out requires contacting AWS
Support. So the UI exposes enable-only for Local/Wavelength zones.

OptInStatus values:
    opted-in            – zone is enabled for the account
    not-opted-in        – Local/Wavelength zone not yet enabled
    opt-in-not-required – standard Availability Zone (always on)
"""

from __future__ import annotations

from typing import Any

from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.shared.errors import BadRequest, UpstreamError


def list_zones(creds: Creds, region: str) -> dict[str, Any]:
    """List every zone (AZ / Local / Wavelength) in `region`.

    Response shape:
      {
        "region": "us-west-2",
        "zones": [
          {"zone_name": "us-west-2a", "zone_id": "usw2-az1",
           "zone_type": "availability-zone", "group_name": "us-west-2",
           "opt_in_status": "opt-in-not-required", "parent_zone_name": null},
          {"zone_name": "us-west-2-lax-1a", ...
           "zone_type": "local-zone", "opt_in_status": "not-opted-in", ...},
          ...
        ]
      }
    """
    if not region or not isinstance(region, str):
        raise BadRequest("missing 'region' string")

    ec2 = get_client(creds, "ec2", region)
    try:
        resp = ec2.describe_availability_zones(AllAvailabilityZones=True)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in {"AuthFailure", "UnauthorizedOperation", "AccessDenied"}:
            raise BadRequest(
                "无权列出可用区 (需要 ec2:DescribeAvailabilityZones)"
            ) from e
        if code in {"UnrecognizedClientException", "InvalidClientTokenId"}:
            raise BadRequest(f"该区域未启用或凭证无效: {region}") from e
        raise UpstreamError(
            f"describe_availability_zones failed: {code} - {msg}"
        ) from e

    zones: list[dict[str, Any]] = []
    for z in resp.get("AvailabilityZones", []):
        zones.append(
            {
                "zone_name": z.get("ZoneName"),
                "zone_id": z.get("ZoneId"),
                "zone_type": z.get("ZoneType"),  # availability-zone | local-zone | wavelength-zone
                "group_name": z.get("GroupName"),
                "opt_in_status": z.get("OptInStatus"),
                "parent_zone_name": z.get("ParentZoneName"),
                "network_border_group": z.get("NetworkBorderGroup"),
                "state": z.get("State"),
            }
        )

    return {"region": region, "zones": zones}


def enable_zone_group(creds: Creds, region: str, group_name: str) -> dict[str, Any]:
    """Opt into a Local/Wavelength zone group. Enable-only (AWS limitation).

    Enabling a group activates every zone in it (e.g. the
    `us-west-2-lax-1` group covers both us-west-2-lax-1a and -1b). AWS
    flips the status to opted-in fairly quickly but propagation can lag a
    minute, so the UI should re-fetch the zone list afterwards.
    """
    if not region or not isinstance(region, str):
        raise BadRequest("missing 'region' string")
    if not group_name or not isinstance(group_name, str):
        raise BadRequest("missing 'group_name' string")

    ec2 = get_client(creds, "ec2", region)
    try:
        ec2.modify_availability_zone_group(
            GroupName=group_name, OptInStatus="opted-in"
        )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in {"UnauthorizedOperation", "AccessDenied"}:
            raise BadRequest(
                "无权启用该区组 (需要 ec2:ModifyAvailabilityZoneGroup)"
            ) from e
        if code in {"InvalidParameterValue", "ValidationError"}:
            raise BadRequest(f"区组名无效: {group_name}") from e
        raise UpstreamError(
            f"modify_availability_zone_group failed: {code} - {msg}"
        ) from e

    return {"region": region, "group_name": group_name, "opt_in_status": "opted-in"}
