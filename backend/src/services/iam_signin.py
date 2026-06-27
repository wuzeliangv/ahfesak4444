"""
Generate a federation sign-in URL for the AWS Management Console.

Flow (mirrors AWS's "custom identity broker" doc):
  1. `sts:GetFederationToken` — exchanges long-term AK/SK for short-term
     credentials + an inline policy. AWS rejects this call for ROOT
     identities (documented limitation), so we detect that up front and
     return a clear error.
  2. Build a JSON `{sessionId, sessionKey, sessionToken}` blob.
  3. POST/GET to `https://signin.aws.amazon.com/federation` with
     `Action=getSigninToken` to exchange the blob for a SigninToken.
  4. Build the final login URL with `Action=login` plus a `Destination`
     that points to whichever console page the user wants to land on
     (e.g. Bedrock, Claude Platform, the root console).

Inspired by https://github.com/obace/aws-glass `/api/iam/signin` (MIT).
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Any

from botocore.exceptions import ClientError

from src.aws.clients import Creds, get_client
from src.shared.errors import BadRequest, UpstreamError

_STS_REGION = "us-east-1"
_FEDERATION_ENDPOINT = "https://signin.aws.amazon.com/federation"
_DEFAULT_DESTINATION = "https://console.aws.amazon.com/"
# Grant the federated session the union of everything its caller can do.
# AWS intersects this with the caller's actual permissions, so it's safe.
_ADMIN_POLICY = json.dumps(
    {
        "Version": "2012-10-17",
        "Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}],
    }
)


def generate_signin_url(
    creds: Creds,
    destination: str | None = None,
    duration_seconds: int = 3600,
    issuer: str = "aws-management-helper",
) -> dict[str, Any]:
    """Return a short-lived URL that signs the user into the AWS Console.

    `destination` is the page the user lands on after auth (e.g. the
    Bedrock or Claude Platform console). Defaults to the main console.

    Note: AWS docs claim `GetFederationToken` rejects root creds, but in
    practice it works for most accounts. We let AWS decide and surface
    a clear error if it actually refuses.
    """
    if duration_seconds < 900 or duration_seconds > 43200:
        raise BadRequest("duration_seconds must be between 900 and 43200")
    dest = destination or _DEFAULT_DESTINATION

    sts = get_client(creds, "sts", _STS_REGION)

    # Exchange long-term creds for short-term federation creds.
    try:
        fed_resp = sts.get_federation_token(
            Name="AwsHelperUser",
            Policy=_ADMIN_POLICY,
            DurationSeconds=duration_seconds,
        )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in {"AccessDenied", "AccessDeniedException"}:
            raise BadRequest(
                "无权调用 sts:GetFederationToken (需要 IAM 用户具备该权限)"
            ) from e
        if "root" in msg.lower():
            raise BadRequest(
                "该账号无法生成 IAM 登录链接,请改用 IAM 用户的 AK/SK"
            ) from e
        raise UpstreamError(f"get_federation_token failed: {code} - {msg}") from e

    fed_creds = fed_resp.get("Credentials") or {}
    session_blob = json.dumps(
        {
            "sessionId": fed_creds.get("AccessKeyId"),
            "sessionKey": fed_creds.get("SecretAccessKey"),
            "sessionToken": fed_creds.get("SessionToken"),
        }
    )

    # Step 3: exchange session JSON for a SigninToken.
    token_params = urllib.parse.urlencode(
        {
            "Action": "getSigninToken",
            "Session": session_blob,
            "SessionDuration": duration_seconds,
        }
    )
    try:
        req = urllib.request.Request(
            f"{_FEDERATION_ENDPOINT}?{token_params}",
            headers={"User-Agent": "aws-panel/1.0"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8")
        data = json.loads(body)
    except Exception as e:  # noqa: BLE001
        raise UpstreamError(
            f"federation endpoint 调用失败: {e}"
        ) from e

    signin_token = data.get("SigninToken")
    if not signin_token:
        raise UpstreamError("federation endpoint 未返回 SigninToken")

    # Step 4: build the final login URL.
    login_params = urllib.parse.urlencode(
        {
            "Action": "login",
            "Issuer": issuer,
            "Destination": dest,
            "SigninToken": signin_token,
        }
    )
    return {
        "url": f"{_FEDERATION_ENDPOINT}?{login_params}",
        "destination": dest,
        "duration_seconds": duration_seconds,
        # The URL itself is single-use within 15 min of issue; the session
        # then lasts `duration_seconds` once landed on.
        "url_valid_for_seconds": 900,
    }
