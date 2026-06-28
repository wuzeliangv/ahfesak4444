"""
Lightsail service — list, start/stop/reboot, delete, rename (tag).

Lightsail differs from EC2 in important ways the rest of the codebase has
to be aware of:

  - **Region set is fixed.** There is no opt-in concept — Lightsail is
    available in exactly 14 regions and every account sees the same list.
    We hard-code them below.
  - **Instance name is the primary key.** Unlike EC2's `i-…` ID, the user
    chose the name at creation time and it CANNOT be changed afterwards.
    For UI display we therefore lean on a `Name` tag (settable via
    `tag_resource`) and fall back to the real instance name.
  - **No InstanceIds-style batched describe.** `get_instance(name=)` is
    one-at-a-time. For the poller we call `get_instances` (full region
    scan) and filter — Lightsail accounts rarely have enough instances
    for that to matter.

State machine (Lightsail-specific names — *not* the same as EC2):
    pending → running → stopping → stopped → starting → running
    (plus 'terminated' after delete)

API client: `boto3.client('lightsail', region_name=…)`.
"""

from __future__ import annotations

import asyncio
from typing import Any, Iterable

import aioboto3
from botocore.config import Config
from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.services.user_data import build_password_user_data
from src.shared.errors import BadRequest, NotFound, UpstreamError

# AWS publishes Lightsail in this fixed set (as of 2026). The opt-in
# regions are also included — Lightsail surfaces them even when the
# account hasn't enabled them, and showing the full list avoids confusing
# the user. A create attempt in an opt-in region the account hasn't
# enabled returns a clear error from AWS.
# Refresh on next deploy if AWS adds a new region.
LIGHTSAIL_REGIONS: list[str] = [
    "us-east-1",
    "us-east-2",
    "us-west-2",
    "ap-east-1",        # Hong Kong (opt-in)
    "ap-south-1",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-3",   # Jakarta (opt-in)
    "ap-southeast-5",   # Kuala Lumpur (opt-in)
    "ca-central-1",
    "eu-central-1",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-north-1",
    "eu-south-2",       # Spain (opt-in)
    "sa-east-1",        # São Paulo
]

# Lightsail returns these codes when the account hasn't opted into a
# region (or that region simply isn't enabled for this account). We treat
# them the same as "region scan returned zero instances" — there's
# nothing actionable to surface, the user only cares about regions they
# actively use.
_REGION_NOT_ENABLED_CODES = frozenset(
    {
        "AccessDeniedException",
        "UnauthorizedAccess",
        "UnrecognizedClientException",  # AK/SK refused (region not opted in)
        "InvalidClientTokenId",          # same family, different wording
        "AuthFailure",
        "OptInRequired",
        "RegionSetupInProgressException",  # region exists but not yet set up
    }
)

_ASYNC_CFG = Config(
    retries={"max_attempts": 2, "mode": "standard"},
    connect_timeout=3,
    read_timeout=10,
)


# Catalog (bundles + OS blueprints) is fetched live from AWS and cached in
# the warm Lambda execution environment. Bundle prices and SKU lineup
# change occasionally (Apr 2024 saw the _2_0 → _3_0 transition + a price
# bump + new memory/compute-optimized families); pulling fresh keeps the UI
# accurate without redeploying.
_CATALOG_CACHE: dict[tuple[str, str], dict[str, Any]] = {}


def _display_name_from_tags(tags: list[dict[str, str]] | None) -> str | None:
    if not tags:
        return None
    for t in tags:
        if t.get("key") == "Name":
            return t.get("value")
    return None


