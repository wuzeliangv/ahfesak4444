"""
Wavelength networking + instance creation.

Launching into a Wavelength Zone needs network plumbing the default VPC
doesn't have: a Carrier Gateway, a subnet in the WL zone, and a route
table pointing 0.0.0.0/0 at the carrier gateway. We build all of it
idempotently (reuse if present) then launch an instance with a Carrier
IP (`AssociateCarrierIpAddress=True`).

Carrier IPs are reachable only through the telecom carrier's 5G network,
NOT the public internet. Practical access is via a Lightsail jump box
peered into the default VPC (see services that manage VPC peering). To
keep things order-independent, if a Lightsail peering already exists we
add the return route (Lightsail CIDR → peering) to the new WL subnet's
route table so the jump box can reach the instance immediately.

Ported from the obace/aws-glass reference implementation.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.services.ec2 import (
    _build_user_data,
    _open_all_ports,
    _resolve_default_security_group,
    _serialize_instance,
)
from src.services.images import get_image, resolve_ami
from src.shared.errors import BadRequest, UpstreamError

log = logging.getLogger(__name__)


def _default_vpc(ec2: Any) -> dict[str, Any]:
    resp = ec2.describe_vpcs(Filters=[{"Name": "is-default", "Values": ["true"]}])
    vpcs = resp.get("Vpcs", [])
    if not vpcs:
        raise BadRequest("账户在该区域没有默认 VPC,请先在 AWS 控制台创建默认 VPC")
    return vpcs[0]


def _ensure_carrier_gateway(ec2: Any, vpc_id: str) -> str:
    resp = ec2.describe_carrier_gateways(
        Filters=[{"Name": "vpc-id", "Values": [vpc_id]}]
    )
    for cg in resp.get("CarrierGateways", []):
        if cg.get("State") in ("available", "pending"):
            return cg["CarrierGatewayId"]
    cg = ec2.create_carrier_gateway(VpcId=vpc_id)
    return cg["CarrierGateway"]["CarrierGatewayId"]


def _free_cidr(ec2: Any, vpc_id: str) -> str:
    """Pick an unused /24 inside the default VPC's 172.31.0.0/16 range."""
    resp = ec2.describe_subnets(Filters=[{"Name": "vpc-id", "Values": [vpc_id]}])
    used: set[int] = set()
    for s in resp.get("Subnets", []):
        m = re.match(r"^172\.31\.(\d+)\.", s.get("CidrBlock", ""))
        if m:
            used.add(int(m.group(1)))
    third = 100
    while third in used and third < 255:
        third += 1
    if third >= 255:
        raise UpstreamError("默认 VPC 已无空闲子网段 (172.31.x.0/24)")
    return f"172.31.{third}.0/24"


def _ensure_subnet(ec2: Any, vpc_id: str, zone: str) -> str:
    resp = ec2.describe_subnets(
        Filters=[
            {"Name": "vpc-id", "Values": [vpc_id]},
            {"Name": "availability-zone", "Values": [zone]},
        ]
    )
    existing = resp.get("Subnets", [])
    if existing:
        return existing[0]["SubnetId"]
    cidr = _free_cidr(ec2, vpc_id)
    subnet = ec2.create_subnet(VpcId=vpc_id, CidrBlock=cidr, AvailabilityZone=zone)
    return subnet["Subnet"]["SubnetId"]


