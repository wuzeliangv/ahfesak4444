<p align="center">
  <img src="frontend/public/favicon.svg" width="80" height="80" alt="AWS 管理助手">
</p>

<h1 align="center">AWS 管理助手</h1>

<p align="center">
  多账号 · 多区域的轻量级 AWS 控制台<br/>
  凭证加密集中托管，出口 IP 可分散到全球节点，随处安全可达
</p>

<p align="center">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white">
  <img alt="Tailwind" src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white">
  <img alt="Python" src="https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white">
  <img alt="AWS SAM" src="https://img.shields.io/badge/AWS_SAM-Lambda-FF9900?logo=amazonaws&logoColor=white">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-≥18-339933?logo=nodedotjs&logoColor=white">
</p>

---

## ✨ 功能特性

### 🖥️ 实例管理
- **EC2** — 创建 / 启动 / 停止 / 重启 / 终止 / 重命名 / 换 IP / 流量监控
- **Lightsail** — 完整生命周期管理 + 开放端口 + Bundle 目录浏览
- 支持 11 种系统镜像（AL2023、Ubuntu 20/22/24、Debian 10-13、Windows Server 2022/2025）
- 实例密码注入（Linux cloud-init / Windows PowerShell）
- Wavelength Zone / Local Zone 实例创建

### 📊 监控与账单
- **vCPU 配额** — 单区域 / 全区域 On-Demand + Spot 配额与实时用量
- **Cost Explorer** — 按月按服务的费用明细与趋势图
- **Free Tier** — 免费套餐状态、剩余额度与逐项用量
- **Bedrock** — Claude 模型配额查询（TPM / 日限 / RPM）

### 🌍 区域与网络
- **区域管理** — 查看 / 启用 / 禁用 Opt-in 区域（支持全部 35 个 AWS 区域）
- **AZ / Local Zone / Wavelength Zone** 管理
- **VPC 对等** — 一键设置 Lightsail ↔ EC2 对等连接与路由

### 🔑 安全与 IAM
- **AWS 控制台联合登录** — 一键生成临时登录 URL（1 小时会话）
- **AccessKey 轮换** — 安全的先创建、后删除协议
- **凭证加密** — AES-256-GCM 服务端静态加密（DEK 本地托管）
- **Telegram 认证** — 通过 Bot 签发 token 链接，无公开登录入口

### 🚀 Lambda Worker 分布式部署
- 将 Worker Lambda 部署到任意 AWS 账号 / 区域
- SAM 部署进度 SSE 实时流式输出
- 健康探针每 2.5 分钟自动检测节点状态
- 健康感知请求路由 + 故障自动转移
- 失败栈自愈（ROLLBACK_COMPLETE 自动重建）

### 📱 通知与导出
- **Telegram Bot** — 节点上下线告警、vCPU 配额变化通知、远程 `/login` `/revoke` `/status`
- **数据导出** — CSV / TSV / JSON 格式导出账号数据

---

## 🏗️ 架构

```
                          ┌──────────────────────────────────┐
                          │        Oracle ARM 服务器          │
                          │                                  │
  浏览器 (SPA) ──HTTPS──▶ │  Caddy 2.11 (TLS + 静态文件)    │
                          │    ├─ / ──▶ React 静态 Bundle    │
                          │    └─ /deployer/* ──▶ Deployer   │
                          │         Node.js :8787            │
                          └──────────┬───────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
             Home Lambda      Worker Lambda    Worker Lambda
             (us-east-1)      (Region A)       (Region B)
             46 API 端点       代理 + IP 多样化   代理 + IP 多样化
```