def _serialize_instance(inst: dict[str, Any]) -> dict[str, Any]:
    """
    Convert raw boto3 Lightsail instance dict into a UI-friendly subset.

    Notes on the field mapping:
      - `name` is Lightsail's own immutable instance name (the primary key
        for every other call). We surface it as both `instance_name` (for
        actions) and as a fallback for `display_name`.
      - `display_name` reflects the `Name` tag if set, otherwise the real
        instance name. This matches the EC2 page's notion of "alias".
      - State string is Lightsail's lowercase form ('running', 'stopped',
        'starting', 'stopping', 'pending', 'terminated', etc.).
    """
    location = inst.get("location") or {}
    hardware = inst.get("hardware") or {}
    networking = inst.get("networking") or {}
    monthly = networking.get("monthlyTransfer") or {}

    disks = hardware.get("disks") or []
    total_disk = sum(d.get("sizeInGb", 0) or 0 for d in disks)

    tags = [
        {"key": t.get("key"), "value": t.get("value")}
        for t in (inst.get("tags") or [])
    ]

    created_at = inst.get("createdAt")
    if created_at is not None and not isinstance(created_at, str):
        # boto3 returns datetime; the JSON layer stringifies it but be safe.
        created_at = created_at.isoformat()

    return {
        "instance_name": inst["name"],
        "display_name": _display_name_from_tags(inst.get("tags")) or inst["name"],
        "state": (inst.get("state") or {}).get("name") or "unknown",
        "public_ip": inst.get("publicIpAddress"),
        "private_ip": inst.get("privateIpAddress"),
        "ipv6_addresses": inst.get("ipv6Addresses") or [],
        "is_static_ip": bool(inst.get("isStaticIp")),
        "ip_address_type": inst.get("ipAddressType"),
        "region": location.get("regionName"),
        "az": location.get("availabilityZone"),
        "bundle_id": inst.get("bundleId"),
        "blueprint_id": inst.get("blueprintId"),
        "blueprint_name": inst.get("blueprintName"),
        "username": inst.get("username"),
        "ssh_key_name": inst.get("sshKeyName"),
        "cpu_count": hardware.get("cpuCount"),
        "ram_gb": hardware.get("ramSizeInGb"),
        "disk_gb": total_disk or None,
        "monthly_transfer_gb": monthly.get("gbPerMonthAllocated"),
        "created_at": created_at,
        "tags": tags,
        "arn": inst.get("arn"),
    }


# ---------------------------------------------------------------------------
# Catalog: bundles + OS blueprints (live from AWS, cached)
# ---------------------------------------------------------------------------


def _normalize_platform(aws_platform: str | None) -> str:
    """Map AWS's LINUX_UNIX / WINDOWS to lowercase 'linux' / 'windows'."""
    if aws_platform == "WINDOWS":
        return "windows"
    return "linux"


def _classify_bundle_family(bundle_id: str) -> str:
    """
    Group bundles by the AWS instance family their price+specs belong to:
      - general purpose  → `nano_3_0`, `large_3_0`, …
      - memory optimized → `m_large_1_0`, `m_xlarge_1_0`, …
      - compute optimized → `c_large_1_0`, `c_xlarge_1_0`, …
    Lightsail doesn't expose the family directly in `get_bundles`, so we
    parse the prefix. New families would need an entry here.
    """
    if bundle_id.startswith("m_"):
        return "memory"
    if bundle_id.startswith("c_"):
        return "compute"
    return "general"


def _fetch_catalog(creds: Creds, region: str) -> dict[str, Any]:
    """Pull live bundles + OS blueprints and normalize for the UI."""
    ls = get_client(creds, "lightsail", region)
    try:
        bundles_resp = ls.get_bundles()
        blueprints_resp = ls.get_blueprints()
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        raise UpstreamError(f"lightsail catalog lookup failed: {code}") from e

    bundles: list[dict[str, Any]] = []
    for b in bundles_resp.get("bundles", []):
        if not b.get("isActive"):
            continue
        platforms = b.get("supportedPlatforms") or []
        platform = "windows" if "WINDOWS" in platforms else "linux"
        ipv4 = int(b.get("publicIpv4AddressCount", 0) or 0)
        bundles.append(
            {
                "bundle_id": b["bundleId"],
                "name": b.get("name"),
                "cpu": b.get("cpuCount"),
                "ram_gb": b.get("ramSizeInGb"),
                "disk_gb": b.get("diskSizeInGb"),
                "transfer_gb": b.get("transferPerMonthInGb"),
                "price_per_month": b.get("price"),
                "platform": platform,
                "family": _classify_bundle_family(b["bundleId"]),
                "has_public_ipv4": ipv4 > 0,
                "is_ipv6_only": ipv4 == 0,
            }
        )

    # Sort by family → platform → price for stable display.
    bundles.sort(
        key=lambda x: (
            {"general": 0, "memory": 1, "compute": 2}.get(x["family"], 99),
            0 if x["platform"] == "linux" else 1,
            0 if x["has_public_ipv4"] else 1,
            x["price_per_month"] or 0,
        )
    )

    blueprints: list[dict[str, Any]] = []
    for bp in blueprints_resp.get("blueprints", []):
        if not bp.get("isActive"):
            continue
        if bp.get("type") != "os":
            continue
        blueprints.append(
            {
                "blueprint_id": bp["blueprintId"],
                "name": bp.get("name"),
                "platform": _normalize_platform(bp.get("platform")),
                "group": bp.get("group"),
                "version": bp.get("version"),
                "min_power": bp.get("minPower", 0),
            }
        )

    return {"bundles": bundles, "blueprints": blueprints}


