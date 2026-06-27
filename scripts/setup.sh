#!/usr/bin/env bash
# =============================================================================
# AWS Panel — 一键全新部署脚本
# =============================================================================
# 从一台全新的 Debian/Ubuntu ARM 服务器开始，安装所有依赖、配置 TLS、
# 部署后端 Lambda、构建前端、启动 Deployer 守护进程。
#
# 用法：
#   # 交互模式（会提示输入域名、API Key 等）
#   bash scripts/setup.sh
#
#   # 非交互模式（环境变量预设所有参数）
#   PANEL_DOMAIN=aws.se.sd \
#   PANEL_EMAIL=admin@aws.se.sd \
#   AWS_REGION=us-east-1 \
#     bash scripts/setup.sh
#
# 前置条件：
#   - 一台有公网 IP 的服务器（推荐 Oracle Cloud ARM / Debian 12）
#   - root 权限
#   - 域名已解析到该服务器 IP（用于 Let's Encrypt 证书）
#   - AWS 凭证已配置（aws configure）用于部署后端 Lambda
#
# 此脚本是幂等的 — 重复运行不会破坏已有配置，只做增量更新。
# =============================================================================

set -euo pipefail

# ─── 颜色 ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ─── 工具函数 ────────────────────────────────────────────────────────────────
info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()     { echo -e "${RED}[ERROR]${NC} $*"; }
step()    { echo -e "\n${CYAN}${BOLD}━━━ $* ━━━${NC}"; }
ask()     { echo -en "${BOLD}$*${NC}"; }

die() { err "$*"; exit 1; }

# ─── 检查 root ───────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "请使用 root 用户运行此脚本"

# ─── 远程执行引导 (比如 bash <(curl ...) 运行) ──────────────────────────────────
if [[ ! -d "backend" || ! -d "frontend" || ! -d "deployer" ]]; then
    step "0/8  检测到远程管道执行，开始引导下载项目"
    
    # 确保 Git 已安装
    if ! command -v git &>/dev/null; then
        info "安装 Git..."
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1
    fi
    
    CLONE_DIR="/root/aws-panel"
    if [[ -d "$CLONE_DIR" ]]; then
        info "目录 $CLONE_DIR 已存在，更新代码中..."
        cd "$CLONE_DIR"
        git fetch --all && git reset --hard origin/main
    else
        info "克隆仓库到 $CLONE_DIR ..."
        git clone https://github.com/wuzeliangv/ahfesak4444.git "$CLONE_DIR"
        cd "$CLONE_DIR"
    fi
    
    info "拉取成功，即将交接本地执行..."
    exec bash scripts/setup.sh "$@"
    exit 0
fi

# 项目根目录（脚本在 scripts/ 下）
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="${REPO_ROOT}/backend"
FRONTEND_DIR="${REPO_ROOT}/frontend"
DEPLOYER_DIR="${REPO_ROOT}/deployer"

# ─── 收集配置 ─────────────────────────────────────────────────────────────────
step "1/8  收集配置参数"

if [[ -z "${PANEL_DOMAIN:-}" ]]; then
    ask "面板域名（如 aws.se.sd）: "
    read -r PANEL_DOMAIN
fi
[[ -n "$PANEL_DOMAIN" ]] || die "域名不能为空"

if [[ -z "${PANEL_EMAIL:-}" ]]; then
    ask "管理员邮箱（用于 Let's Encrypt，如 admin@${PANEL_DOMAIN}）: "
    read -r PANEL_EMAIL
    PANEL_EMAIL="${PANEL_EMAIL:-admin@${PANEL_DOMAIN}}"
fi

AWS_REGION="${AWS_REGION:-us-east-1}"
PANEL_URL="https://${PANEL_DOMAIN}"
WEB_ROOT="/var/www/aws-panel"

info "域名:   ${PANEL_DOMAIN}"
info "邮箱:   ${PANEL_EMAIL}"
info "区域:   ${AWS_REGION}"
info "URL:    ${PANEL_URL}"

# =============================================================================
# 2. 系统依赖
# =============================================================================
step "2/8  安装系统依赖"

export DEBIAN_FRONTEND=noninteractive

# 基础工具
if ! command -v curl &>/dev/null || ! command -v rsync &>/dev/null; then
    info "安装基础工具..."
    apt-get update -qq
    apt-get install -y -qq curl rsync unzip git jq gnupg2 apt-transport-https >/dev/null 2>&1
    ok "基础工具已安装"
else
    ok "基础工具已存在"
fi