| 层级 | 组件 | 说明 |
|------|------|------|
| **前端** | React 19 + Vite 8 + Tailwind CSS v4 | Liquid Glass 毛玻璃设计，全中文界面 |
| **后端** | Python 3.12 + AWS SAM + aioboto3 | 无状态 Lambda，46 个 API 端点，arm64 Graviton |
| **部署器** | Node.js (零依赖) | 本地守护进程，SAM 编排，SSE 流式输出，Telegram Bot |
| **TLS** | Caddy + Let's Encrypt | 自动续期，HTTP/2 + HTTP/3 |

---

## 📁 项目结构

```
aws-panel/
├── backend/                    # Python + SAM Lambda 后端
│   ├── src/
│   │   ├── handlers/api.py     # Lambda 入口 + 路由器 (46 路由)
│   │   ├── services/           # 业务逻辑 (EC2, Lightsail, 配额, 账单, IAM …)
│   │   ├── aws/clients.py      # boto3 客户端工厂 + 凭证管理
│   │   └── shared/             # 认证, 错误, 响应, 区域缓存
│   ├── template.yaml           # SAM / CloudFormation 模板
│   ├── Makefile                # build / deploy / logs / clean
│   └── scripts/                # 调试 & 本地调用工具
│
├── frontend/                   # React SPA 前端
│   ├── src/
│   │   ├── components/         # UI 组件 (30+ 个)
│   │   ├── pages/              # 页面 (仪表盘, EC2, Lightsail, Lambda 部署)
│   │   ├── lib/                # API 客户端, 会话, 端点路由, 加密, 数据目录
│   │   └── hooks/              # 主题, 页面标题
│   ├── index.html
│   └── vite.config.ts
│
├── deployer/                   # Node.js 部署守护进程
│   └── server.js               # HTTP API + SSE + Telegram Bot (1446 行)
│
├── scripts/
│   └── deploy-frontend.sh      # 一键构建 + 部署前端到 Caddy
│
├── USAGE.md                    # 运维手册
└── README.md                   # ← 你在这里
```

---

## 🚀 快速开始

### 前置要求