def list_catalog(creds: Creds, region: str, refresh: bool = False) -> dict[str, Any]:
    """Return (cached) {bundles, blueprints} for `region`.

    Use `refresh=True` to force a fresh `get_bundles` / `get_blueprints` —
    typically called after AWS announces a pricing or SKU update."""
    key = (creds.cache_key, region)
    if not refresh:
        cached = _CATALOG_CACHE.get(key)
        if cached is not None:
            return cached
    data = _fetch_catalog(creds, region)
    _CATALOG_CACHE[key] = data
    return data


def _resolve_blueprint_platform(creds: Creds, region: str, blueprint_id: str) -> str:
    """Look up a blueprint's platform (linux / windows) from the cached catalog."""
    for bp in list_catalog(creds, region).get("blueprints", []):
        if bp["blueprint_id"] == blueprint_id:
            return bp["platform"]
    # Refresh once in case we have a stale cache.
    for bp in list_catalog(creds, region, refresh=True).get("blueprints", []):
        if bp["blueprint_id"] == blueprint_id:
            return bp["platform"]
    raise BadRequest(f"unknown Lightsail blueprint '{blueprint_id}'")


def _resolve_bundle_platform(creds: Creds, region: str, bundle_id: str) -> str:
    """Same as above but for bundles. Used to cross-check OS consistency."""
    for b in list_catalog(creds, region).get("bundles", []):
        if b["bundle_id"] == bundle_id:
            return b["platform"]
    for b in list_catalog(creds, region, refresh=True).get("bundles", []):
        if b["bundle_id"] == bundle_id:
            return b["platform"]
    raise BadRequest(f"unknown Lightsail bundle '{bundle_id}'")


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------


def list_region(creds: Creds, region: str) -> list[dict[str, Any]]:
    """List Lightsail instances in one region, sync."""
    ls = get_client(creds, "lightsail", region)
    try:
        rows: list[dict[str, Any]] = []
        next_token: str | None = None
        while True:
            params: dict[str, Any] = {}
            if next_token:
                params["pageToken"] = next_token
            resp = ls.get_instances(**params)
            for inst in resp.get("instances", []):
                rows.append(_serialize_instance(inst))
            next_token = resp.get("nextPageToken")
            if not next_token:
                break
        return rows
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        # Region not opted in / not enabled for this account → treat as empty
        # so the fan-out still succeeds for regions the user actually uses.
        if code in _REGION_NOT_ENABLED_CODES:
            return []
        # Treat HTTP 5xx ("unexpected server error") from opt-in regions
        # as region-not-enabled.
        http_status = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
        if http_status >= 500:
            return []
        raise UpstreamError(
            f"lightsail get_instances failed in {region}: {code}"
        ) from e


async def _list_one_async(
    session: aioboto3.Session,
    creds: Creds,
    region: str,
) -> tuple[str, list[dict[str, Any]] | None, str | None]:
    """Returns (region, instances, error_code). instances is None on failure."""
    try:
        async with session.client(
            "lightsail",
            region_name=region,
            aws_access_key_id=creds.access_key,
            aws_secret_access_key=creds.secret_key,
            aws_session_token=creds.session_token,
            config=_ASYNC_CFG,
        ) as ls:
            rows: list[dict[str, Any]] = []
            next_token: str | None = None
            while True:
                params: dict[str, Any] = {}
                if next_token:
                    params["pageToken"] = next_token
                resp = await ls.get_instances(**params)
                for inst in resp.get("instances", []):
                    rows.append(_serialize_instance(inst))
                next_token = resp.get("nextPageToken")
                if not next_token:
                    break
            return region, rows, None
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        # Same not-enabled-as-empty special case as the sync path.
        if code in _REGION_NOT_ENABLED_CODES:
            return region, [], None
        # Treat HTTP 5xx ("unexpected server error") from opt-in regions
        # as region-not-enabled — these regions return generic 500s when
        # the account hasn't activated them.
        http_status = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
        if http_status >= 500:
            return region, [], None
        return region, None, code
    except Exception as e:  # noqa: BLE001
        err_name = type(e).__name__
        # Catch-all: connection / timeout errors from regions that simply
        # don't respond to this account are also silenced.
        if "Endpoint" in str(e) or "timed out" in str(e).lower():
            return region, [], None
        return region, None, err_name


