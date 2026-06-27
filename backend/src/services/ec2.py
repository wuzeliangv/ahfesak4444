"""
EC2 service — list, start/stop/reboot, terminate.

Patterns:
  - list_all_regions:  async fan-out across opted-in regions (the main UI call)
  - list_region:       sync single-region (for refresh-after-action)
  - control actions:   sync, return new state immediately

We deliberately do NOT block the Lambda waiting for state transitions.
'Change IP' workflows are orchestrated by the frontend: stop → poll → start.
This keeps every Lambda call <5s and avoids API Gateway 29s timeout.
"""

from __future__ import annotations

import asyncio
from typing import Any, Iterable

import aioboto3
from botocore.config import Config
from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.services.images import ImageDef, get_image, resolve_ami
from src.services.user_data import build_password_user_data
from src.shared.errors import BadRequest, NotFound, UpstreamError
from src.shared.regions import list_opted_in_regions

_ASYNC_CFG = Config(
    retries={"max_attempts": 2, "mode": "standard"},
    connect_timeout=3,
    read_timeout=10,
)


def _name_from_tags(tags: list[dict[str, str]] | None) -> str | None:
    if not tags:
        return None
    for t in tags:
        if t.get("Key") == "Name":
            return t.get("Value")
    return None


def _public_ip_type(i: dict[str, Any]) -> str | None:
    """
    Classify the instance's public IP as 'static' (EIP) or 'dynamic'.

    AWS marks the address association's IpOwnerId as 'amazon' for the
    auto-assigned public IP that changes on stop/start, and as the AWS
    account ID (12-digit numeric string) when an Elastic IP is attached.

    Returns None when the instance has no public IP at all.
    """
    if not i.get("PublicIpAddress"):
        return None
    for ni in i.get("NetworkInterfaces") or []:
        assoc = ni.get("Association") or {}
        owner = assoc.get("IpOwnerId")
        if not owner:
            continue
        # 'amazon' → AWS-owned auto-assigned IPv4; anything else → EIP
        return "dynamic" if owner == "amazon" else "static"
    # Has a public IP but no NetworkInterfaces info → assume dynamic
    return "dynamic"


def _serialize_instance(i: dict[str, Any], region: str) -> dict[str, Any]:
    """Convert raw boto3 instance dict into a UI-friendly subset."""
    # Collect every Ipv6 address from every network interface. Most
    # instances will have 0 or 1; dualstack ENIs sometimes report more.
    ipv6_addresses: list[str] = []
    carrier_ip: str | None = None
    for ni in i.get("NetworkInterfaces") or []:
        for ipv6 in ni.get("Ipv6Addresses") or []:
            addr = ipv6.get("Ipv6Address")
            if addr:
                ipv6_addresses.append(addr)
        # Wavelength instances expose a Carrier IP (reachable only via the
        # telecom carrier's 5G network) instead of a regular public IPv4.
        assoc = ni.get("Association") or {}
        if assoc.get("CarrierIp"):
            carrier_ip = assoc["CarrierIp"]

    public_ip = i.get("PublicIpAddress")
    public_ip_type = _public_ip_type(i)
    # No regular public IP but has a carrier IP → surface it as the public
    # address with a distinct 'carrier' type so the UI can label it and
    # hide the change-IP action (carrier IPs aren't internet-reachable).
    if not public_ip and carrier_ip:
        public_ip = carrier_ip
        public_ip_type = "carrier"

    return {
        "instance_id": i["InstanceId"],
        "name": _name_from_tags(i.get("Tags")),
        "type": i["InstanceType"],
        "state": i["State"]["Name"],
        "public_ip": public_ip,
        "public_ip_type": public_ip_type,
        "private_ip": i.get("PrivateIpAddress"),
        "ipv6_addresses": ipv6_addresses,
        "public_dns": i.get("PublicDnsName") or None,
        "region": region,
        "az": i.get("Placement", {}).get("AvailabilityZone"),
        "platform": i.get("PlatformDetails", "Linux/UNIX"),
        "architecture": i.get("Architecture"),
        "launch_time": i.get("LaunchTime"),
        "key_name": i.get("KeyName"),
        "image_id": i.get("ImageId"),
        "vpc_id": i.get("VpcId"),
        "subnet_id": i.get("SubnetId"),
        "security_groups": [sg["GroupName"] for sg in i.get("SecurityGroups", [])],
    }


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------


