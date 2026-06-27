"""
boto3 client factory with execution-environment caching.

Each Lambda execution environment runs this module once; the _CACHE dict is reused
across warm invocations. Different (ak_prefix, region, service) tuples get separate
cached clients, so multi-account fan-out remains correct.

NEVER log AK/SK from this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import boto3
from botocore.config import Config

DEFAULT_CONFIG = Config(
    retries={"max_attempts": 2, "mode": "standard"},
    connect_timeout=3,
    read_timeout=15,
    user_agent_extra="aws-panel/0.1",
)

_CACHE: dict[tuple[str, str, str], Any] = {}


@dataclass(frozen=True)
class Creds:
    access_key: str
    secret_key: str
    session_token: str | None = None

    @property
    def cache_key(self) -> str:
        # First 8 chars of AK is unique enough across personal accounts
        # and never logged in full.
        return self.access_key[:8]


def get_client(creds: Creds, service: str, region: str) -> Any:
    key = (creds.cache_key, region, service)
    client = _CACHE.get(key)
    if client is None:
        client = boto3.client(
            service,
            region_name=region,
            aws_access_key_id=creds.access_key,
            aws_secret_access_key=creds.secret_key,
            aws_session_token=creds.session_token,
            config=DEFAULT_CONFIG,
        )
        _CACHE[key] = client
    return client


def clear_cache() -> None:
    """Call from tests; in production we let Lambda's lifecycle handle it."""
    _CACHE.clear()
