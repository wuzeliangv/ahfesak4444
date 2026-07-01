"""
Single Lambda entry point with internal router.

API Gateway HTTP API v2 event format:
    event['rawPath']               = '/ec2/list'
    event['requestContext']['http']['method'] = 'POST'
    event['headers']               = lower-cased keys
    event['body']                  = JSON string

Why one Lambda for many routes (vs. per-route Lambdas):
  - Faster cold-start aggregate (one warm container handles many endpoints)
  - Simpler SAM template + deployment story
  - Frontend latency is fine since all routes share execution-env cache

Trade-off: less IP diversity than per-function deployment. We compensate by
deploying the same function to multiple regions later (round-robin from
frontend) which gives much better IP variety than splitting one region into
many functions anyway.
"""

from __future__ import annotations

import json
import logging
import traceback
from typing import Any, Callable

from src.services import accounts, ec2, lightsail, quota
from src.services import billing, free_tier, regions_admin, zones, network
from src.services import bedrock_info, iam_signin, key_rotate, organizations
from src.services.lightsail_traffic import query_instance_traffic as lightsail_traffic
from src.services.traffic import query_instance_traffic
from src.shared.auth import extract_creds, parse_body, require_api_key
from src.shared.errors import BadRequest, PanelError
from src.shared.responses import err, ok
from src.shared.regions import list_opted_in_regions

logger = logging.getLogger()
logger.setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# Route handlers — each takes (event_body) and returns (data_dict)
# ---------------------------------------------------------------------------


def _route_health(_: dict[str, Any]) -> dict[str, Any]:
    return {"status": "ok"}


