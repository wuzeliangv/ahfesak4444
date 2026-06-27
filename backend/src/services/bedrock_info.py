"""
Bedrock permissions panel — data for the BedrockModal.

For each surfaced model (SageMaker notebook + 3 Claude Opus versions) we
return BOTH:

  - `applied`  — the value AWS has actually granted this account in this
                 region. May be 0 for new accounts that AWS hasn't seeded
                 yet, or higher than default if the user requested an
                 increase.
  - `default`  — AWS's published default quota for this model, regardless
                 of account.

The UI shows them side-by-side as `applied / default`. The two-number
comparison makes it obvious when an account is throttled below default.

QuotaCodes are hard-coded to avoid the slow / rate-limited paginated
`list_service_quotas` call. All Service Quotas reads funnel through one
worker thread to stay under the shared 5 TPS read rate limit.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.shared.errors import BadRequest

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Known QuotaCodes — looked up once via `list-aws-default-service-quotas`.
# These are stable across regions and accounts.
# ---------------------------------------------------------------------------

QUOTA_SAGEMAKER_NOTEBOOK = ("sagemaker", "L-04CE2E67")

# Claude Opus 4.6 V1
QUOTA_OPUS_46_TPM = ("bedrock", "L-0AD9BBE8")
QUOTA_OPUS_46_DAILY = ("bedrock", "L-82CD9B28")  # "doubled for cross-region calls"
QUOTA_OPUS_46_RPM = ("bedrock", "L-11DFF789")

# Claude Opus 4.7
QUOTA_OPUS_47_TPM = ("bedrock", "L-5DB28B7B")
QUOTA_OPUS_47_DAILY = ("bedrock", "L-0A609FDF")

# Claude Opus 4.8
QUOTA_OPUS_48_TPM = ("bedrock", "L-DB99DCDB")
QUOTA_OPUS_48_DAILY = ("bedrock", "L-AFE3B2BE")


# ---------------------------------------------------------------------------
# Fixed model list
# ---------------------------------------------------------------------------

CLAUDE_OPUS_SPECS: list[dict[str, Any]] = [
    {
        "version": "4.8",
        "name": "Claude Opus 4.8",
        "inference_profile_id": "global.anthropic.claude-opus-4-8",
        "foundation_model_id": "anthropic.claude-opus-4-8-v1:0",
        "tpm_quota": QUOTA_OPUS_48_TPM,
        "daily_quota": QUOTA_OPUS_48_DAILY,
        "rpm_quota": None,  # 4.7/4.8 don't have an RPM quota per AWS docs
    },
    {
        "version": "4.7",
        "name": "Claude Opus 4.7",
        "inference_profile_id": "global.anthropic.claude-opus-4-7",
        "foundation_model_id": "anthropic.claude-opus-4-7-v1:0",
        "tpm_quota": QUOTA_OPUS_47_TPM,
        "daily_quota": QUOTA_OPUS_47_DAILY,
        "rpm_quota": None,
    },
    {
        "version": "4.6",
        "name": "Claude Opus 4.6",
        "inference_profile_id": "global.anthropic.claude-opus-4-6-v1",
        "foundation_model_id": "anthropic.claude-opus-4-6-v1:0",
        "tpm_quota": QUOTA_OPUS_46_TPM,
        "daily_quota": QUOTA_OPUS_46_DAILY,
        "rpm_quota": QUOTA_OPUS_46_RPM,
    },
]


# ---------------------------------------------------------------------------
# Service Quotas helpers
# ---------------------------------------------------------------------------


def _get_applied(sq_client: Any, service_code: str, quota_code: str) -> int | None:
    """Account-specific applied quota value, or None if not customized.

    `NoSuchResourceException` means the user hasn't adjusted this quota
    from the AWS default — return None so the caller can fill in the
    default value side-by-side.
    """
    try:
        resp = sq_client.get_service_quota(
            ServiceCode=service_code, QuotaCode=quota_code
        )
        val = (resp.get("Quota") or {}).get("Value")
        return int(val) if val is not None else None
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code == "NoSuchResourceException":
            return None
        log.warning(
            "get_service_quota(%s, %s) failed: %s", service_code, quota_code, code
        )
        return None


def _get_default(sq_client: Any, service_code: str, quota_code: str) -> int | None:
    """AWS-published default quota — same for every account."""
    try:
        resp = sq_client.get_aws_default_service_quota(
            ServiceCode=service_code, QuotaCode=quota_code
        )
        val = (resp.get("Quota") or {}).get("Value")
        return int(val) if val is not None else None
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        log.warning(
            "get_aws_default_service_quota(%s, %s) failed: %s",
            service_code,
            quota_code,
            code,
        )
        return None


def _load_all_quota_pairs(creds: Creds, region: str) -> dict[str, dict[str, int | None]]:
    """Sequentially fetch (applied, default) for every quota we need.

    16 calls × ~150ms ≈ 2.4s. Runs in one worker thread to stay under the
    shared 5 TPS limit on Service Quotas reads.
    """
    sq = get_client(creds, "service-quotas", region)
    keys: list[tuple[str, tuple[str, str]]] = [
        ("sagemaker_notebook", QUOTA_SAGEMAKER_NOTEBOOK),
        ("opus_4_8_tpm", QUOTA_OPUS_48_TPM),
        ("opus_4_8_daily", QUOTA_OPUS_48_DAILY),
        ("opus_4_7_tpm", QUOTA_OPUS_47_TPM),
        ("opus_4_7_daily", QUOTA_OPUS_47_DAILY),
        ("opus_4_6_tpm", QUOTA_OPUS_46_TPM),
        ("opus_4_6_daily", QUOTA_OPUS_46_DAILY),
        ("opus_4_6_rpm", QUOTA_OPUS_46_RPM),
    ]
    out: dict[str, dict[str, int | None]] = {}
    for key, (svc, qc) in keys:
        out[key] = {
            "applied": _get_applied(sq, svc, qc),
            "default": _get_default(sq, svc, qc),
        }
    return out


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def get_bedrock_info(creds: Creds, region: str) -> dict[str, Any]:
    """Build the data payload for the Bedrock permissions modal."""
    if not region:
        raise BadRequest("missing 'region' string")

    # Single worker — Service Quotas reads share a 5 TPS bucket so parallel
    # fan-out trips throttling. `ThreadPoolExecutor` kept for forward
    # compat if we later add unrelated parallel sub-calls.
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_quotas = ex.submit(_load_all_quota_pairs, creds, region)
        quotas = f_quotas.result()

    claude_models: list[dict[str, Any]] = []
    for spec in CLAUDE_OPUS_SPECS:
        ver_key = spec["version"].replace(".", "_")
        tpm = quotas.get(f"opus_{ver_key}_tpm") or {"applied": None, "default": None}
        daily = quotas.get(f"opus_{ver_key}_daily") or {"applied": None, "default": None}
        rpm: dict[str, int | None] | None
        if spec["rpm_quota"] is not None:
            rpm = quotas.get(f"opus_{ver_key}_rpm") or {"applied": None, "default": None}
        else:
            rpm = None

        claude_models.append(
            {
                "name": spec["name"],
                "id": spec["inference_profile_id"],
                "console_url": (
                    "https://console.aws.amazon.com/bedrock/home"
                    f"#/model-catalog/serverless/{spec['foundation_model_id']}"
                ),
                "tpm": tpm,
                "daily": daily,
                "rpm": rpm,
            }
        )

    sagemaker = quotas.get("sagemaker_notebook") or {"applied": None, "default": None}

    return {
        "region": region,
        "sagemaker_notebook": sagemaker,
        "claude_opus_models": claude_models,
    }