def list_region(creds: Creds, region: str) -> list[dict[str, Any]]:
    """List EC2 instances in one region, sync."""
    ec2 = get_client(creds, "ec2", region)
    try:
        rows: list[dict[str, Any]] = []
        for page in ec2.get_paginator("describe_instances").paginate():
            for resv in page["Reservations"]:
                for inst in resv["Instances"]:
                    rows.append(_serialize_instance(inst, region))
        return rows
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        raise UpstreamError(f"describe_instances failed in {region}: {code}") from e


def describe_instances_batch(
    creds: Creds, region: str, instance_ids: list[str]
) -> list[dict[str, Any]]:
    """
    Describe a known set of instances in one region.

    Used by the frontend's transient-state poller — it knows exactly which
    instances are in `pending` / `stopping` / `shutting-down` and only wants
    those, so we skip the full-region paginated scan and call
    DescribeInstances with `InstanceIds=[...]`. AWS treats unknown IDs as a
    hard error (`InvalidInstanceID.NotFound`), which here means an instance
    has been fully reaped — we filter those out and return whatever's left.
    """
    if not instance_ids:
        return []
    ec2 = get_client(creds, "ec2", region)
    try:
        resp = ec2.describe_instances(InstanceIds=instance_ids)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        # If even one of the IDs is gone, AWS rejects the whole call. Fall
        # back to filtering the gone ones out and retrying with the rest so
        # the poller still gets useful data instead of an error.
        if code == "InvalidInstanceID.NotFound":
            msg = e.response.get("Error", {}).get("Message", "")
            # Message looks like:
            #   "The instance IDs 'i-aaa, i-bbb' do not exist"
            # — pluck the IDs out and remove them from our list.
            import re

            missing = set(re.findall(r"i-[0-9a-f]+", msg))
            remaining = [i for i in instance_ids if i not in missing]
            if not remaining:
                return []
            try:
                resp = ec2.describe_instances(InstanceIds=remaining)
            except ClientError as e2:
                code2 = e2.response.get("Error", {}).get("Code", "Unknown")
                raise UpstreamError(
                    f"describe_instances retry failed in {region}: {code2}"
                ) from e2
        else:
            raise UpstreamError(
                f"describe_instances failed in {region}: {code}"
            ) from e

    rows: list[dict[str, Any]] = []
    for resv in resp.get("Reservations", []):
        for inst in resv.get("Instances", []):
            rows.append(_serialize_instance(inst, region))
    return rows


async def _list_one_async(
    session: aioboto3.Session,
    creds: Creds,
    region: str,
) -> tuple[str, list[dict[str, Any]] | None, str | None]:
    """Returns (region, instances, error_code). instances is None on failure."""
    try:
        async with session.client(
            "ec2",
            region_name=region,
            aws_access_key_id=creds.access_key,
            aws_secret_access_key=creds.secret_key,
            aws_session_token=creds.session_token,
            config=_ASYNC_CFG,
        ) as ec2:
            paginator = ec2.get_paginator("describe_instances")
            rows: list[dict[str, Any]] = []
            async for page in paginator.paginate():
                for resv in page["Reservations"]:
                    for inst in resv["Instances"]:
                        rows.append(_serialize_instance(inst, region))
            return region, rows, None
    except ClientError as e:
        return region, None, e.response.get("Error", {}).get("Code", "Unknown")
    except Exception as e:  # noqa: BLE001
        return region, None, type(e).__name__


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

    instances.sort(key=lambda x: (x["region"], x["instance_id"]))
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
    """Fan-out across all opted-in regions concurrently."""
    if regions is None:
        regions = list_opted_in_regions(creds)
    return asyncio.run(_list_all_async(creds, regions))