def _find_lightsail_peering(ec2: Any, vpc_id: str) -> tuple[str | None, str | None]:
    """Return (peering_id, lightsail_cidr) if a Lightsail peering is active."""
    peerings: list[dict[str, Any]] = []
    for f in (
        [
            {"Name": "requester-vpc-info.vpc-id", "Values": [vpc_id]},
            {"Name": "status-code", "Values": ["active"]},
        ],
        [
            {"Name": "accepter-vpc-info.vpc-id", "Values": [vpc_id]},
            {"Name": "status-code", "Values": ["active"]},
        ],
    ):
        try:
            r = ec2.describe_vpc_peering_connections(Filters=f)
            peerings.extend(r.get("VpcPeeringConnections", []))
        except ClientError:
            pass
    for p in peerings:
        req = p.get("RequesterVpcInfo") or {}
        acc = p.get("AccepterVpcInfo") or {}
        peer = acc if req.get("VpcId") == vpc_id else req
        cidrs = [c.get("CidrBlock") for c in (peer.get("CidrBlockSet") or [])]
        if cidrs and peer.get("VpcId") != vpc_id:
            return p["VpcPeeringConnectionId"], cidrs[0]
    return None, None


def _ensure_route_table(
    ec2: Any, vpc_id: str, subnet_id: str, carrier_gateway_id: str
) -> None:
    """Ensure the WL subnet has a route table with 0.0.0.0/0 → carrier GW.

    If a Lightsail peering already exists, also add the return route
    (Lightsail CIDR → peering) so a jump box can reach the instance
    regardless of setup order.
    """
    rts = ec2.describe_route_tables(
        Filters=[{"Name": "association.subnet-id", "Values": [subnet_id]}]
    ).get("RouteTables", [])

    has_carrier = any(
        r.get("CarrierGatewayId") and r.get("DestinationCidrBlock") == "0.0.0.0/0"
        for rt in rts
        for r in rt.get("Routes", [])
    )

    if has_carrier:
        rt_id = rts[0]["RouteTableId"]
    else:
        rt = ec2.create_route_table(VpcId=vpc_id)
        rt_id = rt["RouteTable"]["RouteTableId"]
        ec2.create_route(
            RouteTableId=rt_id,
            DestinationCidrBlock="0.0.0.0/0",
            CarrierGatewayId=carrier_gateway_id,
        )
        ec2.associate_route_table(RouteTableId=rt_id, SubnetId=subnet_id)

    # Forward-compat: wire the Lightsail return route if peering exists.
    peering_id, ls_cidr = _find_lightsail_peering(ec2, vpc_id)
    if peering_id and ls_cidr:
        cur = ec2.describe_route_tables(
            RouteTableIds=[rt_id]
        )["RouteTables"][0]
        if not any(
            r.get("DestinationCidrBlock") == ls_cidr for r in cur.get("Routes", [])
        ):
            try:
                ec2.create_route(
                    RouteTableId=rt_id,
                    DestinationCidrBlock=ls_cidr,
                    VpcPeeringConnectionId=peering_id,
                )
            except ClientError as e:
                log.warning("failed to add lightsail return route: %s", e)