async def _list_all_async(
    creds: Creds, regions: Iterable[str]
) -> dict[str, Any]:
    session = aioboto3.Session()
    results = await asyncio.gather(*(_list_one_async(session, creds, r) for r in regions))

    instances: list[dict[str, Any]] = []
    region_status: list[dict[str, Any]] = []
    for region, rows, err in results:
        if err is None:
            assert rows is not None
            instances.extend(rows)
            region_status.append({"region": region, "ok": True, "count": len(rows)})
        else:
            region_status.append({"region": region, "ok": False, "error": err})

    instances.sort(key=lambda x: (x["region"] or "", x["instance_name"]))
    region_status.sort(key=lambda x: x["region"])
    return {
        "instances": instances,
        "regions": region_status,
        "summary": {
            "total_instances": len(instances),
            "running": sum(1 for i in instances if i["state"] == "running"),
            "stopped": sum(1 for i in instances if i["state"] == "stopped"),
            "regions_scanned": len(region_status),
            "regions_ok": sum(1 for r in region_status if r["ok"]),
        },
    }


def list_all_regions(creds: Creds, regions: list[str] | None = None) -> dict[str, Any]:
    """Fan-out across all Lightsail regions concurrently."""
    if regions is None:
        regions = LIGHTSAIL_REGIONS
    return asyncio.run(_list_all_async(creds, regions))


# ---------------------------------------------------------------------------
# Describe (for transient-state poller)
# ---------------------------------------------------------------------------


def describe_instances_batch(
    creds: Creds, region: str, instance_names: list[str]
) -> list[dict[str, Any]]:
    """
    Look up the latest state of a known set of Lightsail instances.

    Lightsail's API has no batched `GetInstances(instanceNames=[...])` form,
    so we either fan out N `get_instance(name=…)` calls or pull the full
    region and filter. The full-region path is one request and Lightsail
    accounts almost never have so many instances that this is wasteful;
    we use that.
    """
    if not instance_names:
        return []
    wanted = set(instance_names)
    return [
        row for row in list_region(creds, region) if row["instance_name"] in wanted
    ]


# ---------------------------------------------------------------------------
# Control actions
# ---------------------------------------------------------------------------


def _classify_action_error(e: ClientError, action: str, instance_name: str) -> Exception:
    code = e.response.get("Error", {}).get("Code", "Unknown")
    msg = e.response.get("Error", {}).get("Message", str(e))
    if code in {"NotFoundException", "DoesNotExist"}:
        return NotFound(f"lightsail instance {instance_name} not found")
    if code in {"OperationFailureException", "InvalidInputException"}:
        return BadRequest(f"cannot {action} instance: {msg}")
    return UpstreamError(f"lightsail {action} failed: {code} - {msg}")


def start_instance(creds: Creds, region: str, instance_name: str) -> dict[str, Any]:
    ls = get_client(creds, "lightsail", region)
    try:
        ls.start_instance(instanceName=instance_name)
    except ClientError as e:
        raise _classify_action_error(e, "start", instance_name) from e
    return {"instance_name": instance_name, "current_state": "starting"}


def stop_instance(
    creds: Creds, region: str, instance_name: str, *, force: bool = False
) -> dict[str, Any]:
    """Stop a running Lightsail instance.

    The `force` flag maps to `forceStop=True` — Lightsail's equivalent of
    EC2's force-stop, used when a graceful shutdown is hanging.
    """
    ls = get_client(creds, "lightsail", region)
    try:
        kwargs: dict[str, Any] = {"instanceName": instance_name}
        if force:
            kwargs["forceStop"] = True
        ls.stop_instance(**kwargs)
    except ClientError as e:
        raise _classify_action_error(e, "stop", instance_name) from e
    return {"instance_name": instance_name, "current_state": "stopping"}