# ---------------------------------------------------------------------------
# Control actions
# ---------------------------------------------------------------------------


def _classify_action_error(e: ClientError, action: str, instance_id: str) -> Exception:
    code = e.response.get("Error", {}).get("Code", "Unknown")
    msg = e.response.get("Error", {}).get("Message", str(e))
    if code in {"InvalidInstanceID.NotFound", "InvalidInstanceID.Malformed"}:
        return NotFound(f"instance {instance_id} not found")
    if code == "IncorrectInstanceState":
        return BadRequest(f"cannot {action} instance in current state: {msg}")
    return UpstreamError(f"{action} failed: {code} - {msg}")


def start_instance(creds: Creds, region: str, instance_id: str) -> dict[str, Any]:
    ec2 = get_client(creds, "ec2", region)
    try:
        resp = ec2.start_instances(InstanceIds=[instance_id])
    except ClientError as e:
        raise _classify_action_error(e, "start", instance_id) from e
    state = resp["StartingInstances"][0]
    return {
        "instance_id": state["InstanceId"],
        "previous_state": state["PreviousState"]["Name"],
        "current_state": state["CurrentState"]["Name"],
    }


def stop_instance(creds: Creds, region: str, instance_id: str, *, force: bool = False) -> dict[str, Any]:
    ec2 = get_client(creds, "ec2", region)
    try:
        resp = ec2.stop_instances(InstanceIds=[instance_id], Force=force)
    except ClientError as e:
        raise _classify_action_error(e, "stop", instance_id) from e
    state = resp["StoppingInstances"][0]
    return {
        "instance_id": state["InstanceId"],
        "previous_state": state["PreviousState"]["Name"],
        "current_state": state["CurrentState"]["Name"],
    }


def reboot_instance(creds: Creds, region: str, instance_id: str) -> dict[str, Any]:
    ec2 = get_client(creds, "ec2", region)
    try:
        ec2.reboot_instances(InstanceIds=[instance_id])
    except ClientError as e:
        raise _classify_action_error(e, "reboot", instance_id) from e
    # reboot_instances returns no body
    return {"instance_id": instance_id, "current_state": "rebooting"}


def _release_address_with_retry(
    ec2: Any, allocation_id: str, network_border_group: str | None
) -> None:
    """Release an EIP/carrier address, retrying while AWS still reports it in use."""
    import time

    if not allocation_id:
        return
    primary = {"AllocationId": allocation_id}
    if network_border_group:
        primary["NetworkBorderGroup"] = network_border_group
    last_err: Exception | None = None
    for i in range(4):
        try:
            ec2.release_address(**primary)
            return
        except ClientError as e:
            last_err = e
            code = e.response.get("Error", {}).get("Code", "")
            msg = e.response.get("Error", {}).get("Message", "")
            retryable = code in (
                "InvalidIPAddress.InUse",
                "InvalidAddress.Locked",
            ) or any(s in msg.lower() for s in ("in use", "associated", "currently in use"))
            if not retryable:
                break
            time.sleep(1.2 * (i + 1))
    # Fallback: retry without the network-border-group qualifier.
    if network_border_group:
        try:
            ec2.release_address(AllocationId=allocation_id)
            return
        except ClientError as e:
            last_err = e
    if last_err:
        raise last_err