# ─── Node.js ≥ 18 ────────────────────────────────────────────────────────────
if command -v node &>/dev/null; then
    NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
    if [[ "$NODE_VER" -ge 18 ]]; then
        ok "Node.js $(node -v) 已安装"
    else
        warn "Node.js 版本过低 ($(node -v))，将升级..."
        INSTALL_NODE=1
    fi
else
    INSTALL_NODE=1
fi

if [[ "${INSTALL_NODE:-0}" == "1" ]]; then
    info "安装 Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null 2>&1
    ok "Node.js $(node -v) 已安装"
fi

# ─── Python ≥ 3.11 ──────────────────────────────────────────────────────────
if command -v python3 &>/dev/null; then
    PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
    PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
    PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
    if [[ "$PY_MAJOR" -ge 3 && "$PY_MINOR" -ge 11 ]]; then
        ok "Python ${PY_VER} 已安装"
    else
        warn "Python 版本过低 (${PY_VER})，需要 ≥ 3.11"
        die "请手动安装 Python ≥ 3.11（Debian 12 自带 3.11）"
    fi
else
    die "未找到 python3，请先安装 Python ≥ 3.11"
fi

# ─── uv (Python 包管理器) ───────────────────────────────────────────────────
if command -v uv &>/dev/null; then
    ok "uv $(uv --version | awk '{print $2}') 已安装"
else
    info "安装 uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1
    export PATH="$HOME/.local/bin:$PATH"
    ok "uv $(uv --version | awk '{print $2}') 已安装"
fi

# ─── AWS CLI v2 ─────────────────────────────────────────────────────────────
if command -v aws &>/dev/null; then
    ok "AWS CLI $(aws --version 2>&1 | awk '{print $1}' | cut -d/ -f2) 已安装"
else
    info "安装 AWS CLI v2..."
    ARCH=$(uname -m)
    if [[ "$ARCH" == "aarch64" ]]; then
        curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
    else
        curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
    fi
    unzip -qo /tmp/awscliv2.zip -d /tmp/aws-install
    /tmp/aws-install/aws/install --update >/dev/null 2>&1
    rm -rf /tmp/awscliv2.zip /tmp/aws-install
    ok "AWS CLI 已安装"
fi

# ─── AWS SAM CLI ────────────────────────────────────────────────────────────
if command -v sam &>/dev/null; then
    ok "SAM CLI $(sam --version | awk '{print $NF}') 已安装"
else
    info "安装 AWS SAM CLI..."
    ARCH=$(uname -m)
    if [[ "$ARCH" == "aarch64" ]]; then
        curl -fsSL "https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-arm64.zip" -o /tmp/aws-sam-cli.zip
    else
        curl -fsSL "https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-x86_64.zip" -o /tmp/aws-sam-cli.zip
    fi
    mkdir -p /tmp/sam-installation
    unzip -qo /tmp/aws-sam-cli.zip -d /tmp/sam-installation
    /tmp/sam-installation/install --update >/dev/null 2>&1
    rm -rf /tmp/aws-sam-cli.zip /tmp/sam-installation
    ok "SAM CLI 已安装"
fi

# ─── Caddy ──────────────────────────────────────────────────────────────────
if command -v caddy &>/dev/null; then
    ok "Caddy $(caddy version | awk '{print $1}') 已安装"
else
    info "安装 Caddy..."
    apt-get install -y -qq debian-keyring debian-archive-keyring >/dev/null 2>&1
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq caddy >/dev/null 2>&1
    ok "Caddy 已安装"
fi

# 确保 PATH 包含所有已安装工具
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

# =============================================================================
# 3. AWS 凭证检查
# =============================================================================
step "3/8  检查 AWS 凭证"

if aws sts get-caller-identity &>/dev/null; then
    AWS_ACCOUNT=$(aws sts get-caller-identity --query 'Account' --output text)
    AWS_ARN=$(aws sts get-caller-identity --query 'Arn' --output text)
    ok "AWS 凭证有效 — 账号: ${AWS_ACCOUNT}"
    info "身份: ${AWS_ARN}"
else
    die "AWS 凭证未配置或无效，请先运行 'aws configure'"
fi

# =============================================================================
# 4. 部署后端 Lambda
# =============================================================================
step "4/8  部署后端 Lambda"

cd "$BACKEND_DIR"

# 生成或读取 API Key
if [[ -f .api-key ]]; then
    API_KEY=$(cat .api-key)
    ok "已有 API Key (${API_KEY:0:8}...)"
else
    API_KEY=$(openssl rand -hex 32)
    echo -n "$API_KEY" > .api-key
    chmod 600 .api-key
    ok "已生成新 API Key (${API_KEY:0:8}...)"