def reboot_instance(creds: Creds, region: str, instance_name: str) -> dict[str, Any]:
    ls = get_client(creds, "lightsail", region)
    try:
        ls.reboot_instance(instanceName=instance_name)
    except ClientError as e:
        raise _classify_action_error(e, "reboot", instance_name) from e
    return {"instance_name": instance_name, "current_state": "rebooting"}


def delete_instance(creds: Creds, region: str, instance_name: str) -> dict[str, Any]:
    """
    Permanently delete the instance.

    `forceDeleteAddOns=True` removes auto-snapshots attached to the instance
    along with it; without that flag, instances with active addons refuse
    to delete.
    """
    ls = get_client(creds, "lightsail", region)
    try:
        ls.delete_instance(instanceName=instance_name, forceDeleteAddOns=True)
    except ClientError as e:
        raise _classify_action_error(e, "delete", instance_name) from e
    return {"instance_name": instance_name, "current_state": "terminated"}


def rename_instance(
    creds: Creds, region: str, instance_name: str, display_name: str
) -> dict[str, Any]:
    """
    Set / clear the `Name` tag on a Lightsail instance.

    Lightsail instance names are immutable, so the "rename" in our UI is
    really a tag write. Passing an empty string clears the tag.
    """
    ls = get_client(creds, "lightsail", region)
    try:
        if display_name == "":
            ls.untag_resource(resourceName=instance_name, tagKeys=["Name"])
            return {"instance_name": instance_name, "display_name": None}
        ls.tag_resource(
            resourceName=instance_name,
            tags=[{"key": "Name", "value": display_name}],
        )
    except ClientError as e:
        raise _classify_action_error(e, "rename", instance_name) from e
    return {"instance_name": instance_name, "display_name": display_name}


# ---------------------------------------------------------------------------
# Create instance
# ---------------------------------------------------------------------------


_VALID_NAME_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._")


def _validate_instance_name(name: str) -> None:
    """
    Apply Lightsail's name constraints before sending to AWS.

    Lightsail accepts: 2–255 chars, ASCII alphanumeric plus `- . _`,
    must start with an alphanumeric. Passing anything else returns a
    cryptic `InvalidInputException`; better to surface it ourselves.
    """
    if not 2 <= len(name) <= 255:
        raise BadRequest("实例名长度必须在 2 到 255 个字符之间")
    if not (name[0].isalnum()):
        raise BadRequest("实例名必须以字母或数字开头")
    if any(c not in _VALID_NAME_CHARS for c in name):
        raise BadRequest("实例名只能包含字母 / 数字 / 连字符 / 点 / 下划线")


def _resolve_first_az(creds: Creds, region: str) -> str:
    """
    Pick the first available AZ in `region` so the caller doesn't have to.

    Lightsail's `create_instances` requires an explicit AZ — there's no
    "let AWS choose" sentinel. We query `get_regions(includeAvailabilityZones)`
    and pick the alphabetically first AZ that's reported up.
    """
    ls = get_client(creds, "lightsail", region)
    try:
        resp = ls.get_regions(includeAvailabilityZones=True)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        raise UpstreamError(f"get_regions failed: {code}") from e
    for r in resp.get("regions", []):
        if r.get("name") == region:
            azs = sorted(
                a.get("zoneName") for a in (r.get("availabilityZones") or [])
                if a.get("state") == "available" and a.get("zoneName")
            )
            if azs:
                return azs[0]
            break
    raise UpstreamError(f"no available AZ for Lightsail region {region}")