def _change_carrier_ip(
    ec2: Any, instance_id: str, eni: dict[str, Any], az: str
) -> dict[str, Any]:
    """Rotate a Wavelength instance's Carrier IP.

    Mirrors the EIP juggle but allocates from the Wavelength zone's network
    border group so the new address is a Carrier IP. Handles both a
    statically-attached carrier EIP and the dynamic auto-assigned case.
    """
    import time

    eni_id = eni["NetworkInterfaceId"]
    private_ip = eni.get("PrivateIpAddress")
    nbg = az  # for Wavelength, network-border-group == the wlz AZ name
    old_ip = (eni.get("Association") or {}).get("CarrierIp")

    # Is there a statically-allocated carrier EIP on this ENI?
    try:
        addrs = ec2.describe_addresses(
            Filters=[{"Name": "network-interface-id", "Values": [eni_id]}]
        ).get("Addresses", [])
    except ClientError:
        addrs = []
    existing = addrs[0] if addrs else None

    try:
        if existing:
            # Static: disassociate → release → allocate new → associate.
            if existing.get("AssociationId"):
                ec2.disassociate_address(AssociationId=existing["AssociationId"])
            _release_address_with_retry(
                ec2, existing.get("AllocationId"), existing.get("NetworkBorderGroup") or nbg
            )
            alloc = ec2.allocate_address(Domain="vpc", NetworkBorderGroup=nbg)
            assoc_kwargs = {
                "AllocationId": alloc["AllocationId"],
                "NetworkInterfaceId": eni_id,
            }
            if private_ip:
                assoc_kwargs["PrivateIpAddress"] = private_ip
            ec2.associate_address(**assoc_kwargs)
            new_ip = alloc.get("CarrierIp") or alloc.get("PublicIp")
        else:
            # Dynamic: allocate temp carrier EIP → associate → disassociate →
            # release, which leaves the instance with a fresh dynamic carrier IP.
            alloc = ec2.allocate_address(Domain="vpc", NetworkBorderGroup=nbg)
            try:
                assoc_kwargs = {
                    "AllocationId": alloc["AllocationId"],
                    "NetworkInterfaceId": eni_id,
                }
                if private_ip:
                    assoc_kwargs["PrivateIpAddress"] = private_ip
                a = ec2.associate_address(**assoc_kwargs)
                ec2.disassociate_address(AssociationId=a["AssociationId"])
                _release_address_with_retry(
                    ec2, alloc["AllocationId"], alloc.get("NetworkBorderGroup") or nbg
                )
            except ClientError:
                try:
                    _release_address_with_retry(
                        ec2, alloc["AllocationId"], alloc.get("NetworkBorderGroup") or nbg
                    )
                except ClientError:
                    pass
                raise
            time.sleep(2)
            d = ec2.describe_instances(InstanceIds=[instance_id])
            ni = (d["Reservations"][0]["Instances"][0].get("NetworkInterfaces") or [{}])[0]
            new_ip = (ni.get("Association") or {}).get("CarrierIp")
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in {"AddressLimitExceeded"}:
            raise BadRequest("弹性 IP 配额已满,无法分配新的运营商 IP") from e
        raise UpstreamError(f"carrier IP change failed: {code} - {msg}") from e

    return {"instance_id": instance_id, "previous_ip": old_ip, "current_ip": new_ip}