- **Node.js** ≥ 18
- **Python** ≥ 3.11 + [uv](https://github.com/astral-sh/uv) 包管理器
- **AWS SAM CLI** ≥ 1.x
- **AWS CLI** v2
- 一台带公网 IP 的服务器（推荐 Oracle Cloud ARM）

### 1. 部署后端

```bash
cd backend

# 安装依赖
uv sync

# 首次部署 (交互式配置)
make deploy-guided

# 后续部署
make deploy
```

部署完成后会生成：
- `.api-url` — API Gateway 端点地址
- `.api-key` — 64 位 hex API 密钥

### 2. 启动前端 (开发模式)

```bash
cd frontend
npm install

# 创建环境变量
cp .env.local.example .env.local
# 编辑 .env.local，填入 VITE_API_URL

npm run dev
# → http://localhost:5173
```

### 3. 启动 Deployer

```bash
cd deployer
node server.js
# → http://127.0.0.1:8787
```

### 4. 生产部署

```bash
# 构建前端并部署到 Caddy
bash scripts/deploy-frontend.sh
```

---

## 🔒 安全设计

采用纵深防御策略：

| 层级 | 机制 |
|------|------|
| **访问控制** | 无公开登录页面；通过 Telegram Bot `/login` 签发一次性 token 链接 |
| **凭证保护** | AWS AK/SK 使用 AES-256-GCM 加密存储；DEK 密钥本地管理 (chmod 600) |
| **传输安全** | Caddy 自动 TLS (Let's Encrypt)，强制 HSTS |
| **API 认证** | API Gateway `x-api-key` 拒绝未授权调用 |
| **内容安全** | CSP 策略限制 `connect-src` 仅允许 API Gateway 域 |
| **会话管理** | 64 位随机 token，30 天 TTL，支持远程撤销 |
| **日志安全** | CloudWatch 日志自动剥离请求体中的凭证 |

> **设计原则**: AWS 凭证仅在内存中存在于请求处理期间，从不写入日志或持久化到后端。浏览器端凭证由 Deployer 守护进程加密托管，不存储在浏览器中。

---

## 📡 API 端点一览

后端共提供 **46 个 API 端点**：

<details>
<summary>展开查看全部端点</summary>

| 分类 | 端点 | 说明 |
|------|------|------|
| **健康检查** | `GET /health` | 服务状态 |
| **账号** | `POST /accounts/verify` | 验证 AK/SK |
| **区域** | `POST /regions/list` | 已启用区域 |
| | `POST /regions/all` | 全部区域 + opt-in 状态 |
| | `POST /regions/enable` | 启用 opt-in 区域 |
| | `POST /regions/disable` | 禁用 opt-in 区域 |
| **AZ / Zone** | `POST /zones/list` | 可用区列表 |
| | `POST /zones/enable` | 启用 Local/Wavelength Zone |
| **配额** | `POST /quota/region` | 单区域 vCPU 配额 |
| | `POST /quota/region-detail` | 配额 + 实时用量 |
| | `POST /quota/all-regions` | 全区域扫描 |
| **EC2** | `POST /ec2/list` | 全区域实例列表 |
| | `POST /ec2/list-region` | 单区域列表 |
| | `POST /ec2/describe` | 描述指定实例 |
| | `POST /ec2/start` | 启动 |
| | `POST /ec2/stop` | 停止 |
| | `POST /ec2/reboot` | 重启 |
| | `POST /ec2/terminate` | 终止 |
| | `POST /ec2/change-ip` | 更换 IP |
| | `POST /ec2/rename` | 重命名 |
| | `POST /ec2/traffic` | 流量监控 |
| | `POST /ec2/create` | 创建实例 |
| **Lightsail** | `POST /lightsail/list` | 全区域列表 |
| | `POST /lightsail/list-region` | 单区域列表 |
| | `POST /lightsail/catalog` | Bundle 目录 |
| | `POST /lightsail/describe` | 描述实例 |
| | `POST /lightsail/start` | 启动 |
| | `POST /lightsail/stop` | 停止 |
| | `POST /lightsail/reboot` | 重启 |
| | `POST /lightsail/delete` | 删除 |
| | `POST /lightsail/rename` | 重命名 |
| | `POST /lightsail/change-ip` | 更换 IP |
| | `POST /lightsail/open-ports` | 开放全部端口 |
| | `POST /lightsail/traffic` | 流量监控 |
| | `POST /lightsail/create` | 创建实例 |
| **账单** | `POST /billing/monthly` | 月度明细 |
| | `POST /billing/summary` | 趋势汇总 |
| **Free Tier** | `POST /free-tier/state` | 套餐状态 |
| | `POST /free-tier/usage` | 逐项用量 |
| **网络** | `POST /peering/status` | VPC 对等状态 |
| | `POST /peering/setup` | 一键设置对等 |
| **IAM** | `POST /iam/signin-url` | 控制台登录 URL |
| | `POST /iam/keys/list` | AccessKey 列表 |
| | `POST /iam/keys/rotate` | 创建新 Key |
| | `POST /iam/keys/delete` | 删除 Key |
| **Bedrock** | `POST /bedrock/info` | 模型配额 |

</details>

---

## 🛠️ 开发命令

### 后端
```bash
cd backend
make build          # 构建 Lambda 包
make local          # 本地启动 SAM API (Docker)
make deploy         # 部署到 AWS
make logs           # 查看 CloudWatch 实时日志
make lint           # Ruff 代码检查
make fmt            # Ruff 自动格式化
make clean          # 清理构建产物
```

### 前端
```bash
cd frontend
npm run dev         # Vite 开发服务器 (HMR)
npm run build       # TypeScript 编译 + 生产构建
npm run preview     # 预览生产构建
npm run lint        # oxlint 代码检查
```

### Deployer
```bash
cd deployer
node server.js      # 启动守护进程
```

---

## 📝 许可证

私有项目，仅供个人使用。