def _open_all_ports(
    creds: Creds, region: str, instance_name: str, ip_address_type: str
) -> None:
    """
    Replace the instance's firewall rules with a single all-protocols-allowed
    ruleset scoped to the instance's IP stack.

    Lightsail's `put_instance_public_ports` REPLACES the entire ruleset, so
    we just send the comprehensive set in one call. Rules adapt to the
    `ip_address_type`:

      - ipv4       → TCP/UDP 0-65535 over 0.0.0.0/0, ICMP over 0.0.0.0/0
      - dualstack  → same as ipv4 plus ::/0 on TCP/UDP and a separate ICMPv6 rule
      - ipv6       → TCP/UDP 0-65535 over ::/0, ICMPv6 only

    Failures here are non-fatal for `create_instance` — the instance still
    works; the user can re-open ports later via the AWS console or by
    calling the panel again.
    """
    v4 = ip_address_type in {"ipv4", "dualstack"}
    v6 = ip_address_type in {"dualstack", "ipv6"}

    port_infos: list[dict[str, Any]] = []
    for proto in ("tcp", "udp"):
        entry: dict[str, Any] = {"protocol": proto, "fromPort": 0, "toPort": 65535}
        if v4:
            entry["cidrs"] = ["0.0.0.0/0"]
        if v6:
            entry["ipv6Cidrs"] = ["::/0"]
        port_infos.append(entry)
    if v4:
        port_infos.append(
            {"protocol": "icmp", "fromPort": -1, "toPort": -1, "cidrs": ["0.0.0.0/0"]}
        )
    if v6:
        port_infos.append(
            {"protocol": "icmpv6", "fromPort": -1, "toPort": -1, "ipv6Cidrs": ["::/0"]}
        )

    ls = get_client(creds, "lightsail", region)
    try:
        ls.put_instance_public_ports(instanceName=instance_name, portInfos=port_infos)
    except ClientError as e:
        # Log via re-raise as UpstreamError so the caller can decide. The
        # creator currently swallows this.
        code = e.response.get("Error", {}).get("Code", "Unknown")
        raise UpstreamError(
            f"put_instance_public_ports failed for {instance_name}: {code}"
        ) from e


def open_all_ports(creds: Creds, region: str, instance_name: str) -> dict[str, Any]:
    """
    Re-apply the 'all ports open' firewall ruleset to an existing instance,
    auto-detecting its IP stack (ipv4 / dualstack / ipv6) from the instance.

    Why this exists separately from `create_instance`'s inline open: at
    create time the instance is still 'pending' and Lightsail rejects
    `put_instance_public_ports`, so the firewall open is silently lost. The
    frontend calls this endpoint once the new instance reaches 'running' to
    finish the job.

    Idempotent — `put_instance_public_ports` REPLACES the whole ruleset, so
    repeated calls converge on the same fully-open state.
    """
    ls = get_client(creds, "lightsail", region)
    try:
        resp = ls.get_instance(instanceName=instance_name)
    except ClientError as e:
        raise _classify_action_error(e, "open-ports", instance_name) from e

    inst = resp.get("instance") or {}
    ip_address_type = inst.get("ipAddressType") or "ipv4"
    if ip_address_type not in {"ipv4", "dualstack", "ipv6"}:
        ip_address_type = "ipv4"

    _open_all_ports(creds, region, instance_name, ip_address_type)
    return {
        "instance_name": instance_name,
        "ip_address_type": ip_address_type,
        "opened": True,
    }


def _wait_for_operation(ls: Any, operation_id: str, timeout: int = 30) -> None:
    """
    Block until a Lightsail operation finishes (Succeeded/Failed) or times out.

    Most attach/detach/allocate ops finish in 1-5 seconds; the 30s ceiling
    covers tail latency without holding the Lambda too long.
    """
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            resp = ls.get_operation(operationId=operation_id)
            status = (resp.get("operation") or {}).get("status")
            if status == "Succeeded":
                return
            if status in {"Failed", "NotStarted"}:
                if status == "Failed":
                    raise UpstreamError(f"lightsail operation {operation_id} failed")
        except ClientError:
            # Operation not yet visible — keep polling.
            pass
        time.sleep(1)
    raise UpstreamError(f"lightsail operation {operation_id} timed out")