def change_public_ip(creds: Creds, region: str, instance_id: str) -> dict[str, Any]:
    """
    Replace the auto-assigned public IPv4 of a running instance **without
    stopping it** (AWS feature shipped 2024-04).

    Flow: look up the primary ENI → set AssociatePublicIpAddress=False (IP
    detaches) → re-set True (AWS allocates a new IP). The instance stays
    running the entire time; only the public ingress IP changes.

    Caveats handled here:
      - Instance with an Elastic IP can't use this path — reject with a
        clear BadRequest so the UI can suggest the EIP juggle instead.
      - Instance with no current public IP (rare for our use case) still
        works: skip the detach, just attach.
    """
    import time

    ec2 = get_client(creds, "ec2", region)
    try:
        resp = ec2.describe_instances(InstanceIds=[instance_id])
    except ClientError as e:
        raise _classify_action_error(e, "change-ip", instance_id) from e

    reservations = resp.get("Reservations") or []
    if not reservations or not reservations[0].get("Instances"):
        raise NotFound(f"instance {instance_id} not found")
    inst = reservations[0]["Instances"][0]

    nis = inst.get("NetworkInterfaces") or []
    if not nis:
        raise UpstreamError("实例没有可识别的主网卡 (ENI),无法换 IP")
    # Primary ENI is DeviceIndex 0.
    primary = next(
        (n for n in nis if n.get("Attachment", {}).get("DeviceIndex") == 0),
        nis[0],
    )
    eni_id = primary["NetworkInterfaceId"]

    # Wavelength instances use Carrier IPs, which the AssociatePublicIpAddress
    # toggle can't rotate — they need the allocate→associate→release dance
    # with NetworkBorderGroup set to the WL zone. Detect by AZ ('...wlz...').
    az = (inst.get("Placement") or {}).get("AvailabilityZone") or ""
    if "wlz" in az:
        return _change_carrier_ip(ec2, instance_id, primary, az)

    old_ip = inst.get("PublicIpAddress")
    assoc = primary.get("Association") or {}
    owner = assoc.get("IpOwnerId")
    if owner and owner != "amazon":
        # IpOwnerId == AWS account ID ⇒ Elastic IP attached.
        raise BadRequest(
            "该实例已绑定弹性 IP (EIP),无法用动态摘挂换 IP。"
            "请改用 EIP 解绑→释放→重新分配的方式。"
        )

    # Detach the auto-assigned IP (only if there is one).
    try:
        if old_ip:
            ec2.modify_network_interface_attribute(
                NetworkInterfaceId=eni_id,
                AssociatePublicIpAddress=False,
            )
            # AWS needs a brief moment to release the address back to its pool
            # before it'll allocate a fresh one. 2 seconds is conservative.
            time.sleep(2)
        # Attach a new auto-assigned IP.
        ec2.modify_network_interface_attribute(
            NetworkInterfaceId=eni_id,
            AssociatePublicIpAddress=True,
        )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code == "InvalidParameterValue" and "AssociatePublicIpAddress" in msg:
            # boto3 / botocore is too old to know this parameter.
            raise UpstreamError(
                "Lambda 运行环境的 boto3 版本过旧,不支持动态换 IP。请重新部署后端。"
            ) from e
        raise UpstreamError(f"modify_network_interface_attribute failed: {code} - {msg}") from e

    # Re-describe to surface the brand-new IP back to the UI.
    try:
        resp2 = ec2.describe_instances(InstanceIds=[instance_id])
        new_inst = resp2["Reservations"][0]["Instances"][0]
        new_ip = new_inst.get("PublicIpAddress")
    except ClientError:
        new_ip = None

    return {
        "instance_id": instance_id,
        "previous_ip": old_ip,
        "current_ip": new_ip,
    }


def rename_instance(creds: Creds, region: str, instance_id: str, name: str) -> dict[str, Any]:
    """
    Set/replace the Name tag on an instance.

    `create_tags` is upsert-style: if Name already exists, it is overwritten;
    if not, it is created. Empty `name` deletes the tag instead (so the UI
    can clear it).
    """
    ec2 = get_client(creds, "ec2", region)
    try:
        if name == "":
            ec2.delete_tags(Resources=[instance_id], Tags=[{"Key": "Name"}])
            return {"instance_id": instance_id, "name": None}
        ec2.create_tags(Resources=[instance_id], Tags=[{"Key": "Name", "Value": name}])
    except ClientError as e:
        raise _classify_action_error(e, "rename", instance_id) from e
    return {"instance_id": instance_id, "name": name}


# ---------------------------------------------------------------------------
# Create instance
# ---------------------------------------------------------------------------