def _route_accounts_verify(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    return accounts.verify(creds)


def _route_regions_list(body: dict[str, Any]) -> dict[str, Any]:
    """Return the list of opted-in + always-on regions for the credentials."""
    creds = extract_creds(body)
    refresh = bool(body.get("refresh", False))
    return {"regions": list_opted_in_regions(creds, refresh=refresh)}


def _route_quota_region(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    quota_code = body.get("quota_code") or quota.STANDARD_VCPU_QUOTA
    return quota.get_vcpu_quota(creds, region, quota_code)


def _route_quota_all(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    quota_code = body.get("quota_code") or quota.STANDARD_VCPU_QUOTA
    regions = body.get("regions")  # optional override; None -> auto-detect
    if regions is not None and not (
        isinstance(regions, list) and all(isinstance(r, str) for r in regions)
    ):
        raise BadRequest("'regions' must be a list of strings if provided")
    return quota.get_vcpu_quota_all_regions(creds, quota_code, regions)


def _route_quota_region_detail(body: dict[str, Any]) -> dict[str, Any]:
    """One region's rich quota+usage — for client-side per-region fan-out."""
    creds = extract_creds(body)
    region = body.get("region")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    quota_code = body.get("quota_code") or quota.STANDARD_VCPU_QUOTA
    return quota.get_region_quota_detail(creds, region, quota_code)


def _route_ec2_list(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    regions = body.get("regions")
    if regions is not None and not (
        isinstance(regions, list) and all(isinstance(r, str) for r in regions)
    ):
        raise BadRequest("'regions' must be a list of strings if provided")
    return ec2.list_all_regions(creds, regions)


def _route_ec2_list_region(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    return {"region": region, "instances": ec2.list_region(creds, region)}


def _route_ec2_describe(body: dict[str, Any]) -> dict[str, Any]:
    """Describe a specific set of instances (used by the transient-state poller)."""
    creds = extract_creds(body)
    region = body.get("region")
    instance_ids = body.get("instance_ids") or body.get("instanceIds")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    if not (
        isinstance(instance_ids, list)
        and instance_ids
        and all(isinstance(i, str) and i.startswith("i-") for i in instance_ids)
    ):
        raise BadRequest("'instance_ids' must be a non-empty list of 'i-*' strings")
    if len(instance_ids) > 100:
        # AWS DescribeInstances accepts up to 100 IDs per call.
        raise BadRequest("'instance_ids' must be ≤ 100 entries")
    return {"region": region, "instances": ec2.describe_instances_batch(creds, region, instance_ids)}


def _instance_action(body: dict[str, Any], action: Callable[..., dict[str, Any]]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region")
    instance_id = body.get("instance_id") or body.get("instanceId")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    if not isinstance(instance_id, str) or not instance_id.startswith("i-"):
        raise BadRequest("missing or invalid 'instance_id' (must start with 'i-')")
    return action(creds, region, instance_id)


def _route_ec2_start(body: dict[str, Any]) -> dict[str, Any]:
    return _instance_action(body, ec2.start_instance)


def _route_ec2_stop(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region")
    instance_id = body.get("instance_id") or body.get("instanceId")
    force = bool(body.get("force", False))
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    if not isinstance(instance_id, str) or not instance_id.startswith("i-"):
        raise BadRequest("missing or invalid 'instance_id'")
    return ec2.stop_instance(creds, region, instance_id, force=force)


def _route_ec2_reboot(body: dict[str, Any]) -> dict[str, Any]:
    return _instance_action(body, ec2.reboot_instance)


def _route_ec2_change_ip(body: dict[str, Any]) -> dict[str, Any]:
    return _instance_action(body, ec2.change_public_ip)


def _route_ec2_traffic(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region")
    instance_id = body.get("instance_id") or body.get("instanceId")
    start = body.get("start")
    end = body.get("end")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    if not isinstance(instance_id, str) or not instance_id.startswith("i-"):
        raise BadRequest("missing or invalid 'instance_id'")
    if not isinstance(start, str) or not start:
        raise BadRequest("missing 'start' (ISO-8601 timestamp)")
    if not isinstance(end, str) or not end:
        raise BadRequest("missing 'end' (ISO-8601 timestamp)")
    return query_instance_traffic(creds, region, instance_id, start, end)


def _route_ec2_terminate(body: dict[str, Any]) -> dict[str, Any]:
    return _instance_action(body, ec2.terminate_instance)


def _route_ec2_rename(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region")
    instance_id = body.get("instance_id") or body.get("instanceId")
    name = body.get("name")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    if not isinstance(instance_id, str) or not instance_id.startswith("i-"):
        raise BadRequest("missing or invalid 'instance_id' (must start with 'i-')")
    if not isinstance(name, str):
        raise BadRequest("missing 'name' string (pass '' to clear)")
    # AWS tag value limits: max 256 chars, no control chars
    if len(name) > 256:
        raise BadRequest("'name' too long (max 256 chars)")
    return ec2.rename_instance(creds, region, instance_id, name)


def _route_ec2_create(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region")
    instance_type = body.get("instance_type") or body.get("instanceType")
    architecture = body.get("architecture", "x86_64")
    image = body.get("image", "al2023")
    name = body.get("name")
    password = body.get("password")
    key_name = body.get("key_name") or body.get("keyName")
    security_group_ids = body.get("security_group_ids") or body.get("securityGroupIds")
    subnet_id = body.get("subnet_id") or body.get("subnetId")
    availability_zone = body.get("availability_zone") or body.get("availabilityZone")
    wavelength_zone = body.get("wavelength_zone") or body.get("wavelengthZone")
    storage_gb = body.get("storage_gb") or body.get("storageGb") or 8
    image_id = body.get("image_id") or body.get("imageId")
    count = body.get("count", 1)

    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    if not isinstance(instance_type, str) or "." not in instance_type:
        raise BadRequest("missing or invalid 'instance_type' (e.g. 't3.micro')")
    if architecture not in {"x86_64", "arm64"}:
        raise BadRequest("'architecture' must be 'x86_64' or 'arm64'")
    if not isinstance(image, str) or not image:
        raise BadRequest("'image' must be a non-empty string slug")
    if name is not None and (not isinstance(name, str) or len(name) > 256):
        raise BadRequest("'name' must be a string ≤ 256 chars")
    if password is not None:
        if not isinstance(password, str):
            raise BadRequest("'password' must be a string")
        if len(password) < 6 or len(password) > 128:
            raise BadRequest("密码长度必须在 6 到 128 个字符之间")
    if key_name is not None and not isinstance(key_name, str):
        raise BadRequest("'key_name' must be a string")
    if security_group_ids is not None and not (
        isinstance(security_group_ids, list)
        and all(isinstance(g, str) and g.startswith("sg-") for g in security_group_ids)
    ):
        raise BadRequest("'security_group_ids' must be a list of sg-* strings")
    if subnet_id is not None and (not isinstance(subnet_id, str) or not subnet_id.startswith("subnet-")):
        raise BadRequest("'subnet_id' must be a subnet-* string")
    if availability_zone is not None and (
        not isinstance(availability_zone, str) or not availability_zone
    ):
        raise BadRequest("'availability_zone' must be a non-empty string")
    try:
        storage_gb_int = int(storage_gb)
    except (TypeError, ValueError) as e:
        raise BadRequest("'storage_gb' must be an integer") from e
    if storage_gb_int < 8 or storage_gb_int > 1000:
        raise BadRequest("'storage_gb' must be between 8 and 1000")
    if image_id is not None and (not isinstance(image_id, str) or not image_id.startswith("ami-")):
        raise BadRequest("'image_id' must be an ami-* string")
    try:
        count_int = int(count)
    except (TypeError, ValueError) as e:
        raise BadRequest("'count' must be an integer") from e
    if count_int < 1 or count_int > 10:
        raise BadRequest("机器数量必须在 1 到 10 之间")

    # Wavelength launch takes a dedicated path: it builds the carrier
    # gateway / subnet / route plumbing then launches with a Carrier IP.
    if wavelength_zone:
        if not isinstance(wavelength_zone, str) or not wavelength_zone:
            raise BadRequest("'wavelength_zone' must be a non-empty string")
        instances = network.create_wavelength_instance(
            creds,
            region,
            wavelength_zone,
            instance_type,
            architecture=architecture,
            image=image,
            name=name or None,
            password=password or None,
            storage_gb=storage_gb_int,
        )
        return {"instances": instances}

    instances = ec2.create_instance(
        creds,
        region,
        instance_type,
        architecture=architecture,
        image=image,
        name=name or None,
        password=password or None,
        key_name=key_name or None,
        security_group_ids=security_group_ids,
        subnet_id=subnet_id,
        availability_zone=availability_zone or None,
        storage_gb=storage_gb_int,
        image_id=image_id,
        count=count_int,
    )
    return {"instances": instances}


# ---------------------------------------------------------------------------
# Lightsail routes
# ---------------------------------------------------------------------------


def _route_lightsail_list(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    regions = body.get("regions")
    if regions is not None and not (
        isinstance(regions, list) and all(isinstance(r, str) for r in regions)
    ):
        raise BadRequest("'regions' must be a list of strings if provided")
    return lightsail.list_all_regions(creds, regions)


def _route_lightsail_catalog(body: dict[str, Any]) -> dict[str, Any]:
    """Return live bundle + OS-blueprint catalog for a Lightsail region."""
    creds = extract_creds(body)
    region = body.get("region")
    refresh = bool(body.get("refresh", False))
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    return lightsail.list_catalog(creds, region, refresh=refresh)


def _route_lightsail_list_region(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    return {"region": region, "instances": lightsail.list_region(creds, region)}


def _route_lightsail_describe(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region")
    instance_names = body.get("instance_names") or body.get("instanceNames")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    if not (
        isinstance(instance_names, list)
        and instance_names
        and all(isinstance(n, str) and n for n in instance_names)
    ):
        raise BadRequest("'instance_names' must be a non-empty list of strings")
    return {
        "region": region,
        "instances": lightsail.describe_instances_batch(creds, region, instance_names),
    }


def _lightsail_instance_action(
    body: dict[str, Any],
    action: Callable[..., dict[str, Any]],
) -> dict[str, Any]:
    """Common shape for start/reboot/delete: {region, instance_name}."""
    creds = extract_creds(body)
    region = body.get("region")
    instance_name = body.get("instance_name") or body.get("instanceName")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    if not isinstance(instance_name, str) or not instance_name:
        raise BadRequest("missing 'instance_name' string")
    return action(creds, region, instance_name)


def _route_lightsail_start(body: dict[str, Any]) -> dict[str, Any]:
    return _lightsail_instance_action(body, lightsail.start_instance)


def _route_lightsail_stop(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region")
    instance_name = body.get("instance_name") or body.get("instanceName")
    force = bool(body.get("force", False))
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    if not isinstance(instance_name, str) or not instance_name:
        raise BadRequest("missing 'instance_name' string")
    return lightsail.stop_instance(creds, region, instance_name, force=force)


def _route_lightsail_reboot(body: dict[str, Any]) -> dict[str, Any]:
    return _lightsail_instance_action(body, lightsail.reboot_instance)


def _route_lightsail_delete(body: dict[str, Any]) -> dict[str, Any]:
    return _lightsail_instance_action(body, lightsail.delete_instance)


def _route_lightsail_rename(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region")
    instance_name = body.get("instance_name") or body.get("instanceName")
    display_name = body.get("display_name") or body.get("displayName") or body.get("name")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    if not isinstance(instance_name, str) or not instance_name:
        raise BadRequest("missing 'instance_name' string")
    if not isinstance(display_name, str):
        raise BadRequest("missing 'display_name' string (pass '' to clear)")
    if len(display_name) > 256:
        raise BadRequest("'display_name' too long (max 256 chars)")
    return lightsail.rename_instance(creds, region, instance_name, display_name)


def _route_lightsail_change_ip(body: dict[str, Any]) -> dict[str, Any]:
    return _lightsail_instance_action(body, lightsail.change_public_ip)


def _route_lightsail_open_ports(body: dict[str, Any]) -> dict[str, Any]:
    return _lightsail_instance_action(body, lightsail.open_all_ports)


def _route_lightsail_traffic(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region")
    instance_name = body.get("instance_name") or body.get("instanceName")
    start = body.get("start")
    end = body.get("end")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    if not isinstance(instance_name, str) or not instance_name:
        raise BadRequest("missing 'instance_name' string")
    if not isinstance(start, str) or not start:
        raise BadRequest("missing 'start' (ISO-8601 timestamp)")
    if not isinstance(end, str) or not end:
        raise BadRequest("missing 'end' (ISO-8601 timestamp)")
    return lightsail_traffic(creds, region, instance_name, start, end)


def _route_lightsail_create(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region")
    bundle_id = body.get("bundle_id") or body.get("bundleId")
    blueprint_id = body.get("blueprint_id") or body.get("blueprintId")
    name = body.get("name")
    password = body.get("password")
    count = body.get("count", 1)
    ip_address_type = body.get("ip_address_type") or body.get("ipAddressType") or "ipv4"
    az = body.get("availability_zone") or body.get("availabilityZone")

    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    if not isinstance(bundle_id, str) or not bundle_id:
        raise BadRequest("missing 'bundle_id' string")
    if not isinstance(blueprint_id, str) or not blueprint_id:
        raise BadRequest("missing 'blueprint_id' string")
    if name is not None and not isinstance(name, str):
        raise BadRequest("'name' must be a string")
    if password is not None:
        if not isinstance(password, str):
            raise BadRequest("'password' must be a string")
        if len(password) < 6 or len(password) > 128:
            raise BadRequest("密码长度必须在 6 到 128 个字符之间")
    try:
        count_int = int(count)
    except (TypeError, ValueError) as e:
        raise BadRequest("'count' must be an integer") from e
    if count_int < 1 or count_int > 10:
        raise BadRequest("机器数量必须在 1 到 10 之间")
    if ip_address_type not in {"ipv4", "dualstack", "ipv6"}:
        raise BadRequest("'ip_address_type' must be 'ipv4', 'dualstack', or 'ipv6'")
    if az is not None and not isinstance(az, str):
        raise BadRequest("'availability_zone' must be a string")

    instances = lightsail.create_instance(
        creds,
        region,
        bundle_id=bundle_id,
        blueprint_id=blueprint_id,
        name=name or None,
        password=password or None,
        count=count_int,
        ip_address_type=ip_address_type,
        az=az or None,
    )
    return {"instances": instances}


# ---------------------------------------------------------------------------
# Account-level utilities: billing, free tier, region opt-in
# ---------------------------------------------------------------------------


def _route_billing_monthly(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    year = body.get("year")
    month = body.get("month")
    if year is not None:
        try:
            year = int(year)
        except (TypeError, ValueError) as e:
            raise BadRequest("'year' must be an integer") from e
    if month is not None:
        try:
            month = int(month)
        except (TypeError, ValueError) as e:
            raise BadRequest("'month' must be an integer") from e
    # Default: current month
    from datetime import date

    today = date.today()
    year = year or today.year
    month = month or today.month
    if year < 2000 or year > today.year + 1:
        raise BadRequest("'year' out of range")
    if month < 1 or month > 12:
        raise BadRequest("'month' out of range")
    return billing.get_monthly_cost(creds, year, month)


def _route_billing_summary(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    months = body.get("months", 6)
    try:
        months = int(months)
    except (TypeError, ValueError) as e:
        raise BadRequest("'months' must be an integer") from e
    return billing.get_recent_months_summary(creds, months=months)


def _route_free_tier_state(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    return free_tier.get_account_plan_state(creds)


def _route_free_tier_usage(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    return free_tier.get_free_tier_usage(creds)


def _route_regions_all(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    return regions_admin.list_all_regions(creds)


def _route_regions_enable(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region") or body.get("region_name")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    return regions_admin.enable_region(creds, region)


def _route_regions_disable(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    region = body.get("region") or body.get("region_name")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    return regions_admin.disable_region(creds, region)


def _route_zones_list(body: dict[str, Any]) -> dict[str, Any]:
    """List AZ / Local / Wavelength zones within one region."""
    creds = extract_creds(body)
    region = body.get("region")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    return zones.list_zones(creds, region)


def _route_zones_enable(body: dict[str, Any]) -> dict[str, Any]:
    """Opt into a Local/Wavelength zone group (enable-only)."""
    creds = extract_creds(body)
    region = body.get("region")
    group_name = body.get("group_name") or body.get("groupName")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    if not isinstance(group_name, str) or not group_name:
        raise BadRequest("missing 'group_name' string")
    return zones.enable_zone_group(creds, region, group_name)


def _route_peering_status(body: dict[str, Any]) -> dict[str, Any]:
    """Check Lightsail VPC peering + default-VPC route status for a region."""
    creds = extract_creds(body)
    region = body.get("region")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    return network.get_peering_status(creds, region)


def _route_peering_setup(body: dict[str, Any]) -> dict[str, Any]:
    """One-click enable Lightsail peering + add return routes (idempotent)."""
    creds = extract_creds(body)
    region = body.get("region")
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    return network.setup_peering(creds, region)


def _route_iam_signin(body: dict[str, Any]) -> dict[str, Any]:
    """Generate a 1-hour AWS Console federation login URL."""
    creds = extract_creds(body)
    destination = body.get("destination")
    if destination is not None and not isinstance(destination, str):
        raise BadRequest("'destination' must be a string")
    duration = body.get("duration_seconds") or body.get("durationSeconds") or 3600
    try:
        duration = int(duration)
    except (TypeError, ValueError) as e:
        raise BadRequest("'duration_seconds' must be an integer") from e
    return iam_signin.generate_signin_url(
        creds, destination=destination, duration_seconds=duration
    )


def _route_bedrock_info(body: dict[str, Any]) -> dict[str, Any]:
    """Return Claude foundation models + inference profiles for one region."""
    creds = extract_creds(body)
    region = body.get("region") or "us-east-1"
    if not isinstance(region, str) or not region:
        raise BadRequest("missing 'region' string")
    return bedrock_info.get_bedrock_info(creds, region)


def _route_iam_keys_list(body: dict[str, Any]) -> dict[str, Any]:
    """List access keys for the calling identity."""
    creds = extract_creds(body)
    return key_rotate.list_my_keys(creds)


def _route_iam_keys_rotate(body: dict[str, Any]) -> dict[str, Any]:
    """Create a new access key for the calling identity (old not deleted)."""
    creds = extract_creds(body)
    return key_rotate.create_new_key(creds)


def _route_iam_keys_delete(body: dict[str, Any]) -> dict[str, Any]:
    """Delete an access key by ID (signs with the supplied creds)."""
    creds = extract_creds(body)
    access_key_id = body.get("access_key_id") or body.get("accessKeyId")
    if not isinstance(access_key_id, str) or not access_key_id:
        raise BadRequest("missing 'access_key_id' string")
    return key_rotate.delete_access_key(creds, access_key_id)


def _route_iam_keys_rotate_full(body: dict[str, Any]) -> dict[str, Any]:
    """One-shot rotation: create new AK, verify, delete old AK."""
    creds = extract_creds(body)
    return key_rotate.rotate_full(creds)


def _route_org_status(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    return organizations.get_org_status(creds)


def _route_org_create(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    return organizations.create_organization(creds)


def _route_org_accounts_list(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    return {"accounts": organizations.list_sub_accounts(creds)}


def _route_org_accounts_create(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    email = body.get("email")
    name = body.get("name")
    return organizations.create_sub_account(creds, email, name)


def _route_org_accounts_status(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    request_id = body.get("request_id")
    return organizations.check_create_account_status(creds, request_id)


def _route_org_accounts_create_keys(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    sub_account_id = body.get("sub_account_id") or body.get("subAccountId")
    admin_user_name = body.get("admin_user_name") or "admin"
    return organizations.create_sub_account_admin_keys(creds, sub_account_id, admin_user_name)


def _route_org_create_master_iam(body: dict[str, Any]) -> dict[str, Any]:
    creds = extract_creds(body)
    return organizations.create_master_iam_admin(creds)


# ---------------------------------------------------------------------------
# Routing table
# ---------------------------------------------------------------------------

# (method, path) -> (handler, requires_api_key)
ROUTES: dict[tuple[str, str], tuple[Callable[[dict[str, Any]], dict[str, Any]], bool]] = {
    ("GET", "/health"): (_route_health, False),
    ("POST", "/accounts/verify"): (_route_accounts_verify, True),
    ("POST", "/regions/list"): (_route_regions_list, True),
    ("POST", "/quota/region"): (_route_quota_region, True),
    ("POST", "/quota/region-detail"): (_route_quota_region_detail, True),
    ("POST", "/quota/all-regions"): (_route_quota_all, True),
    ("POST", "/ec2/list"): (_route_ec2_list, True),
    ("POST", "/ec2/list-region"): (_route_ec2_list_region, True),
    ("POST", "/ec2/describe"): (_route_ec2_describe, True),
    ("POST", "/ec2/start"): (_route_ec2_start, True),
    ("POST", "/ec2/stop"): (_route_ec2_stop, True),
    ("POST", "/ec2/reboot"): (_route_ec2_reboot, True),
    ("POST", "/ec2/change-ip"): (_route_ec2_change_ip, True),
    ("POST", "/ec2/traffic"): (_route_ec2_traffic, True),
    ("POST", "/ec2/terminate"): (_route_ec2_terminate, True),
    ("POST", "/ec2/rename"): (_route_ec2_rename, True),
    ("POST", "/ec2/create"): (_route_ec2_create, True),
    ("POST", "/lightsail/list"): (_route_lightsail_list, True),
    ("POST", "/lightsail/list-region"): (_route_lightsail_list_region, True),
    ("POST", "/lightsail/catalog"): (_route_lightsail_catalog, True),
    ("POST", "/lightsail/describe"): (_route_lightsail_describe, True),
    ("POST", "/lightsail/start"): (_route_lightsail_start, True),
    ("POST", "/lightsail/stop"): (_route_lightsail_stop, True),
    ("POST", "/lightsail/reboot"): (_route_lightsail_reboot, True),
    ("POST", "/lightsail/delete"): (_route_lightsail_delete, True),
    ("POST", "/lightsail/rename"): (_route_lightsail_rename, True),
    ("POST", "/lightsail/change-ip"): (_route_lightsail_change_ip, True),
    ("POST", "/lightsail/open-ports"): (_route_lightsail_open_ports, True),
    ("POST", "/lightsail/traffic"): (_route_lightsail_traffic, True),
    ("POST", "/lightsail/create"): (_route_lightsail_create, True),
    ("POST", "/billing/monthly"): (_route_billing_monthly, True),
    ("POST", "/billing/summary"): (_route_billing_summary, True),
    ("POST", "/free-tier/state"): (_route_free_tier_state, True),
    ("POST", "/free-tier/usage"): (_route_free_tier_usage, True),
    ("POST", "/regions/all"): (_route_regions_all, True),
    ("POST", "/regions/enable"): (_route_regions_enable, True),
    ("POST", "/regions/disable"): (_route_regions_disable, True),
    ("POST", "/zones/list"): (_route_zones_list, True),
    ("POST", "/zones/enable"): (_route_zones_enable, True),
    ("POST", "/peering/status"): (_route_peering_status, True),
    ("POST", "/peering/setup"): (_route_peering_setup, True),
    ("POST", "/iam/signin-url"): (_route_iam_signin, True),
    ("POST", "/iam/keys/list"): (_route_iam_keys_list, True),
    ("POST", "/iam/keys/rotate"): (_route_iam_keys_rotate, True),
    ("POST", "/iam/keys/delete"): (_route_iam_keys_delete, True),
    ("POST", "/iam/keys/rotate-full"): (_route_iam_keys_rotate_full, True),
    ("POST", "/bedrock/info"): (_route_bedrock_info, True),
    ("POST", "/org/status"): (_route_org_status, True),
    ("POST", "/org/create"): (_route_org_create, True),
    ("POST", "/org/accounts/list"): (_route_org_accounts_list, True),
    ("POST", "/org/accounts/create"): (_route_org_accounts_create, True),
    ("POST", "/org/accounts/status"): (_route_org_accounts_status, True),
    ("POST", "/org/accounts/create-keys"): (_route_org_accounts_create_keys, True),
    ("POST", "/org/create-master-iam"): (_route_org_create_master_iam, True),
}


# ---------------------------------------------------------------------------
# Lambda entry point
# ---------------------------------------------------------------------------


def _extract_route(event: dict[str, Any]) -> tuple[str, str]:
    rc_http = (event.get("requestContext") or {}).get("http") or {}
    method = (rc_http.get("method") or event.get("httpMethod") or "GET").upper()
    # rawPath is the canonical field for HTTP API v2
    path = event.get("rawPath") or rc_http.get("path") or event.get("path") or "/"
    return method, path


def _safe_log_event(event: dict[str, Any]) -> dict[str, Any]:
    """Strip body before logging so AK/SK never reach CloudWatch."""
    return {
        "method": (event.get("requestContext") or {}).get("http", {}).get("method"),
        "path": event.get("rawPath"),
        "source_ip": (event.get("requestContext") or {}).get("http", {}).get("sourceIp"),
        "user_agent": (event.get("headers") or {}).get("user-agent"),
        "request_id": (event.get("requestContext") or {}).get("requestId"),
    }


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:  # noqa: ARG001
    method, path = _extract_route(event)

    # CORS preflight — answer without invoking any route
    if method == "OPTIONS":
        return {
            "statusCode": 204,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
                "Access-Control-Max-Age": "600",
            },
            "body": "",
        }

    logger.info("request %s", json.dumps(_safe_log_event(event)))

    route = ROUTES.get((method, path))
    if route is None:
        return err("NotFound", f"no route for {method} {path}", status=404)

    fn, needs_auth = route

    try:
        if needs_auth:
            require_api_key(event)

        if method == "POST":
            body = parse_body(event)
        else:
            body = {}

        data = fn(body)
        return ok(data)

    except PanelError as e:
        logger.warning("PanelError: %s %s", e.code, e.message)
        return err(e.code, e.message, status=e.status, **e.extra)
    except Exception as e:  # noqa: BLE001
        # Never leak the traceback in the response body
        err_str = f"{type(e).__name__}: {e}"
        # Detect credential-related failures and return a clear message
        _CRED_HINTS = (
            "UnrecognizedClient", "InvalidClientToken", "AuthFailure",
            "ExpiredToken", "AccessDenied", "SignatureDoesNotMatch",
            "InvalidAccessKey",
        )
        if any(h in err_str for h in _CRED_HINTS):
            logger.warning("credential error: %s", err_str)
            return err("InvalidCredentials", "AWS 接口错误: 账号密钥无效或已被禁用 (UnrecognizedClientException: The security token included in the request is invalid.)", status=401)
        logger.error("unhandled %s: %s\n%s", type(e).__name__, e, traceback.format_exc())
        return err("InternalError", "unexpected server error", status=500)