def change_public_ip(creds: Creds, region: str, instance_name: str) -> dict[str, Any]:
    """
    Replace the dynamic public IPv4 of a running Lightsail instance.

    Strategy ("Static IP juggle"):
      1. `allocate_static_ip` — gets a fresh IPv4 from AWS pool
      2. `attach_static_ip`  — instance's public IP changes to that static IP
      3. `detach_static_ip`  — instance is reassigned a *new* dynamic IP
                               (different from the original AND from the static)
      4. `release_static_ip` — clean up the temporary resource

    Lightsail doesn't support EC2's "modify ENI association" path, so this
    is the only reliable in-place change-IP method. The instance stays
    running throughout; the public IP changes ~3 times during the swap
    but settles on a brand-new dynamic IP at the end.

    Rejects:
      - non-running instances (Lightsail won't accept attach on stopped)
      - instances with an actual Static IP attached (changing that means
        releasing the static IP, which the user should do explicitly)
      - IPv6-only instances (no IPv4 to change)
    """
    import uuid

    ls = get_client(creds, "lightsail", region)
    try:
        resp = ls.get_instance(instanceName=instance_name)
    except ClientError as e:
        raise _classify_action_error(e, "change-ip", instance_name) from e

    inst = resp.get("instance") or {}
    state = (inst.get("state") or {}).get("name", "unknown")
    if state != "running":
        raise BadRequest(f"实例必须处于运行中状态才能换 IP (当前: {state})")
    if inst.get("isStaticIp"):
        raise BadRequest("实例已绑定 Static IP, 请先在 AWS 控制台手动解绑后再换")
    old_ip = inst.get("publicIpAddress")
    if not old_ip:
        raise BadRequest("实例无公网 IPv4 (IPv6-only 实例无法用此方式换 IP)")

    # Use a UUID-ish name so concurrent change-ip calls on different
    # instances don't collide. Lightsail static-ip names are scoped to
    # account + region and must be unique.
    tmp_name = f"tmp-changeip-{uuid.uuid4().hex[:12]}"

    # Step 1: allocate
    try:
        alloc = ls.allocate_static_ip(staticIpName=tmp_name)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in {"AccountSetupInProgressException"}:
            raise BadRequest("账号 Lightsail 初始化尚未完成") from e
        if "limit" in msg.lower() or "quota" in msg.lower():
            raise BadRequest(
                "区域 Static IP 配额已满 (默认 5 个/区域), 请到 AWS 控制台释放未用的"
            ) from e
        raise UpstreamError(f"allocate_static_ip failed: {code} - {msg}") from e
    for op in alloc.get("operations", []):
        if op.get("id"):
            _wait_for_operation(ls, op["id"])

    # Step 2-4 wrapped in try/finally so we always release the temp IP.
    new_ip: str | None = None
    try:
        # Step 2: attach
        att = ls.attach_static_ip(staticIpName=tmp_name, instanceName=instance_name)
        for op in att.get("operations", []):
            if op.get("id"):
                _wait_for_operation(ls, op["id"])

        # Step 3: detach (instance gets a brand-new dynamic IP here)
        det = ls.detach_static_ip(staticIpName=tmp_name)
        for op in det.get("operations", []):
            if op.get("id"):
                _wait_for_operation(ls, op["id"])
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        # Clean up the temp static IP before re-raising.
        try:
            ls.release_static_ip(staticIpName=tmp_name)
        except ClientError:
            pass
        raise UpstreamError(f"change-ip failed: {code} - {msg}") from e
    finally:
        # Step 4: always release the temp static IP. If this fails, the
        # user has a small dangling resource; not fatal but worth retrying.
        try:
            ls.release_static_ip(staticIpName=tmp_name)
        except ClientError:
            pass

    # Re-describe to surface the new IP.
    try:
        resp2 = ls.get_instance(instanceName=instance_name)
        new_ip = (resp2.get("instance") or {}).get("publicIpAddress")
    except ClientError:
        new_ip = None

    return {
        "instance_name": instance_name,
        "previous_ip": old_ip,
        "current_ip": new_ip,
    }


