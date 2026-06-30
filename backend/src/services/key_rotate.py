"""
IAM access key rotation for the calling identity.

AWS allows the holder of an access key to manage that same identity's
keys (both root and IAM users) by simply omitting `UserName` from the
`list/create/delete_access_key` calls. boto3 docs:

  "If you do not specify a user name, IAM determines the user name
  implicitly based on the Amazon Web Services access key ID signing
  the request. This operation works for access keys under the AWS
  account. Consequently, you can use this operation to manage AWS
  account root user credentials."

So every function here passes the caller's creds and omits UserName —
the same code path handles root and IAM user identities.

Rotation is a 3-step protocol, split across two HTTP calls so the
frontend can persist the new key to its local vault before discarding
the old one:

  1. POST /iam/keys/rotate  → creates new AK, returns AK/SK (does NOT
                              delete the old key). 2-key IAM limit is
                              enforced here.
  2. Frontend writes new AK/SK into the local encrypted vault.
  3. POST /iam/keys/delete  → deletes the old AK. Can be signed by
                              either the new or old AK; the new AK is
                              the usual choice so the call doubles as
                              a "the new key works" smoke test.

`delete_access_key` retries on `InvalidClientTokenId` /
`SignatureDoesNotMatch` because new AKs can take a few seconds to
propagate through IAM's regional caches.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.shared.errors import BadRequest, UpstreamError

log = logging.getLogger(__name__)

IAM_REGION = "us-east-1"
MAX_KEYS_PER_USER = 2
# Cumulative delays (seconds) between retries: 1 + 2 + 4 + 8 = 15s.
# Well within the 28s Lambda timeout and covers the typical sub-30s
# propagation window for newly-created access keys.
_PROPAGATION_RETRY_DELAYS = [1, 2, 4, 8]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _list_keys_raw(creds: Creds) -> list[dict[str, Any]]:
    """Return raw boto3 AccessKeyMetadata list for the signing identity."""
    iam = get_client(creds, "iam", IAM_REGION)
    try:
        resp = iam.list_access_keys()  # no UserName = use signing identity
        return resp.get("AccessKeyMetadata", []) or []
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in ("AccessDenied", "AccessDeniedException"):
            raise BadRequest("无权列出 IAM 密钥 (需要 iam:ListAccessKeys)") from e
        if code in ("InvalidClientTokenId", "SignatureDoesNotMatch"):
            raise BadRequest("AK/SK 无效或已被删除") from e
        raise UpstreamError(f"list_access_keys failed: {code} - {msg}") from e


def _serialize_key_meta(meta: dict[str, Any]) -> dict[str, Any]:
    """Convert boto3 AccessKeyMetadata into a JSON-safe dict."""
    cd = meta.get("CreateDate")
    return {
        "access_key_id": meta.get("AccessKeyId"),
        "status": meta.get("Status"),
        "user_name": meta.get("UserName"),
        "create_date": cd.isoformat() if cd else None,
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def list_my_keys(creds: Creds) -> dict[str, Any]:
    """List every access key belonging to the signing identity."""
    keys = [_serialize_key_meta(k) for k in _list_keys_raw(creds)]
    return {"keys": keys}


def create_new_key(creds: Creds) -> dict[str, Any]:
    """Create a new access key for the signing identity.

    Pre-checks the 2-key IAM limit so we fail fast with a clear message
    instead of getting an opaque `LimitExceeded` from AWS. Returns the
    new AK + SK — the caller MUST persist them before deleting the old
    key, otherwise the new key is lost.
    """
    existing = _list_keys_raw(creds)
    if len(existing) >= MAX_KEYS_PER_USER:
        ids = ", ".join(k.get("AccessKeyId", "?") for k in existing)
        raise BadRequest(
            f"该账号已有 {len(existing)} 个密钥 (IAM 上限 2),"
            f"请先到 AWS 控制台手动删除其中一个再重置: {ids}"
        )

    iam = get_client(creds, "iam", IAM_REGION)
    try:
        resp = iam.create_access_key()  # no UserName
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in ("AccessDenied", "AccessDeniedException"):
            raise BadRequest("无权创建 IAM 密钥 (需要 iam:CreateAccessKey)") from e
        if code == "LimitExceeded":
            raise BadRequest("已达到 IAM 密钥数量上限 (2)") from e
        raise UpstreamError(f"create_access_key failed: {code} - {msg}") from e

    ak = resp.get("AccessKey") or {}
    new_ak = ak.get("AccessKeyId")
    new_sk = ak.get("SecretAccessKey")
    if not new_ak or not new_sk:
        raise UpstreamError("AWS create_access_key 返回的密钥不完整")

    cd = ak.get("CreateDate")
    return {
        "access_key": new_ak,
        "secret_key": new_sk,
        "user_name": ak.get("UserName"),
        "create_date": cd.isoformat() if cd else None,
    }


def delete_access_key(creds: Creds, access_key_id: str) -> dict[str, Any]:
    """Delete an access key by ID using the supplied creds as the signer.

    Retries on token-propagation errors so callers can sign with a newly
    minted AK without manual backoff. All other errors fail fast.
    """
    iam = get_client(creds, "iam", IAM_REGION)
    last_err: ClientError | None = None

    for attempt, delay in enumerate([0, *_PROPAGATION_RETRY_DELAYS]):
        if delay > 0:
            log.info(
                "delete_access_key retry %d after %ds (propagation)",
                attempt,
                delay,
            )
            time.sleep(delay)
        try:
            iam.delete_access_key(AccessKeyId=access_key_id)
            return {"deleted_access_key": access_key_id}
        except ClientError as e:
            last_err = e
            code = e.response.get("Error", {}).get("Code", "")
            if code in ("InvalidClientTokenId", "SignatureDoesNotMatch"):
                # New AK hasn't propagated yet — retry.
                continue
            break

    # Either hit a non-retriable error, or ran out of retries.
    assert last_err is not None  # noqa: S101
    code = last_err.response.get("Error", {}).get("Code", "")
    msg = last_err.response.get("Error", {}).get("Message", str(last_err))

    if code in ("AccessDenied", "AccessDeniedException"):
        raise BadRequest("无权删除 IAM 密钥 (需要 iam:DeleteAccessKey)")
    if code == "NoSuchEntity":
        raise BadRequest(f"密钥 {access_key_id} 不存在或已被删除")
    if code in ("InvalidClientTokenId", "SignatureDoesNotMatch"):
        raise UpstreamError(
            f"新密钥经过 ~15s 仍未在 AWS 全局生效,"
            f"请到 IAM 控制台手动删除 {access_key_id}"
        )
    raise UpstreamError(f"delete_access_key failed: {code} - {msg}")


def rotate_full(creds: Creds) -> dict[str, Any]:
    """One-shot rotation: create new key, verify it, delete old key.

    Unlike the 2-step protocol used by the panel (where the frontend
    persists the new key between steps), this endpoint is designed for
    the standalone Key Tools page where callers don't need to persist
    keys locally — they just want a fresh AK/SK back.
    """
    old_ak = creds["access_key"]

    # 1. Ensure room: list keys, delete any that aren't the current one
    existing = _list_keys_raw(creds)
    if len(existing) >= MAX_KEYS_PER_USER:
        iam = get_client(creds, "iam", IAM_REGION)
        for k in existing:
            kid = k.get("AccessKeyId", "")
            if kid and kid != old_ak:
                try:
                    iam.delete_access_key(AccessKeyId=kid)
                    log.info("deleted surplus key %s to make room", kid)
                except ClientError:
                    pass  # best effort

    # 2. Create new key
    iam = get_client(creds, "iam", IAM_REGION)
    try:
        resp = iam.create_access_key()
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code == "LimitExceeded":
            raise BadRequest("已达到 IAM 密钥数量上限 (2), 请先删除多余密钥") from e
        raise UpstreamError(f"create_access_key failed: {code} - {msg}") from e

    ak_data = resp.get("AccessKey") or {}
    new_ak = ak_data.get("AccessKeyId")
    new_sk = ak_data.get("SecretAccessKey")
    if not new_ak or not new_sk:
        raise UpstreamError("AWS create_access_key 返回的密钥不完整")

    # 3. Verify new key works (retry with backoff)
    new_creds: Creds = {"access_key": new_ak, "secret_key": new_sk}
    verified = False
    for delay in _PROPAGATION_RETRY_DELAYS:
        time.sleep(delay)
        try:
            sts = get_client(new_creds, "sts", IAM_REGION)
            sts.get_caller_identity()
            verified = True
            break
        except ClientError:
            continue

    # 4. Delete old key (use new creds if verified, else old creds)
    delete_creds = new_creds if verified else creds
    old_deleted = False
    try:
        del_iam = get_client(delete_creds, "iam", IAM_REGION)
        del_iam.delete_access_key(AccessKeyId=old_ak)
        old_deleted = True
    except ClientError as e:
        log.warning("failed to delete old key %s: %s", old_ak, e)

    cd = ak_data.get("CreateDate")
    return {
        "new_access_key": new_ak,
        "new_secret_key": new_sk,
        "old_access_key": old_ak,
        "old_deleted": old_deleted,
        "verified": verified,
        "user_name": ak_data.get("UserName"),
        "create_date": cd.isoformat() if cd else None,
    }