def create_wavelength_instance(
    creds: Creds,
    region: str,
    zone: str,
    instance_type: str,
    *,
    architecture: str = "x86_64",
    image: str = "ubuntu-24.04",
    name: str | None = None,
    password: str | None = None,
    storage_gb: int = 30,
) -> list[dict[str, Any]]:
    """One-click Wavelength launch: build network + run an instance."""
    if not zone:
        raise BadRequest("missing wavelength zone")

    ec2 = get_client(creds, "ec2", region)
    image_def = get_image(image)
    image_id = resolve_ami(creds, region, image, architecture)

    try:
        vpc = _default_vpc(ec2)
        vpc_id = vpc["VpcId"]
        cg_id = _ensure_carrier_gateway(ec2, vpc_id)
        subnet_id = _ensure_subnet(ec2, vpc_id, zone)
        _ensure_route_table(ec2, vpc_id, subnet_id, cg_id)

        sg_id = _resolve_default_security_group(creds, region, vpc_id)
        _open_all_ports(creds, region, sg_id)

        kwargs: dict[str, Any] = {
            "ImageId": image_id,
            "InstanceType": instance_type,
            "MinCount": 1,
            "MaxCount": 1,
            "NetworkInterfaces": [
                {
                    "DeviceIndex": 0,
                    "SubnetId": subnet_id,
                    "Groups": [sg_id],
                    "AssociateCarrierIpAddress": True,
                }
            ],
            "BlockDeviceMappings": [
                {
                    "DeviceName": image_def.root_device,
                    "Ebs": {
                        "VolumeSize": int(storage_gb),
                        # Wavelength Zones don't support gp3 — only gp2.
                        "VolumeType": "gp2",
                        "DeleteOnTermination": True,
                    },
                }
            ],
        }
        if name:
            kwargs["TagSpecifications"] = [
                {"ResourceType": "instance", "Tags": [{"Key": "Name", "Value": name}]}
            ]
        if password:
            kwargs["UserData"] = _build_user_data(image_def, password)

        resp = ec2.run_instances(**kwargs)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in {"OptInRequired", "UnauthorizedOperation"}:
            raise BadRequest(
                f"该 Wavelength 区未启用或权限不足: {msg} (请先在「启用地区」中开启该区)"
            ) from e
        if code in {"InvalidParameterValue", "InvalidParameterCombination", "Unsupported"}:
            raise BadRequest(f"参数无效或该区不支持此机型: {msg}") from e
        if code in {"VcpuLimitExceeded", "InstanceLimitExceeded"}:
            raise BadRequest(f"配额不足: {msg}") from e
        raise UpstreamError(f"wavelength run_instances failed: {code} - {msg}") from e

    instances = resp.get("Instances", [])
    return [_serialize_instance(i, region) for i in instances]


# ---------------------------------------------------------------------------
# Lightsail VPC peering — lets a Lightsail jump box reach instances (incl.
# Wavelength) in the account's default VPC over private IPs.
# ---------------------------------------------------------------------------


def _find_default_vpc(ec2: Any) -> dict[str, Any] | None:
    resp = ec2.describe_vpcs(Filters=[{"Name": "is-default", "Values": ["true"]}])
    vpcs = resp.get("Vpcs", [])
    return vpcs[0] if vpcs else None


def _lightsail_peering(ec2: Any, vpc_id: str) -> tuple[str | None, str | None]:
    """Return (peering_id, lightsail_cidr) of the active Lightsail peering."""
    return _find_lightsail_peering(ec2, vpc_id)


def get_peering_status(creds: Creds, region: str) -> dict[str, Any]:
    """Report whether Lightsail VPC peering + the default-VPC routes are set."""
    ec2 = get_client(creds, "ec2", region)
    ls = get_client(creds, "lightsail", region)

    ls_peered = False
    try:
        ls_peered = bool(ls.is_vpc_peered().get("isPeered", False))
    except ClientError as e:
        log.warning("is_vpc_peered failed: %s", e)

    # Lightsail VPC peering can only be enabled in a region that already has
    # at least one Lightsail resource — otherwise AWS has no Lightsail VPC to
    # peer (the console greys out the button). Surface this so the UI can
    # tell the user to create a Lightsail instance first.
    has_lightsail = False
    try:
        has_lightsail = len(ls.get_instances().get("instances", [])) > 0
    except ClientError as e:
        log.warning("get_instances failed: %s", e)

    vpc = _find_default_vpc(ec2)
    if not vpc:
        return {
            "region": region,
            "ls_peered": ls_peered,
            "has_lightsail": has_lightsail,
            "no_default_vpc": True,
            "peering_id": None,
            "ls_cidr": None,
            "routes_ok": False,
            "route_tables_total": 0,
            "route_tables_with_route": 0,
        }
    vpc_id = vpc["VpcId"]

    peering_id, ls_cidr = _lightsail_peering(ec2, vpc_id)

    total = 0
    with_route = 0
    if ls_cidr:
        rts = ec2.describe_route_tables(
            Filters=[{"Name": "vpc-id", "Values": [vpc_id]}]
        ).get("RouteTables", [])
        total = len(rts)
        for rt in rts:
            if any(
                r.get("DestinationCidrBlock") == ls_cidr and r.get("VpcPeeringConnectionId")
                for r in rt.get("Routes", [])
            ):
                with_route += 1

    routes_ok = bool(ls_cidr) and total > 0 and with_route == total
    return {
        "region": region,
        "ls_peered": ls_peered,
        "has_lightsail": has_lightsail,
        "no_default_vpc": False,
        "peering_id": peering_id,
        "ls_cidr": ls_cidr,
        "routes_ok": routes_ok,
        "route_tables_total": total,
        "route_tables_with_route": with_route,
    }


