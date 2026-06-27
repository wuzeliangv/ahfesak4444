# AWS Panel — How to run

> [!TIP]
> **一键全新部署**: 如果你是在一台全新服务器上初始化部署，可以使用我们提供的一键部署脚本：
> ```bash
> bash scripts/setup.sh
> ```
> 该脚本会自动安装所有系统依赖（Caddy, Node, SAM, Python 等），部署后端，构建前端，并配置 Caddy TLS 和 Deployer 服务。

Two pieces, two terminals.

## 1. Backend (already deployed)

The Lambda + API Gateway stack is already deployed to **us-east-1**. You don't
need to do anything to use it. The endpoint and key are saved in:

```
backend/.api-url      # https://jf3f02xva9.execute-api.us-east-1.amazonaws.com
backend/.api-key      # 64-char hex, mode 600
```

Useful backend commands (run in `backend/`):

```bash
make logs                 # tail CloudWatch logs of the live Lambda
make deploy               # re-deploy after editing src/
sam delete --stack-name aws-panel --region us-east-1 --no-prompts   # tear it all down
```

## 2. Frontend (run on the Oracle ARM machine)

The frontend reads the API URL/key from `frontend/.env.local`, which was
generated from the backend artifacts. It's gitignored.

### Dev mode (Vite, hot reload)

```bash
cd frontend
npm run dev
```

This starts Vite on `0.0.0.0:5173`. Two ways to access it:

- **Locally on the Oracle box** (e.g. via `ssh -L 5173:localhost:5173 oracle`):
  open `http://localhost:5173` in your laptop browser.

- **Direct** from any machine: open `http://<oracle-public-ip>:5173`
  (you'll need to allow port 5173 in the Oracle Cloud security list and the
  host firewall).

### First-time flow in the browser

1. **Set master password.** First page asks you to create one — at least 8
   chars. This password derives the AES-GCM key that encrypts every AK/SK
   in IndexedDB. The password itself is never persisted and never sent to
   any server.
2. **Add account.** Click "添加账号". Paste an Access Key + Secret Key,
   pick a region, give it an alias.
   - The frontend POSTs to `/accounts/verify` first. If AWS rejects the
     credentials you'll see an inline error and nothing is stored.
   - On success, identity metadata (account ID, ARN, alias, root flag) is
     cached in plaintext alongside the encrypted credentials.
3. **vCPU number.** The big number on each card is the us-east-1 default
   on-demand vCPU quota (Service Quota `L-1216C47A`). Click the globe
   beside it to fan out across all opted-in regions.
4. **Lock.** Click "锁定" in the top-right to clear the master key from
   memory. AK/SK in IndexedDB stays encrypted; you'll need the master
   password to unlock again.

### Production mode (static bundle)

```bash
cd frontend
npm run build      # outputs dist/
npm run preview    # serves dist/ on port 4173
# or serve dist/ with any static file server (Caddy / nginx)
```

The bundle is ~263 KB JS / 30 KB CSS (gzip ~83 KB / ~6 KB).

## Project map

```
aws-panel/
├── backend/                  # Python + SAM
│   ├── src/                  # services + handlers
│   ├── template.yaml         # SAM template
│   ├── Makefile              # build / deploy / logs / clean
│   └── .api-url, .api-key    # generated; gitignored
└── frontend/                 # React 19 + Vite 8 + TS 6 + Tailwind v4
    ├── src/
    │   ├── lib/
    │   │   ├── crypto.ts     # PBKDF2 + AES-GCM
    │   │   ├── db.ts         # IndexedDB schema (idb wrapper)
    │   │   ├── vault.ts      # session + account CRUD
    │   │   ├── api.ts        # typed Lambda client
    │   │   ├── config.ts     # env vars
    │   │   └── regions.ts    # 17-region catalog
    │   ├── components/       # VaultGate, AccountCard, QuotaOrb, …
    │   ├── pages/AccountListPage.tsx
    │   └── App.tsx           # QueryClient + VaultGate + page
    └── .env.local            # generated; gitignored
```

## What's not done yet (next iterations)

- EC2 page (list + start/stop/reboot/terminate). Buttons exist on the cards
  but currently `alert()`. The backend endpoints are deployed and tested;
  only the UI is missing.
- Lightsail page — same status.
- Change-IP flow (frontend orchestrates stop → poll → start; backend
  primitives already exist).
- Multi-region Lambda deploy for max IP diversity. Single region (us-east-1)
  is what's deployed today.



---

## Production deployment (live)

The panel is published at **https://aws.se.sd**.

### Stack
| Layer | Component | Notes |
|---|---|---|
| TLS | Caddy 2.11 + Let's Encrypt | Auto-renewal, HTTP/2 + HTTP/3 |
| Static | `/var/www/aws-panel/` | Built React bundle, owned by `caddy:caddy` |
| Auth | **In-app login page** | Username + password derive the AES-256-GCM vault key (per-browser). No edge auth. |
| Backend | AWS Lambda (us-east-1) | Browser hits this directly via `VITE_API_URL` |

### Re-deploy after editing the frontend
```bash
bash /root/aws-panel/scripts/deploy-frontend.sh
```
That's it — runs `npm run build`, syncs to `/var/www/aws-panel/`, fixes
ownership, and reports Caddy health.

### Caddy ops
```bash
# Edit config
sudo $EDITOR /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile     # before reloading
sudo systemctl reload caddy                            # zero-downtime reload

# Logs
sudo journalctl -u caddy -f                            # systemd log
sudo tail -f /var/log/caddy/aws-panel.log              # access log (JSON)
```

### Cert lifecycle
- Lifetime: 90 days (Let's Encrypt standard)
- Renewal: automatic, Caddy renews ~30 days before expiry
- Storage: `/var/lib/caddy/.local/share/caddy/`
- No cron needed.

### Open ports
- **80**: only used during initial HTTP-01 challenge if Caddy has to fall
  back. Currently uses TLS-ALPN-01 on 443.
- **443**: HTTPS + HTTP/3 (UDP) — make sure the OCI VCN security list
  allows both TCP and UDP 443 if you want HTTP/3.

### Security layers (defense in depth)
1. **Domain obscurity** — only you know `aws.se.sd`.
2. **In-app login** — username + password together derive the vault key.
   The vault is per-browser: a stranger visiting on their own device gets an
   empty "create account" screen and can never see your accounts.
3. **HSTS** — once your browser has visited once, downgrades to HTTP are blocked.
4. **CSP** — only the AWS API Gateway origin can be `connect-src`'d.
5. **Master password** (the login password) — AK/SK in IndexedDB stay
   AES-GCM encrypted; without username+password they can't be decrypted.
6. **API Gateway `x-api-key`** — Lambda rejects unauthenticated calls.

Note: with edge auth removed, the static bundle (incl. the `x-api-key`) is
publicly downloadable by anyone who finds the URL. That key only lets someone
*use your Lambda as a proxy* — they still need their own AWS credentials to do
anything, and they can never reach your accounts (those need your master
password). If you later want to also hide the page itself, re-add a
`basic_auth` block to the Caddyfile or put it behind Cloudflare Access.
