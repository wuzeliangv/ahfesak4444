"""
EC2 image (AMI) catalog.

Each entry describes an OS we let users launch from the create-instance modal.
At call time `resolve_ami` runs DescribeImages with the entry's name pattern
and the chosen architecture, then returns the freshest matching AMI ID.

Owners reference (so we don't reach the wrong publisher):
  - "amazon"        — Amazon Linux + Microsoft Windows (Amazon-managed)
  - "099720109477"  — Canonical (Ubuntu)
  - "136693071363"  — Debian Project
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.shared.errors import BadRequest, UpstreamError


@dataclass(frozen=True)
class ImageDef:
    """Static description of one selectable OS image."""

    slug: str
    display: str
    owner: str
    # Per-architecture DescribeImages name filter. Keys are the AWS-side arch
    # codes ('x86_64' / 'arm64'); values are the wildcard name pattern.
    name_patterns: Mapping[str, str]
    # Root device name (varies by OS — gets used in BlockDeviceMappings).
    root_device: str
    # 'linux' or 'windows' — picks the user-data dialect for password reset.
    os: str
    # Default OS user (informational; surfaced in API responses for the UI).
    default_user: str


# ---------------------------------------------------------------------------
# Catalog (slug → ImageDef)
# ---------------------------------------------------------------------------

# fmt: off
IMAGES: dict[str, ImageDef] = {
    # ---- Amazon Linux 2023 -------------------------------------------------
    "al2023": ImageDef(
        slug="al2023",
        display="Amazon Linux 2023",
        owner="amazon",
        name_patterns={
            "x86_64": "al2023-ami-2023*-x86_64",
            "arm64":  "al2023-ami-2023*-arm64",
        },
        root_device="/dev/xvda",
        os="linux",
        default_user="ec2-user",
    ),

    # ---- Ubuntu LTS --------------------------------------------------------
    "ubuntu-20.04": ImageDef(
        slug="ubuntu-20.04",
        display="Ubuntu 20.04 LTS",
        owner="099720109477",
        name_patterns={
            "x86_64": "ubuntu/images/hvm-ssd/ubuntu-focal-20.04-amd64-server-*",
            "arm64":  "ubuntu/images/hvm-ssd/ubuntu-focal-20.04-arm64-server-*",
        },
        root_device="/dev/sda1",
        os="linux",
        default_user="ubuntu",
    ),
    "ubuntu-22.04": ImageDef(
        slug="ubuntu-22.04",
        display="Ubuntu 22.04 LTS",
        owner="099720109477",
        name_patterns={
            "x86_64": "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*",
            "arm64":  "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-arm64-server-*",
        },
        root_device="/dev/sda1",
        os="linux",
        default_user="ubuntu",
    ),
    "ubuntu-24.04": ImageDef(
        slug="ubuntu-24.04",
        display="Ubuntu 24.04 LTS",
        owner="099720109477",
        # 24.04 uses the gp3 image stream
        name_patterns={
            "x86_64": "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*",
            "arm64":  "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*",
        },
        root_device="/dev/sda1",
        os="linux",
        default_user="ubuntu",
    ),

    # ---- Debian ------------------------------------------------------------
    "debian-10": ImageDef(
        slug="debian-10",
        display="Debian 10 (Buster)",
        owner="136693071363",
        name_patterns={
            "x86_64": "debian-10-amd64-*",
            "arm64":  "debian-10-arm64-*",
        },
        root_device="/dev/xvda",
        os="linux",
        default_user="admin",
    ),
    "debian-11": ImageDef(
        slug="debian-11",
        display="Debian 11 (Bullseye)",
        owner="136693071363",
        name_patterns={
            "x86_64": "debian-11-amd64-*",
            "arm64":  "debian-11-arm64-*",
        },
        root_device="/dev/xvda",
        os="linux",
        default_user="admin",
    ),
    "debian-12": ImageDef(
        slug="debian-12",
        display="Debian 12 (Bookworm)",
        owner="136693071363",
        name_patterns={
            "x86_64": "debian-12-amd64-*",
            "arm64":  "debian-12-arm64-*",
        },
        root_device="/dev/xvda",
        os="linux",
        default_user="admin",
    ),
    "debian-13": ImageDef(
        slug="debian-13",
        display="Debian 13 (Trixie)",
        owner="136693071363",
        name_patterns={
            "x86_64": "debian-13-amd64-*",
            "arm64":  "debian-13-arm64-*",
        },
        root_device="/dev/xvda",
        os="linux",
        default_user="admin",
    ),

    # ---- Windows Server (Amazon-managed, x86_64 only) ---------------------
    "win-2022-en": ImageDef(
        slug="win-2022-en",
        display="Windows Server 2022 (English, Full Base)",
        owner="amazon",
        name_patterns={"x86_64": "Windows_Server-2022-English-Full-Base-*"},
        root_device="/dev/sda1",
        os="windows",
        default_user="Administrator",
    ),
    "win-2022-zh": ImageDef(
        slug="win-2022-zh",
        display="Windows Server 2022 (Chinese Simplified, Full Base)",
        owner="amazon",
        name_patterns={"x86_64": "Windows_Server-2022-Chinese_Simplified-Full-Base-*"},
        root_device="/dev/sda1",
        os="windows",
        default_user="Administrator",
    ),
    "win-2025-en": ImageDef(
        slug="win-2025-en",
        display="Windows Server 2025 (English, Full Base)",
        owner="amazon",
        name_patterns={"x86_64": "Windows_Server-2025-English-Full-Base-*"},
        root_device="/dev/sda1",
        os="windows",
        default_user="Administrator",
    ),
}
# fmt: on


def get_image(slug: str) -> ImageDef:
    img = IMAGES.get(slug)
    if img is None:
        raise BadRequest(f"未知镜像: {slug}")
    return img


# ---------------------------------------------------------------------------
# AMI resolution
# ---------------------------------------------------------------------------


def resolve_ami(creds: Creds, region: str, slug: str, architecture: str) -> str:
    """
    Look up the newest AMI ID for `slug` × `architecture` in `region`.

    Each image has its own owner + name filter; we sort by CreationDate and
    take the freshest result. No regional hardcoded table — the AMI returned
    is always the latest one the publisher has rolled out.
    """
    img = get_image(slug)
    pattern = img.name_patterns.get(architecture)
    if pattern is None:
        raise BadRequest(
            f"镜像 {img.display} 不支持 {architecture} 架构"
        )

    ec2 = get_client(creds, "ec2", region)
    try:
        resp = ec2.describe_images(
            Owners=[img.owner],
            Filters=[
                {"Name": "name", "Values": [pattern]},
                {"Name": "state", "Values": ["available"]},
                {"Name": "virtualization-type", "Values": ["hvm"]},
                {"Name": "root-device-type", "Values": ["ebs"]},
            ],
        )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        raise UpstreamError(f"describe_images failed in {region}: {code}") from e

    images = resp.get("Images") or []
    if not images:
        raise UpstreamError(
            f"在 {region} 找不到匹配的 AMI: {img.display} ({architecture})"
        )
    images.sort(key=lambda i: i.get("CreationDate", ""), reverse=True)
    return images[0]["ImageId"]