def setup_peering(creds: Creds, region: str) -> dict[str, Any]:
    """One-click: enable Lightsail peering + add return routes to every
    route table in the default VPC (idempotent / re-runnable)."""
    import time

    ec2 = get_client(creds, "ec2", region)
    ls = get_client(creds, "lightsail", region)
    steps: list[str] = []

    # Pre-check: Lightsail peering requires at least one Lightsail resource
    # in the region (no resource → no Lightsail VPC to peer).
    try:
        if len(ls.get_instances().get("instances", [])) == 0:
            raise BadRequest(
                "该区域还没有 Lightsail 机器,请先在此区域创建一台 Lightsail 机器,"
                "再开启对等连接。"
            )
    except ClientError as e:
        log.warning("get_instances pre-check failed: %s", e)

    # 1. Enable Lightsail VPC peering.
    try:
        ls.peer_vpc()
        steps.append("已开启 Lightsail VPC 对等连接")
    except ClientError as e:
        msg = e.response.get("Error", {}).get("Message", str(e))
        low = msg.lower()
        if "already" in low or "peered" in low:
            steps.append("Lightsail 对等连接已存在")
        elif "no resources" in low or "not found" in low or "does not have" in low:
            raise BadRequest(
                "该区域还没有 Lightsail 机器,请先创建一台 Lightsail 机器再开启对等连接。"
            ) from e
        else:
            raise BadRequest(f"开启 Lightsail 对等失败: {msg}") from e

    time.sleep(3)

    vpc = _find_default_vpc(ec2)
    if not vpc:
        raise BadRequest("账户在该区域没有默认 VPC")
    vpc_id = vpc["VpcId"]

    # 2. Find the Lightsail peering connection + its CIDR (retry a few times,
    #    AWS provisions it asynchronously).
    peering_id: str | None = None
    ls_cidr: str | None = None
    for _ in range(5):
        peering_id, ls_cidr = _lightsail_peering(ec2, vpc_id)
        if peering_id and ls_cidr:
            break
        time.sleep(2)
    if not peering_id or not ls_cidr:
        raise UpstreamError("未找到 Lightsail 对等连接,请稍后重试")
    steps.append(f"对等连接: {peering_id} (Lightsail CIDR {ls_cidr})")

    # 3. Add the Lightsail-CIDR → peering route to every route table in the
    #    default VPC (including Wavelength/Local subnet route tables).
    rts = ec2.describe_route_tables(
        Filters=[{"Name": "vpc-id", "Values": [vpc_id]}]
    ).get("RouteTables", [])
    added = 0
    skipped = 0
    for rt in rts:
        rt_id = rt["RouteTableId"]
        if any(r.get("DestinationCidrBlock") == ls_cidr for r in rt.get("Routes", [])):
            skipped += 1
            continue
        try:
            ec2.create_route(
                RouteTableId=rt_id,
                DestinationCidrBlock=ls_cidr,
                VpcPeeringConnectionId=peering_id,
            )
            added += 1
        except ClientError as e:
            log.warning("create_route on %s failed: %s", rt_id, e)
    steps.append(f"路由表: 新增 {added} 条, 已存在 {skipped} 条")

    return {
        "region": region,
        "peering_id": peering_id,
        "ls_cidr": ls_cidr,
        "added": added,
        "skipped": skipped,
        "steps": steps,
    }
