import time
from typing import Any
from botocore.exceptions import ClientError
from src.aws.clients import Creds, get_client
from src.shared.errors import BadRequest, UpstreamError, InvalidCredentials

def _get_org_client(creds: Creds) -> Any:
    return get_client(creds, "organizations", "us-east-1")

def get_org_status(creds: Creds) -> dict[str, Any]:
    """Check if the account is part of an organization and if it's the management account."""
    org_client = _get_org_client(creds)
    sts_client = get_client(creds, "sts", "us-east-1")
    
    try:
        caller = sts_client.get_caller_identity()
        caller_account = caller["Account"]
    except ClientError as e:
        raise InvalidCredentials("AWS 凭证失效，获取调用者身份失败") from e

    try:
        resp = org_client.describe_organization()
        org = resp.get("Organization") or {}
        master_account = org.get("MasterAccountId")
        is_management = (master_account == caller_account)
        
        return {
            "in_use": True,
            "is_management": is_management,
            "organization_id": org.get("Id"),
            "master_account_id": master_account,
            "feature_set": org.get("FeatureSet"),
            "caller_account_id": caller_account,
        }
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        if code == "AWSOrganizationsNotInUseException":
            return {
                "in_use": False,
                "is_management": False,
                "caller_account_id": caller_account,
            }
        raise UpstreamError(f"获取组织状态失败: {code}") from e

def create_organization(creds: Creds) -> dict[str, Any]:
    """Create a new AWS Organization with ALL features enabled."""
    org_client = _get_org_client(creds)
    try:
        resp = org_client.create_organization(FeatureSet="ALL")
        org = resp.get("Organization") or {}
        return {
            "organization_id": org.get("Id"),
            "master_account_id": org.get("MasterAccountId"),
            "feature_set": org.get("FeatureSet"),
        }
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        raise UpstreamError(f"初始化组织失败: {code} - {msg}") from e

def list_sub_accounts(creds: Creds) -> list[dict[str, Any]]:
    """List all accounts inside the AWS Organization."""
    org_client = _get_org_client(creds)
    accounts = []
    try:
        paginator = org_client.get_paginator("list_accounts")
        for page in paginator.paginate():
            for acc in page.get("Accounts", []):
                # Format timestamps to ISO strings
                jt = acc.get("JoinedTimestamp")
                accounts.append({
                    "id": acc.get("Id"),
                    "name": acc.get("Name"),
                    "email": acc.get("Email"),
                    "status": acc.get("Status"),
                    "joined_method": acc.get("JoinedMethod"),
                    "joined_timestamp": jt.isoformat() if jt else None,
                })
        return accounts
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        raise UpstreamError(f"列出组织成员账号失败: {code} - {msg}") from e

def create_sub_account(creds: Creds, email: str, name: str) -> dict[str, Any]:
    """Initiate creation of a new member account under the organization."""
    if not email or "@" not in email:
        raise BadRequest("请输入合法的邮箱地址")
    if not name:
        raise BadRequest("账号名称不能为空")

    org_client = _get_org_client(creds)
    try:
        # Default role created in the new account: OrganizationAccountAccessRole
        resp = org_client.create_account(Email=email, AccountName=name)
        status = resp.get("CreateAccountStatus") or {}
        return {
            "request_id": status.get("Id"),
            "state": status.get("State"),
            "account_name": status.get("AccountName"),
        }
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        raise UpstreamError(f"创建子账号请求失败: {code} - {msg}") from e

def check_create_account_status(creds: Creds, request_id: str) -> dict[str, Any]:
    """Retrieve current creation status of a member account."""
    if not request_id:
        raise BadRequest("missing 'request_id'")
        
    org_client = _get_org_client(creds)
    try:
        resp = org_client.describe_create_account_status(CreateAccountRequestId=request_id)
        status = resp.get("CreateAccountStatus") or {}
        completed_time = status.get("CompletedTime")
        requested_time = status.get("RequestedTime")
        
        return {
            "request_id": status.get("Id"),
            "account_name": status.get("AccountName"),
            "state": status.get("State"), # IN_PROGRESS | SUCCEEDED | FAILED
            "account_id": status.get("AccountId"),
            "failure_reason": status.get("FailureReason"),
            "requested_time": requested_time.isoformat() if requested_time else None,
            "completed_time": completed_time.isoformat() if completed_time else None,
        }
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        raise UpstreamError(f"查询账号创建进度失败: {code} - {msg}") from e

def create_sub_account_admin_keys(creds: Creds, sub_account_id: str, admin_user_name: str = "admin") -> dict[str, Any]:
    """Assume the Admin role in the sub-account, create an admin IAM user, and issue permanent access keys."""
    if not sub_account_id:
        raise BadRequest("missing 'sub_account_id'")

    sts = get_client(creds, "sts", "us-east-1")
    role_arn = f"arn:aws:iam::{sub_account_id}:role/OrganizationAccountAccessRole"
    
    # 1. Assume Role
    try:
        assumed = sts.assume_role(
            RoleArn=role_arn,
            RoleSessionName="AWSPanelSubAccountAdminSetup"
        )
        temp_creds = assumed["Credentials"]
        sub_creds = Creds(
            access_key=temp_creds["AccessKeyId"],
            secret_key=temp_creds["SecretAccessKey"],
            session_token=temp_creds["SessionToken"]
        )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        raise UpstreamError(f"无法扮演子账号的管理角色 (Role Access Denied). 请确认该账号的 OrganizationAccountAccessRole 是否已就绪. 错误: {code} - {msg}") from e

    # 2. In the sub-account: setup admin user & permanent keys
    iam = get_client(sub_creds, "iam", "us-east-1")
    
    # Check if admin user exists, create if not
    user_exists = True
    try:
        iam.get_user(UserName=admin_user_name)
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "NoSuchEntity":
            user_exists = False
        else:
            code = e.response.get("Error", {}).get("Code", "Unknown")
            raise UpstreamError(f"在子账号中获取 IAM 用户失败: {code}") from e

    if not user_exists:
        try:
            iam.create_user(UserName=admin_user_name)
            # Attach AdministratorAccess
            iam.attach_user_policy(
                UserName=admin_user_name,
                PolicyArn="arn:aws:iam::aws:policy/AdministratorAccess"
            )
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "Unknown")
            msg = e.response.get("Error", {}).get("Message", str(e))
            raise UpstreamError(f"在子账号中创建管理员用户失败: {code} - {msg}") from e

    # Ensure we don't exceed the 2-key limit
    try:
        keys_resp = iam.list_access_keys(UserName=admin_user_name)
        keys = keys_resp.get("AccessKeyMetadata", [])
        if len(keys) >= 2:
            # Delete the oldest key to make room
            oldest_key = min(keys, key=lambda k: k["CreateDate"])
            oldest_key_id = oldest_key["AccessKeyId"]
            iam.delete_access_key(UserName=admin_user_name, AccessKeyId=oldest_key_id)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        raise UpstreamError(f"清理子账号中已满的 Access Key 失败: {code}") from e

    # Create new access key
    try:
        key_resp = iam.create_access_key(UserName=admin_user_name)
        ak_data = key_resp.get("AccessKey") or {}
        return {
            "access_key": ak_data.get("AccessKeyId"),
            "secret_key": ak_data.get("SecretAccessKey"),
            "user_name": admin_user_name,
            "account_id": sub_account_id,
        }
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        msg = e.response.get("Error", {}).get("Message", str(e))
        raise UpstreamError(f"在子账号中生成 Access Key 失败: {code} - {msg}") from e