def create_instance(
    creds: Creds,
    region: str,
    *,
    bundle_id: str,
    blueprint_id: str,
    name: str | None = None,
    password: str | None = None,
    count: int = 1,
    ip_address_type: str = "ipv4",  # 'ipv4', 'dualstack', or 'ipv6'
    az: str | None = None,
) -> list[dict[str, Any]]:
    """
    Launch `count` Lightsail instances in `region`.

    Naming:
      - count == 1: instance name = `name` (or auto-generated UUID if None)
      - count >  1: instance names = `<name>-01`, `<name>-02`, …

    Bundle / blueprint validation runs against the live catalog (fetched
    via `list_catalog` and cached) so a Lightsail SKU update doesn't
    require a backend redeploy. We only enforce that the bundle and
    blueprint share the same platform (linux vs windows) — every other
    constraint is left to AWS.
    """
    import uuid

    if count < 1 or count > 10:
        raise BadRequest("count must be between 1 and 10")
    if ip_address_type not in {"ipv4", "dualstack", "ipv6"}:
        raise BadRequest("ip_address_type must be 'ipv4', 'dualstack', or 'ipv6'")

    blueprint_platform = _resolve_blueprint_platform(creds, region, blueprint_id)
    bundle_platform = _resolve_bundle_platform(creds, region, bundle_id)
    if blueprint_platform != bundle_platform:
        raise BadRequest(
            f"镜像 ({blueprint_platform}) 与套餐 ({bundle_platform}) 系统类型不匹配"
        )

    # Build instance names.
    if name:
        _validate_instance_name(name)
        if count == 1:
            names = [name]
        else:
            names = [f"{name}-{i:02d}" for i in range(1, count + 1)]
            for n in names:
                _validate_instance_name(n)
    else:
        prefix = f"ls-{uuid.uuid4().hex[:8]}"
        names = [prefix] if count == 1 else [f"{prefix}-{i:02d}" for i in range(1, count + 1)]

    if az is None:
        az = _resolve_first_az(creds, region)

    # Build user-data if password provided. Windows always targets the
    # local Administrator account; Linux always targets root, distro
    # default user (ubuntu / admin / ec2-user) is irrelevant here because
    # the script sets root's password directly.
    user_data = ""
    if password:
        default_user = "Administrator" if blueprint_platform == "windows" else "root"
        user_data = build_password_user_data(blueprint_platform, default_user, password)

    ls = get_client(creds, "lightsail", region)
    kwargs: dict[str, Any] = {
        "instanceNames": names,
        "availabilityZone": az,
        "blueprintId": blueprint_id,
        "bundleId": bundle_id,
        "ipAddressType": ip_address_type,
    }
    if user_data:
        kwargs["userData"] = user_data

    try:
        ls.create_instances(**kwargs)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in {"InvalidInputException"}:
            raise BadRequest(f"参数无效: {msg}") from e
        if code in {"ServiceException", "OperationFailureException"}:
            raise BadRequest(f"创建失败: {msg}") from e
        if code in {"AccessDeniedException", "UnauthenticatedException"}:
            raise BadRequest(f"权限不足: {msg}") from e
        if code in {"AccountSetupInProgressException"}:
            raise BadRequest("账号 Lightsail 初始化尚未完成,请稍后再试") from e
        raise UpstreamError(f"create_instances failed: {code} - {msg}") from e

    # Open all ports (TCP / UDP 0-65535 + ICMP) on each new instance's
    # firewall, scoped to whatever IP family it actually has. Lightsail's
    # default is just SSH/RDP + HTTP/HTTPS, which is too restrictive for
    # personal-use IP-diversity workloads. Per-instance failures are
    # tolerated: the instance is already created and usable; the user can
    # retry the firewall open from the panel later.
    for n in names:
        try:
            _open_all_ports(creds, region, n, ip_address_type)
        except UpstreamError:
            # Instance might still be in 'pending' and not ready for
            # firewall modifications — silent; the next firewall touch
            # (or a manual one) will succeed.
            pass

    # `create_instances` only returns operations; re-describe so the caller
    # gets full instance objects.
    rows: list[dict[str, Any]] = []
    for n in names:
        try:
            resp = ls.get_instance(instanceName=n)
            inst = resp.get("instance")
            if inst:
                rows.append(_serialize_instance(inst))
        except ClientError:
            # Instance not yet visible to describe — emit a minimal stub.
            rows.append(
                {
                    "instance_name": n,
                    "display_name": n,
                    "state": "pending",
                    "public_ip": None,
                    "private_ip": None,
                    "ipv6_addresses": [],
                    "is_static_ip": False,
                    "ip_address_type": ip_address_type,
                    "region": region,
                    "az": az,
                    "bundle_id": bundle_id,
                    "blueprint_id": blueprint_id,
                    "blueprint_name": None,
                    "username": None,
                    "ssh_key_name": None,
                    "cpu_count": None,
                    "ram_gb": None,
                    "disk_gb": None,
                    "monthly_transfer_gb": None,
                    "created_at": None,
                    "tags": [],
                    "arn": None,
                }
            )
    return rows