def _resolve_default_security_group(creds: Creds, region: str, vpc_id: str | None = None) -> str:
    """Find the 'default' security group ID in the (default) VPC for `region`."""
    ec2 = get_client(creds, "ec2", region)
    filters: list[dict[str, Any]] = [{"Name": "group-name", "Values": ["default"]}]
    if vpc_id:
        filters.append({"Name": "vpc-id", "Values": [vpc_id]})
    try:
        resp = ec2.describe_security_groups(Filters=filters)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        raise UpstreamError(f"describe_security_groups failed: {code}") from e
    groups = resp.get("SecurityGroups") or []
    if not groups:
        raise UpstreamError(f"no default security group found in {region}")
    return groups[0]["GroupId"]


def _open_all_ports(creds: Creds, region: str, sg_id: str) -> None:
    """
    Idempotently add 'allow all from 0.0.0.0/0 + ::/0' inbound rules to `sg_id`.

    Covers TCP 0-65535, UDP 0-65535, ICMP (v4) and ICMPv6. Each protocol is
    authorized in a separate call so a pre-existing rule on one protocol
    doesn't abort the whole batch — duplicates raise InvalidPermission.Duplicate
    which we catch and ignore.
    """
    ec2 = get_client(creds, "ec2", region)
    desc = "aws-panel: open all"

    permissions: list[dict[str, Any]] = [
        {
            "IpProtocol": "tcp",
            "FromPort": 0,
            "ToPort": 65535,
            "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": desc}],
            "Ipv6Ranges": [{"CidrIpv6": "::/0", "Description": desc}],
        },
        {
            "IpProtocol": "udp",
            "FromPort": 0,
            "ToPort": 65535,
            "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": desc}],
            "Ipv6Ranges": [{"CidrIpv6": "::/0", "Description": desc}],
        },
        {
            "IpProtocol": "icmp",
            "FromPort": -1,
            "ToPort": -1,
            "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": desc}],
        },
        {
            "IpProtocol": "icmpv6",
            "FromPort": -1,
            "ToPort": -1,
            "Ipv6Ranges": [{"CidrIpv6": "::/0", "Description": desc}],
        },
    ]

    for perm in permissions:
        try:
            ec2.authorize_security_group_ingress(GroupId=sg_id, IpPermissions=[perm])
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            # Duplicate = rule already present; treat as success.
            if code == "InvalidPermission.Duplicate":
                continue
            # Anything else (perm issue, malformed, etc.) is worth surfacing.
            msg = e.response.get("Error", {}).get("Message", str(e))
            raise UpstreamError(f"authorize_security_group_ingress failed: {code} - {msg}") from e


def _build_user_data(image: ImageDef, password: str) -> str:
    """
    Thin shim over the shared password-injection builder so existing callers
    keep working. New code should call `build_password_user_data` directly.
    """
    return build_password_user_data(image.os, image.default_user, password)