fi

# 安装 Python 依赖
if [[ ! -d .venv ]]; then
    info "初始化 Python 虚拟环境..."
    uv venv >/dev/null 2>&1
fi
info "同步 Python 依赖..."
uv sync --quiet 2>/dev/null || true

# SAM 构建
info "SAM 构建中..."
sam build --cached 2>&1 | tail -5

# SAM 部署
info "SAM 部署中..."
if [[ -f samconfig.toml ]] && grep -q "parameter_overrides" samconfig.toml 2>/dev/null; then
    # samconfig.toml 已有完整配置（非首次部署）
    sam deploy --no-confirm-changeset --no-fail-on-empty-changeset 2>&1 | tail -15
else
    # 首次部署，写入参数
    sam deploy \
        --stack-name aws-panel \
        --region "$AWS_REGION" \
        --capabilities CAPABILITY_IAM \
        --resolve-s3 \
        --s3-prefix aws-panel \
        --no-confirm-changeset \
        --no-fail-on-empty-changeset \
        --parameter-overrides \
            "ApiKey=${API_KEY}" \
            "CorsAllowedOrigin=${PANEL_URL}" \
        2>&1 | tail -15
fi

# 获取 API URL
API_URL=$(aws cloudformation describe-stacks \
    --stack-name aws-panel \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' \
    --output text 2>/dev/null || true)

if [[ -n "$API_URL" ]]; then
    echo -n "$API_URL" > .api-url
    ok "后端已部署: ${API_URL}"
else
    # 尝试从已有文件读取
    if [[ -f .api-url ]]; then
        API_URL=$(cat .api-url)
        warn "无法从 CloudFormation 获取 URL，使用已有值: ${API_URL}"
    else
        die "无法获取 API URL，请检查 CloudFormation 栈状态"
    fi
fi

# =============================================================================
# 5. 配置并构建前端
# =============================================================================
step "5/8  构建前端"

cd "$FRONTEND_DIR"

# 写入 .env.local
cat > .env.local <<EOF
VITE_API_URL=${API_URL}
EOF
ok "已写入 .env.local"

# 安装 npm 依赖
if [[ ! -d node_modules ]]; then
    info "安装前端依赖..."
    npm install --silent 2>&1 | tail -3
else
    ok "前端依赖已存在"
fi

# 构建
info "构建前端 Bundle..."
npm run build 2>&1 | tail -5
ok "前端构建完成"

# =============================================================================
# 6. 配置 Caddy
# =============================================================================
step "6/8  配置 Caddy + TLS"

# 创建 Web 目录
mkdir -p "$WEB_ROOT"
mkdir -p /var/log/caddy

# 同步构建产物
rsync -a --delete "${FRONTEND_DIR}/dist/" "${WEB_ROOT}/"
chown -R caddy:caddy "$WEB_ROOT"
chmod -R o-rwx "$WEB_ROOT"
ok "前端已部署到 ${WEB_ROOT}"

# 写入 Caddyfile
CADDYFILE="/etc/caddy/Caddyfile"
cat > "$CADDYFILE" <<CADDY
# =============================================================================
# AWS Panel — Caddyfile (由 setup.sh 自动生成)
# =============================================================================
{
	email ${PANEL_EMAIL}
}

${PANEL_DOMAIN} {
	# ----------- 安全头 -------------------------------------------------------
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
		Content-Security-Policy "default-src 'self'; connect-src 'self' https://*.amazonaws.com; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
		-Server
	}

	# ----------- Deployer 守护进程反向代理 (SSE) --------------------------------
	handle /deployer/* {
		reverse_proxy 127.0.0.1:8787 {
			flush_interval -1
		}
	}

	# ----------- 静态 SPA -----------------------------------------------------
	handle {
		encode zstd gzip
		root * ${WEB_ROOT}
		file_server
		try_files {path} /index.html
	}

	# ----------- 日志 ---------------------------------------------------------
	log {
		output file /var/log/caddy/aws-panel.log {
			roll_size 10mb
			roll_keep 5
			roll_keep_for 720h
		}
		format json
		level INFO
	}
}
CADDY

# 验证配置
caddy validate --config "$CADDYFILE" >/dev/null 2>&1
ok "Caddyfile 已写入并验证通过"

# 启用并重启 Caddy
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy
ok "Caddy 已启动 (TLS 证书将自动申请)"

# =============================================================================
# 7. 配置 Deployer 守护进程
# =============================================================================
step "7/8  配置 Deployer 守护进程"

# ─── 配置 Telegram Bot ───
REGISTRY_DIR="/root/.aws-panel"
mkdir -p "$REGISTRY_DIR"
chmod 700 "$REGISTRY_DIR"

CONFIG_FILE="${REGISTRY_DIR}/deployer-config.json"
TG_TOKEN=""
TG_CHAT=""

if [[ ! -f "$CONFIG_FILE" ]]; then
    ask "是否现在配置 Telegram Bot（用于获取后台登录链接）？ [Y/n]: "
    read -r CONFIRM_TG
    CONFIRM_TG="${CONFIRM_TG:-y}"
    
    if [[ "$CONFIRM_TG" =~ ^[Yy]$ ]]; then
        while [[ -z "$TG_TOKEN" ]]; do
            ask "请输入 Telegram Bot Token (例如 123456:ABC-DEF...): "
            read -r TG_TOKEN
        done
        
        while [[ -z "$TG_CHAT" ]]; do
            ask "请输入 Telegram Chat ID (例如 987654321): "
            read -r TG_CHAT
        done
        
        # 写入配置文件
        cat > "$CONFIG_FILE" <<JSON
{
  "telegram": {
    "botToken": "${TG_TOKEN}",
    "chatId": "${TG_CHAT}"
  }
}
JSON
        chmod 600 "$CONFIG_FILE"
        ok "Telegram Bot 配置已保存"
    else
        warn "已跳过 Telegram 配置。注意：您需要手动配置该文件才能登录后台！"
    fi
else
    ok "已检测到现有的 Telegram 配置文件: ${CONFIG_FILE}"
fi

# 创建 systemd 服务文件
cat > /etc/systemd/system/aws-panel-deployer.service <<SERVICE
[Unit]
Description=AWS Panel local deployer daemon (drives sam to deploy/destroy worker Lambdas)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${DEPLOYER_DIR}
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
Environment=DEPLOYER_PORT=8787
Environment=DEPLOYER_CORS_ORIGIN=${PANEL_URL}
Environment=DEPLOYER_PANEL_URL=${PANEL_URL}
Environment=DEPLOYER_BACKEND_DIR=${BACKEND_DIR}
Environment=HOME=/root
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.local/bin
TimeoutStopSec=30
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable aws-panel-deployer >/dev/null 2>&1
systemctl restart aws-panel-deployer
ok "Deployer 守护进程已启动"

# =============================================================================
# 8. 健康检查
# =============================================================================
step "8/8  最终健康检查"

echo ""

# Caddy
if systemctl is-active caddy &>/dev/null; then
    ok "Caddy          — 运行中"
else
    err "Caddy          — 未运行 ❌"
fi

# Deployer
if systemctl is-active aws-panel-deployer &>/dev/null; then
    ok "Deployer       — 运行中"
else
    err "Deployer       — 未运行 ❌"
fi

# Deployer HTTP 健康检查
sleep 2
if curl -sf http://127.0.0.1:8787/deployer/health >/dev/null 2>&1; then
    ok "Deployer HTTP  — 响应正常"
else
    warn "Deployer HTTP  — 尚未就绪（可能还在启动中）"
fi

# Lambda 后端健康检查
if curl -sf "${API_URL}/health" >/dev/null 2>&1; then
    ok "Lambda 后端    — 响应正常"
else
    warn "Lambda 后端    — 首次冷启动可能较慢，稍后自动就绪"
fi

# =============================================================================
# 完成
# =============================================================================
echo ""
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  ✅ AWS Panel 部署完成！${NC}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  🌐 面板地址:    ${BOLD}${PANEL_URL}${NC}"
echo -e "  🔧 后端 API:    ${BOLD}${API_URL}${NC}"
echo -e "  🔑 API Key:     ${BOLD}${API_KEY:0:8}...${NC} (完整内容: backend/.api-key)"
echo ""
echo -e "  📋 常用命令:"
echo -e "     查看 Caddy 日志:     ${CYAN}journalctl -u caddy -f${NC}"
echo -e "     查看 Deployer 日志:  ${CYAN}journalctl -u aws-panel-deployer -f${NC}"
echo -e "     查看 Lambda 日志:    ${CYAN}cd backend && make logs${NC}"
echo -e "     重新部署前端:        ${CYAN}bash scripts/deploy-frontend.sh${NC}"
echo -e "     重新部署后端:        ${CYAN}cd backend && make deploy${NC}"
echo ""
echo -e "  ⚠️  首次访问时，Caddy 需要几秒钟申请 TLS 证书。"
echo -e "     如果使用 Telegram 认证，请先在 Deployer 中配置 Bot Token。"
echo ""