def create_instance(
    creds: Creds,
    region: str,
    instance_type: str,
    architecture: str = "x86_64",
    *,
    image: str = "al2023",
    name: str | None = None,
    password: str | None = None,
    key_name: str | None = None,
    security_group_ids: list[str] | None = None,
    subnet_id: str | None = None,
    availability_zone: str | None = None,
    storage_gb: int = 8,
    image_id: str | None = None,
    count: int = 1,
) -> list[dict[str, Any]]:
    """
    Launch `count` EC2 instances with sensible defaults.

    `image` is a slug from `services.images.IMAGES` (e.g. 'ubuntu-22.04'). If
    `image_id` is also given it wins — useful for advanced/custom AMIs.

    Returns the list of created instance dicts (one entry when count==1).
    """
    if count < 1 or count > 10:
        raise BadRequest("count must be between 1 and 10")

    image_def = get_image(image)
    if image_def.os == "windows" and architecture == "arm64":
        raise BadRequest("Windows 镜像不支持 arm64 架构,请改用 x86_64 实例型号")

    if image_id is None:
        image_id = resolve_ami(creds, region, image, architecture)
    if not security_group_ids:
        # Fall back to the account's default SG and, since users typically
        # expect "machine just works" out of the box, idempotently open all
        # ports on it (TCP/UDP 0-65535 + ICMP, v4 + v6). Skipped entirely
        # when the caller provided their own SG.
        default_sg = _resolve_default_security_group(creds, region)
        _open_all_ports(creds, region, default_sg)
        security_group_ids = [default_sg]

    ec2 = get_client(creds, "ec2", region)

    kwargs: dict[str, Any] = {
        "ImageId": image_id,
        "InstanceType": instance_type,
        "MinCount": count,
        "MaxCount": count,
        "BlockDeviceMappings": [
            {
                "DeviceName": image_def.root_device,
                "Ebs": {
                    "VolumeSize": int(storage_gb),
                    "VolumeType": "gp3",
                    "DeleteOnTermination": True,
                },
            }
        ],
        "SecurityGroupIds": security_group_ids,
    }
    if name:
        if count == 1:
            kwargs["TagSpecifications"] = [
                {
                    "ResourceType": "instance",
                    "Tags": [{"Key": "Name", "Value": name}],
                }
            ]
    if key_name:
        kwargs["KeyName"] = key_name
    if subnet_id:
        kwargs["SubnetId"] = subnet_id
    if availability_zone:
        # Pin the launch to a specific AZ. With a default VPC, AWS picks the
        # AZ's default subnet automatically. Ignored if a subnet was given
        # explicitly (the subnet already determines the AZ).
        if not subnet_id:
            kwargs["Placement"] = {"AvailabilityZone": availability_zone}
    if password:
        kwargs["UserData"] = _build_user_data(image_def, password)

    try:
        resp = ec2.run_instances(**kwargs)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in {"InvalidKeyPair.NotFound", "InvalidKeyPair.Format"}:
            raise BadRequest(f"密钥对不存在: {msg}") from e
        if code in {"InvalidAMIID.NotFound", "InvalidAMIID.Malformed", "InvalidAMIID.Unavailable"}:
            raise BadRequest(f"AMI 无效: {msg}") from e
        if code in {
            "InvalidParameterValue",
            "InvalidParameterCombination",
            "InvalidGroup.NotFound",
            "InvalidSubnet",
            "InvalidSubnetID.NotFound",
        }:
            raise BadRequest(f"参数无效: {msg}") from e
        if code in {"VcpuLimitExceeded", "InstanceLimitExceeded", "MaxIOPSLimitExceeded"}:
            raise BadRequest(f"配额不足: {msg}") from e
        if code in {"UnauthorizedOperation", "OptInRequired"}:
            raise BadRequest(f"权限不足或区域未开通: {msg}") from e
        raise UpstreamError(f"run_instances failed: {code} - {msg}") from e

    instances = resp.get("Instances", [])

    if name and count > 1 and instances:
        for idx, inst in enumerate(instances, start=1):
            tag_value = f"{name}-{idx:02d}"
            try:
                ec2.create_tags(
                    Resources=[inst["InstanceId"]],
                    Tags=[{"Key": "Name", "Value": tag_value}],
                )
                inst.setdefault("Tags", []).append({"Key": "Name", "Value": tag_value})
            except ClientError:
                pass

    return [_serialize_instance(i, region) for i in instances]


def terminate_instance(creds: Creds, region: str, instance_id: str) -> dict[str, Any]:
    ec2 = get_client(creds, "ec2", region)
    try:
        resp = ec2.terminate_instances(InstanceIds=[instance_id])
    except ClientError as e:
        raise _classify_action_error(e, "terminate", instance_id) from e
    state = resp["TerminatingInstances"][0]
    return {
        "instance_id": state["InstanceId"],
        "previous_state": state["PreviousState"]["Name"],
        "current_state": state["CurrentState"]["Name"],
    }
