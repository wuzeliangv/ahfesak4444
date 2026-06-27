#!/usr/bin/env node
'use strict';

/**
 * AWS Panel — local deployer daemon
 * =============================================================================
 * A thin, ZERO-DEPENDENCY localhost HTTP service that drives `sam` to deploy /
 * tear down the panel's worker Lambdas into arbitrary target accounts/regions.
 *
 * Why this exists (vs. a public deploy endpoint):
 *   - The browser SPA can't shell out to `sam`. This daemon does, on the box
 *     that already owns the source + `sam` toolchain.
 *   - No 30s Lambda timeout: CloudFormation create takes minutes; we stream
 *     live `sam` output back over SSE.
 *   - The deploy credentials (target account AK/SK) never touch a cloud
 *     endpoint — they're used locally as env vars for `sam` and discarded.
 *
 * Exposure model (decision B): Caddy reverse-proxies https://aws.se.sd/deployer/*
 * to 127.0.0.1:PORT, gated by the same x-api-key the rest of the panel uses
 * (read from backend/.api-key). The daemon itself binds localhost only.
 *
 * Endpoints (all under /deployer):
 *   GET  /deployer/health         — liveness (ungated)
 *   POST /deployer/deploy         — deploy 1+ targets; streams SSE progress
 *   GET  /deployer/deployments    — list registered worker endpoints
 *   POST /deployer/destroy        — `sam delete` a worker; streams SSE progress
 *
 * Registry: ~/.aws-panel/deployments.json (chmod 600). Stores worker URL +
 * per-endpoint api key + account/region metadata. NEVER stores AWS AK/SK.
 */

const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------
const PORT = Number(process.env.DEPLOYER_PORT || 8787);
const HOST = '127.0.0.1';
const BACKEND_DIR = process.env.DEPLOYER_BACKEND_DIR || '/root/aws-panel/backend';
const API_KEY_FILE = path.join(BACKEND_DIR, '.api-key');
const WORKER_STACK_NAME = process.env.DEPLOYER_STACK_NAME || 'aws-panel-worker';
// The worker template hardcodes FunctionName: aws-panel-api, so its Lambda log
// group name is deterministic. Lambda auto-creates this on first invoke, which
// can orphan it across stack deletes and break a later fresh CREATE.
const WORKER_LOG_GROUP = '/aws/lambda/aws-panel-api';
const DEFAULT_CORS_ORIGIN = process.env.DEPLOYER_CORS_ORIGIN || 'https://aws.se.sd';
const REGISTRY_DIR = path.join(os.homedir(), '.aws-panel');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'deployments.json');

// Health probing
const PROBE_INTERVAL_MS = Number(process.env.DEPLOYER_PROBE_INTERVAL_MS || 150000); // 2.5 min
const PROBE_TIMEOUT_MS = Number(process.env.DEPLOYER_PROBE_TIMEOUT_MS || 5000);
const DOWN_THRESHOLD = 2; // consecutive failures before a node is marked 'down'
// id -> { status, lastOkAt, lastCheckAt, latencyMs, consecutiveFails }
const _health = new Map();

// Local config (Telegram notifications). Holds a bot token — chmod 600.
const CONFIG_FILE = path.join(REGISTRY_DIR, 'deployer-config.json');
const TG_TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;
const TG_CHAT_RE = /^(-?\d+|@[A-Za-z0-9_]{3,})$/;
let _config = { telegram: { botToken: '', chatId: '' } };

// Sessions (access tokens). 30-day TTL by default. Token = 64-hex random.
const SESSIONS_FILE = path.join(REGISTRY_DIR, 'sessions.json');
const SESSION_TTL_MS = Number(process.env.DEPLOYER_SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000);
let _sessions = []; // [{ token, createdAt, expiresAt, label }]

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      _config = {
        telegram: {
          botToken: (parsed.telegram && parsed.telegram.botToken) || '',
          chatId: (parsed.telegram && parsed.telegram.chatId) || '',
        },
      };
    }
  } catch {
    /* no config yet */
  }
}

function saveConfig() {
  ensureRegistryDir();
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(_config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort */ }
}

/** Send a Telegram message with the configured bot. Returns {ok, error?}. */
async function sendTelegram(text) {
  const { botToken, chatId } = _config.telegram || {};
  if (!botToken || !chatId) return { ok: false, error: '尚未配置 Telegram token / chat id' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const j = await res.json().catch(() => ({}));
    if (j && j.ok) return { ok: true };
    return { ok: false, error: (j && j.description) || `Telegram HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Fire-and-forget notification (used by the probe loop). */
function notifyTelegram(text) {
  void sendTelegram(text);
}

// --------------------------------------------------------------------------
// Sessions / access tokens
// --------------------------------------------------------------------------
function loadSessions() {
  try {
    const a = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    if (Array.isArray(a)) _sessions = a;
  } catch {
    /* none yet */
  }
}

function saveSessions() {
  ensureRegistryDir();
  const tmp = SESSIONS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(_sessions, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SESSIONS_FILE);
  try { fs.chmodSync(SESSIONS_FILE, 0o600); } catch { /* best effort */ }
}

function pruneSessions() {
  const now = Date.now();
  const before = _sessions.length;
  _sessions = _sessions.filter((s) => s.expiresAt > now);
  if (_sessions.length !== before) saveSessions();
}

function createSession(label) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  _sessions.push({ token, createdAt: now, expiresAt, label: label || null });
  saveSessions();
  return { token, expiresAt };
}

function validateSession(token) {
  if (!token) return null;
  const now = Date.now();
  const s = _sessions.find((x) => x.token === token);
  return s && s.expiresAt > now ? s : null;
}

function revokeSession(token) {
  const before = _sessions.length;
  _sessions = _sessions.filter((s) => s.token !== token);
  if (_sessions.length !== before) {
    saveSessions();
    return true;
  }
  return false;
}

function revokeAllSessions() {
  const n = _sessions.length;
  _sessions = [];
  saveSessions();
  return n;
}

/** Extract a session token from Authorization: Bearer or x-panel-token. */
function tokenFromReq(req) {
  const auth = req.headers['authorization'] || '';
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const x = req.headers['x-panel-token'];
  if (typeof x === 'string' && x) return x.trim();
  return null;
}

// --------------------------------------------------------------------------
// Account store — DEK-encrypted AWS credentials at rest (route S).
// --------------------------------------------------------------------------
const DEK_FILE = path.join(REGISTRY_DIR, 'dek.key');
const ACCOUNTS_FILE = path.join(REGISTRY_DIR, 'accounts.json');
let _dek = null; // Buffer(32)
let _store = { version: 1, accounts: [], groups: [], deployerAccounts: [] };

function loadOrCreateDek() {
  try {
    const hex = fs.readFileSync(DEK_FILE, 'utf8').trim();
    const buf = Buffer.from(hex, 'hex');
    if (buf.length === 32) { _dek = buf; return; }
  } catch {
    /* generate below */
  }
  _dek = crypto.randomBytes(32);
  ensureRegistryDir();
  const tmp = DEK_FILE + '.tmp';
  fs.writeFileSync(tmp, _dek.toString('hex'), { mode: 0o600 });
  fs.renameSync(tmp, DEK_FILE);
  try { fs.chmodSync(DEK_FILE, 0o600); } catch { /* best effort */ }
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _dek, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptSecret(enc) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', _dek, Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(enc.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function loadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.accounts)) {
      _store = {
        version: parsed.version || 1,
        accounts: parsed.accounts,
        groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        deployerAccounts: Array.isArray(parsed.deployerAccounts) ? parsed.deployerAccounts : [],
      };
    }
  } catch {
    /* none yet */
  }
}

function saveStore() {
  ensureRegistryDir();
  const tmp = ACCOUNTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ACCOUNTS_FILE);
  try { fs.chmodSync(ACCOUNTS_FILE, 0o600); } catch { /* best effort */ }
}

/** Public (creds-stripped) view of an account record. */
function accountMeta(a) {
  return {
    id: a.id,
    alias: a.alias,
    group: a.group ?? null,
    note: a.note ?? null,
    defaultRegion: a.defaultRegion,
    color: a.color ?? null,
    verified: a.verified ?? null,
    quota: a.quota ?? null,
    pinnedRegion: a.pinnedRegion ?? null,
    monitorVcpu: !!a.monitorVcpu,
    vcpuValue: a.vcpuValue ?? null,
    vcpuCheckedAt: a.vcpuCheckedAt ?? null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function findAccount(id) {
  return _store.accounts.find((a) => a.id === id) || null;
}

// vCPU quota monitoring -----------------------------------------------------
const VCPU_QUOTA_CODE = 'L-1216C47A'; // Running On-Demand Standard instances
const VCPU_MONITOR_INTERVAL_MS = Number(process.env.DEPLOYER_VCPU_INTERVAL_MS || 65 * 60 * 1000);

/** Pick a usable worker, preferring `preferRegion`, else any healthy node. */
function pickWorker(preferRegion) {
  const reg = loadRegistry();
  const usable = reg.deployments.filter((d) => d.url && d.apiKey && healthOf(d.id).status !== 'down');
  if (preferRegion) {
    const inRegion = usable.filter((d) => d.region === preferRegion);
    if (inRegion.length) return inRegion[Math.floor(Math.random() * inRegion.length)];
  }
  if (usable.length) return usable[Math.floor(Math.random() * usable.length)];
  return null;
}

/** Query a region's vCPU quota THROUGH a worker node (egress = node IP). */
async function fetchVcpuViaWorker(worker, accessKey, secretKey, region) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`${worker.url}/quota/region`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': worker.apiKey },
      body: JSON.stringify({ credentials: { access_key: accessKey, secret_key: secretKey }, region }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const j = await res.json();
    if (j && j.ok && j.data && typeof j.data.value === 'number') return j.data.value;
    return null;
  } catch {
    return null;
  }
}

/** Fallback: query via the local aws CLI (only when no node is available). */
async function fetchVcpuViaLocal(accessKey, secretKey, region) {
  let env;
  try {
    env = targetEnv(region, accessKey, secretKey);
  } catch {
    return null;
  }
  const r = await runCapture('aws', [
    'service-quotas', 'get-service-quota',
    '--service-code', 'ec2',
    '--quota-code', VCPU_QUOTA_CODE,
    '--region', region,
    '--query', 'Quota.Value',
    '--output', 'text',
  ], { env });
  if (r.code !== 0 || !r.stdout) return null;
  const v = parseFloat(r.stdout);
  return isFinite(v) ? v : null;
}

/**
 * Check one account's default-region vCPU quota and notify on change.
 * Routes the read through the account's egress node (pinned → default →
 * any healthy node) so it leaves from a node IP, consistent with the
 * multi-IP design. Falls back to the local box only if no node exists.
 */
async function checkAccountVcpu(rec) {
  let accessKey, secretKey;
  try {
    accessKey = decryptSecret(rec.ak);
    secretKey = decryptSecret(rec.sk);
  } catch {
    return;
  }
  const region = rec.defaultRegion;
  const worker = pickWorker(rec.pinnedRegion || region);

  let val = null;
  if (worker) val = await fetchVcpuViaWorker(worker, accessKey, secretKey, region);
  if (val == null) val = await fetchVcpuViaLocal(accessKey, secretKey, region);
  if (val == null || !isFinite(val)) return;

  const prev = rec.vcpuValue;
  rec.vcpuValue = val;
  rec.vcpuCheckedAt = Date.now();
  saveStore();

  if (prev != null && prev !== val) {
    notifyTelegram(
      `📊 vCPU 配额变化\n账号: ${rec.alias} (${(rec.verified && rec.verified.accountId) || ''})\n区域: ${region}\n${prev} → ${val} vCPU`,
    );
  }
}

/** Periodic sweep of all accounts with monitoring enabled. */
async function monitorVcpuAll() {
  for (const rec of _store.accounts) {
    if (!rec.monitorVcpu) continue;
    try {
      await checkAccountVcpu(rec);
    } catch {
      /* skip one bad account */
    }
  }
}

/** Public (creds-stripped) view of a deployer (host) account. */
function deployerAccountMeta(a) {
  return {
    id: a.id,
    alias: a.alias,
    defaultRegion: a.defaultRegion,
    note: a.note ?? null,
    verified: a.verified ?? null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function validAccountInput(input) {
  if (!input || typeof input !== 'object') return 'body 非对象';
  if (!AK_RE.test(input.accessKey || '')) return 'accessKey 格式非法';
  if (typeof input.secretKey !== 'string' || input.secretKey.length < 16) return 'secretKey 格式非法';
  if (!REGION_RE.test(input.defaultRegion || '')) return 'defaultRegion 非法';
  return null;
}

function buildAccountRecord(input) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    alias: String(input.alias || '').slice(0, 256) || (input.verified && input.verified.accountId) || 'account',
    group: input.group || null,
    note: input.note || null,
    defaultRegion: input.defaultRegion,
    color: input.color || null,
    ak: encryptSecret(input.accessKey),
    sk: encryptSecret(input.secretKey),
    verified: input.verified || null,
    quota: input.quota || null,
    pinnedRegion: input.pinnedRegion || null,
    monitorVcpu: !!input.monitorVcpu,
    vcpuValue: null,
    vcpuCheckedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

// --------------------------------------------------------------------------
// Telegram command bot (long-polling getUpdates). Only the configured chat id
// is honored. Issues login links via /login.
// --------------------------------------------------------------------------
const PANEL_BASE_URL = process.env.DEPLOYER_PANEL_URL || DEFAULT_CORS_ORIGIN;
let _tgOffset = 0;
let _tgStarted = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tgApi(method, query) {
  const { botToken } = _config.telegram || {};
  if (!botToken) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}${query || ''}`, {
      signal: ctrl.signal,
    });
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Skip any backlog so a restart doesn't replay old commands. */
async function drainTgBacklog() {
  const j = await tgApi('getUpdates', '?timeout=0&offset=-1');
  if (j && j.ok && Array.isArray(j.result) && j.result.length) {
    _tgOffset = j.result[j.result.length - 1].update_id + 1;
  }
}

async function handleTgUpdate(upd) {
  const msg = upd.message || upd.edited_message;
  if (!msg || typeof msg.text !== 'string') return;
  const chatId = _config.telegram.chatId;
  if (String(msg.chat && msg.chat.id) !== String(chatId)) return; // only the owner

  const cmd = msg.text.trim().split(/\s+/)[0].toLowerCase().replace(/@.*/, '');
  if (cmd === '/login') {
    const { token, expiresAt } = createSession('telegram');
    const days = Math.round((expiresAt - Date.now()) / 86400000);
    await sendTelegram(
      `🔑 登录链接(${days} 天有效,请勿外传):\n${PANEL_BASE_URL}/#token=${token}`,
    );
  } else if (cmd === '/revoke') {
    const n = revokeAllSessions();
    await sendTelegram(`已吊销全部登录会话(${n} 个),所有旧链接立即失效。`);
  } else if (cmd === '/status') {
    pruneSessions();
    const nodes = loadRegistry().deployments.length;
    await sendTelegram(`面板状态:\n• 活跃会话 ${_sessions.length} 个\n• 已部署节点 ${nodes} 个`);
  } else if (cmd === '/start' || cmd === '/help') {
    await sendTelegram('可用指令:\n/login 获取登录链接\n/revoke 吊销所有登录\n/status 查看状态');
  }
}

async function tgPollLoop() {
  if (_tgStarted) return;
  _tgStarted = true;
  if (_config.telegram.botToken) await drainTgBacklog();
  for (;;) {
    if (!_config.telegram.botToken || !_config.telegram.chatId) {
      await sleep(5000);
      continue;
    }
    const j = await tgApi('getUpdates', `?timeout=25&offset=${_tgOffset}`);
    if (j && j.ok && Array.isArray(j.result)) {
      for (const upd of j.result) {
        _tgOffset = Math.max(_tgOffset, upd.update_id + 1);
        try {
          await handleTgUpdate(upd);
        } catch {
          /* ignore one bad update */
        }
      }
    } else {
      // network error or getUpdates conflict — back off before retrying
      await sleep(3000);
    }
  }
}

const REGION_RE = /^[a-z]{2}-[a-z]+-\d{1,2}$/;
const AK_RE = /^[A-Z0-9]{16,128}$/;
const ORIGIN_RE = /^(\*|https?:\/\/[a-zA-Z0-9.\-:]+)$/;

// --------------------------------------------------------------------------
// Gate key (shared panel api key)
// --------------------------------------------------------------------------
function readGateKey() {
  try {
    return fs.readFileSync(API_KEY_FILE, 'utf8').trim();
  } catch {
    return (process.env.DEPLOYER_API_KEY || '').trim();
  }
}
const GATE_KEY = readGateKey();
if (!GATE_KEY) {
  console.error(`[deployer] WARNING: no gate key found (looked in ${API_KEY_FILE} and $DEPLOYER_API_KEY). Refusing all gated requests.`);
}

// --------------------------------------------------------------------------
// Registry helpers
// --------------------------------------------------------------------------
function ensureRegistryDir() {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
}

function loadRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.deployments)) return { version: 1, deployments: [] };
    return parsed;
  } catch {
    return { version: 1, deployments: [] };
  }
}

function saveRegistry(reg) {
  ensureRegistryDir();
  const tmp = REGISTRY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, REGISTRY_FILE);
  try { fs.chmodSync(REGISTRY_FILE, 0o600); } catch { /* best effort */ }
}

function deploymentId(accountId, region) {
  return `${accountId || 'unknown'}:${region}`;
}

function upsertDeployment(entry) {
  const reg = loadRegistry();
  const id = entry.id;
  const idx = reg.deployments.findIndex((d) => d.id === id);
  if (idx >= 0) reg.deployments[idx] = { ...reg.deployments[idx], ...entry };
  else reg.deployments.push(entry);
  saveRegistry(reg);
}

function removeDeployment(id) {
  const reg = loadRegistry();
  const before = reg.deployments.length;
  reg.deployments = reg.deployments.filter((d) => d.id !== id);
  saveRegistry(reg);
  return reg.deployments.length < before;
}

// --------------------------------------------------------------------------
// SSE helpers
// --------------------------------------------------------------------------
function sseInit(res, origin) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': origin || '*',
  });
  // Initial comment flushes headers immediately.
  res.write(': connected\n\n');
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// --------------------------------------------------------------------------
// Subprocess helpers
// --------------------------------------------------------------------------

/** Run a command, streaming each stdout/stderr line to SSE as a `log` event. */
function runStreaming(res, target, cmd, args, opts) {
  return new Promise((resolve) => {
    sse(res, 'log', { target, line: `$ ${cmd} ${args.join(' ')}` });
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let outBuf = '';
    let errBuf = '';
    const pump = (chunk, isErr) => {
      let buf = (isErr ? errBuf : outBuf) + chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep partial line
      if (isErr) errBuf = buf; else outBuf = buf;
      for (const line of lines) {
        if (line.trim() !== '') sse(res, 'log', { target, line, stream: isErr ? 'stderr' : 'stdout' });
      }
    };
    child.stdout.on('data', (c) => pump(c, false));
    child.stderr.on('data', (c) => pump(c, true));
    child.on('error', (e) => {
      sse(res, 'log', { target, line: `[spawn error] ${e.message}`, stream: 'stderr' });
      resolve({ code: -1 });
    });
    child.on('close', (code) => {
      if (outBuf.trim()) sse(res, 'log', { target, line: outBuf, stream: 'stdout' });
      if (errBuf.trim()) sse(res, 'log', { target, line: errBuf, stream: 'stderr' });
      resolve({ code: code == null ? -1 : code });
    });
  });
}

/** Run a command and capture stdout (no streaming). */
function runCapture(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }));
    child.on('close', (code) => resolve({ code: code == null ? -1 : code, stdout: out.trim(), stderr: err.trim() }));
  });
}

function targetEnv(region, accessKey, secretKey) {
  const env = { ...process.env };
  env.AWS_ACCESS_KEY_ID = accessKey;
  env.AWS_SECRET_ACCESS_KEY = secretKey;
  env.AWS_DEFAULT_REGION = region;
  env.AWS_REGION = region;
  // Never let an ambient profile/token leak into the target deploy.
  delete env.AWS_SESSION_TOKEN;
  delete env.AWS_PROFILE;
  delete env.AWS_SECURITY_TOKEN;
  return env;
}

async function getAccountId(env) {
  const r = await runCapture('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], { env });
  if (r.code === 0 && /^\d{12}$/.test(r.stdout)) return r.stdout;
  return null;
}

async function getStackUrl(env, region) {
  const r = await runCapture('aws', [
    'cloudformation', 'describe-stacks',
    '--stack-name', WORKER_STACK_NAME,
    '--region', region,
    '--query', "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue",
    '--output', 'text',
  ], { env });
  if (r.code === 0 && r.stdout && r.stdout !== 'None') return r.stdout.trim();
  return null;
}

/** Return the worker stack's status in a region, or null if it doesn't exist. */
async function getStackStatus(env, region) {
  const r = await runCapture('aws', [
    'cloudformation', 'describe-stacks',
    '--stack-name', WORKER_STACK_NAME,
    '--region', region,
    '--query', 'Stacks[0].StackStatus',
    '--output', 'text',
  ], { env });
  if (r.code === 0 && r.stdout && r.stdout !== 'None') return r.stdout.trim();
  return null;
}

/** Run `fn` over `items` with bounded concurrency. */
async function mapLimit(items, limit, fn) {
  let i = 0;
  const n = Math.min(limit, items.length);
  const workers = Array.from({ length: Math.max(n, 0) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// Default-enabled (opt-in-not-required) commercial regions — fallback when
// ec2:DescribeRegions can't be called.
const DEFAULT_ENABLED_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ca-central-1', 'sa-east-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'ap-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-southeast-1', 'ap-southeast-2',
];

/**
 * Regions enabled for the account (default-enabled + opted-in), excluding
 * disabled opt-in regions. Returns null if the call fails (no permission).
 */
async function getEnabledRegions(env) {
  const r = await runCapture('aws', [
    'ec2', 'describe-regions',
    '--all-regions',
    '--region', 'us-east-1',
    '--query', "Regions[?OptInStatus!='not-opted-in'].RegionName",
    '--output', 'text',
  ], { env });
  if (r.code === 0 && r.stdout) {
    const regions = r.stdout.split(/\s+/).filter((x) => REGION_RE.test(x));
    if (regions.length) return regions;
  }
  return null;
}

// --------------------------------------------------------------------------
// Health probing
// --------------------------------------------------------------------------
function healthOf(id) {
  return (
    _health.get(id) || {
      status: 'unknown',
      lastOkAt: null,
      lastCheckAt: null,
      latencyMs: null,
      consecutiveFails: 0,
    }
  );
}

function registryWithHealth() {
  const reg = loadRegistry();
  return {
    ...reg,
    deployments: reg.deployments.map((d) => ({ ...d, health: healthOf(d.id) })),
  };
}

/** Probe one worker's /health (ungated). Updates the in-memory health map. */
async function probeOne(dep) {
  const id = dep.id;
  const prev = healthOf(id);
  const prevStatus = prev.status;
  const now = new Date().toISOString();
  const start = Date.now();
  let ok = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`${dep.url}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    ok = res.ok;
  } catch {
    ok = false;
  }
  let latencyMs = null;
  if (ok) {
    latencyMs = Date.now() - start;
    _health.set(id, {
      status: 'up',
      lastOkAt: now,
      lastCheckAt: now,
      latencyMs,
      consecutiveFails: 0,
    });
  } else {
    const fails = prev.consecutiveFails + 1;
    const status =
      fails >= DOWN_THRESHOLD ? 'down' : prev.status === 'unknown' ? 'unknown' : prev.status;
    _health.set(id, {
      status,
      lastOkAt: prev.lastOkAt,
      lastCheckAt: now,
      latencyMs: null,
      consecutiveFails: fails,
    });
  }

  // Notify only on a status transition (natural debounce — staying down won't re-notify).
  const nextStatus = healthOf(id).status;
  const who = `${dep.alias || dep.accountId} (${dep.accountId})`;
  if (prevStatus !== 'down' && nextStatus === 'down') {
    notifyTelegram(
      `🔴 Lambda 节点离线\n账号: ${who}\n区域: ${dep.region}\n地址: ${dep.url}\n时间: ${new Date().toLocaleString('zh-CN')}`,
    );
  } else if (prevStatus === 'down' && nextStatus === 'up') {
    notifyTelegram(
      `🟢 Lambda 节点恢复\n账号: ${who}\n区域: ${dep.region}\n延迟: ${latencyMs}ms\n时间: ${new Date().toLocaleString('zh-CN')}`,
    );
  }
}

/** Probe every registered worker; prune health for removed deployments. */
async function probeAll() {
  const reg = loadRegistry();
  const ids = new Set(reg.deployments.map((d) => d.id));
  for (const id of [..._health.keys()]) if (!ids.has(id)) _health.delete(id);
  await mapLimit(reg.deployments, 8, probeOne);
}

// --------------------------------------------------------------------------
// Deploy / destroy orchestration
// --------------------------------------------------------------------------
let samBuilt = false; // build once per daemon lifetime (code is account-agnostic)

async function ensureBuild(res) {
  if (samBuilt) return true;
  sse(res, 'phase', { phase: 'build', message: '构建部署包 (sam build)…' });
  const r = await runStreaming(res, '_build', 'sam', ['build', '--cached'], { cwd: BACKEND_DIR });
  if (r.code !== 0) {
    sse(res, 'phase', { phase: 'build', message: 'sam build 失败', ok: false });
    return false;
  }
  samBuilt = true;
  return true;
}

async function deployTarget(res, target, corsOrigin) {
  const { alias, region, accessKey, secretKey } = target;
  const label = `${alias || 'account'} / ${region}`;
  sse(res, 'target-start', { target: label, region });

  const env = targetEnv(region, accessKey, secretKey);

  // Resolve account id (also acts as a credential sanity check).
  const accountId = await getAccountId(env);
  if (!accountId) {
    sse(res, 'target-error', { target: label, region, error: '凭证无效或无 sts:GetCallerIdentity 权限' });
    return { ok: false, label };
  }
  sse(res, 'log', { target: label, line: `account: ${accountId}` });

  // Pre-flight self-heal: a prior failed attempt can leave the stack in an
  // un-updatable state, and Lambda-created log groups can orphan across stack
  // deletes — both break a fresh deploy. Clean them up first.
  const FAILED_STATES = new Set([
    'ROLLBACK_COMPLETE',
    'ROLLBACK_FAILED',
    'CREATE_FAILED',
    'DELETE_FAILED',
    'UPDATE_ROLLBACK_FAILED',
    'REVIEW_IN_PROGRESS',
  ]);
  let status = await getStackStatus(env, region);
  if (status && FAILED_STATES.has(status)) {
    sse(res, 'log', { target: label, line: `栈处于 ${status},先删除再重建…` });
    await runStreaming(
      res,
      label,
      'sam',
      ['delete', '--stack-name', WORKER_STACK_NAME, '--region', region, '--no-prompts'],
      { cwd: BACKEND_DIR, env },
    );
    status = null;
  }
  if (!status) {
    // Fresh CREATE coming — drop any orphaned log group so the template's
    // explicit LogGroup resource doesn't fail with AlreadyExists.
    const lg = await runCapture(
      'aws',
      ['logs', 'delete-log-group', '--log-group-name', WORKER_LOG_GROUP, '--region', region],
      { env },
    );
    if (lg.code === 0) {
      sse(res, 'log', { target: label, line: `清理残留日志组 ${WORKER_LOG_GROUP}` });
    }
  }

  const apiKey = crypto.randomBytes(32).toString('hex');

  const args = [
    'deploy',
    '--stack-name', WORKER_STACK_NAME,
    '--region', region,
    '--resolve-s3',
    '--no-confirm-changeset',
    '--no-fail-on-empty-changeset',
    '--capabilities', 'CAPABILITY_IAM',
    '--parameter-overrides', `ApiKey=${apiKey}`, `CorsAllowedOrigin=${corsOrigin}`,
  ];
  const r = await runStreaming(res, label, 'sam', args, { cwd: BACKEND_DIR, env });
  if (r.code !== 0) {
    sse(res, 'target-error', { target: label, region, accountId, error: `sam deploy 退出码 ${r.code}` });
    return { ok: false, label };
  }

  const url = await getStackUrl(env, region);
  if (!url) {
    sse(res, 'target-error', { target: label, region, accountId, error: '部署完成但读不到 ApiUrl 输出' });
    return { ok: false, label };
  }

  const id = deploymentId(accountId, region);
  const entry = {
    id,
    alias: alias || null,
    accountId,
    accountRef: target.accountRef || null,
    region,
    stackName: WORKER_STACK_NAME,
    url,
    apiKey,
    deployedAt: new Date().toISOString(),
  };
  upsertDeployment(entry);
  sse(res, 'target-done', { target: label, region, accountId, url, id });
  return { ok: true, label, url, id };
}

async function destroyTarget(res, target) {
  const { region, accessKey, secretKey, accountId: hintAccountId } = target;
  const label = `${hintAccountId || 'account'} / ${region}`;
  sse(res, 'target-start', { target: label, region });

  const env = targetEnv(region, accessKey, secretKey);
  const accountId = hintAccountId || (await getAccountId(env));

  const args = [
    'delete',
    '--stack-name', WORKER_STACK_NAME,
    '--region', region,
    '--no-prompts',
  ];
  const r = await runStreaming(res, label, 'sam', args, { cwd: BACKEND_DIR, env });
  if (r.code !== 0) {
    sse(res, 'target-error', { target: label, region, error: `sam delete 退出码 ${r.code}` });
    return { ok: false, label };
  }

  const id = deploymentId(accountId, region);
  removeDeployment(id);
  sse(res, 'target-done', { target: label, region, id, destroyed: true });
  return { ok: true, label, id };
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------
function validateTarget(t) {
  if (!t || typeof t !== 'object') return 'target 不是对象';
  if (!REGION_RE.test(t.region || '')) return `region 非法: ${t.region}`;
  if (!AK_RE.test(t.accessKey || '')) return 'accessKey 格式非法';
  if (typeof t.secretKey !== 'string' || t.secretKey.length < 16) return 'secretKey 格式非法';
  return null;
}

// --------------------------------------------------------------------------
// HTTP plumbing
// --------------------------------------------------------------------------
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj, origin) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || '*',
  });
  res.end(body);
}

function gated(req) {
  // Session token only (Bearer / x-panel-token). The legacy shared key is no
  // longer accepted — the public bundle carries no key, and the home API key
  // is served via /runtime-config after login.
  return !!validateSession(tokenFromReq(req));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '*';
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathName = url.pathname.replace(/\/+$/, '') || '/';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, Authorization, X-Panel-Token',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }

  // Liveness — ungated, returns nothing sensitive.
  if (req.method === 'GET' && pathName === '/deployer/health') {
    return json(res, 200, { status: 'ok', gateKeyLoaded: !!GATE_KEY, stackName: WORKER_STACK_NAME }, origin);
  }

  // Validate the current session token (this IS the auth check, so ungated).
  if (req.method === 'GET' && pathName === '/deployer/auth/check') {
    const s = validateSession(tokenFromReq(req));
    if (s) return json(res, 200, { ok: true, expiresAt: s.expiresAt }, origin);
    return json(res, 401, { ok: false }, origin);
  }

  // Revoke the caller's own session token.
  if (req.method === 'POST' && pathName === '/deployer/auth/logout') {
    const t = tokenFromReq(req);
    if (t) revokeSession(t);
    return json(res, 200, { ok: true }, origin);
  }

  // Everything below is gated.
  if (!gated(req)) {
    return json(res, 401, { error: 'Unauthorized', message: 'missing or invalid session token' }, origin);
  }

  // Runtime config — home API key served only to authenticated sessions
  // (keeps the public bundle free of secrets).
  if (req.method === 'GET' && pathName === '/deployer/runtime-config') {
    return json(res, 200, { homeApiKey: GATE_KEY }, origin);
  }

  // List deployments (with health)
  if (req.method === 'GET' && pathName === '/deployer/deployments') {
    return json(res, 200, registryWithHealth(), origin);
  }

  // Force an immediate health probe of all nodes, then return the registry.
  if (req.method === 'POST' && pathName === '/deployer/probe') {
    await probeAll();
    return json(res, 200, registryWithHealth(), origin);
  }

  // Telegram notification config — never returns the raw token.
  if (req.method === 'GET' && pathName === '/deployer/config') {
    return json(res, 200, {
      telegram: { chatId: _config.telegram.chatId, tokenSet: !!_config.telegram.botToken },
    }, origin);
  }

  if (req.method === 'POST' && pathName === '/deployer/config') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    if (body.clear) {
      _config = { telegram: { botToken: '', chatId: '' } };
      saveConfig();
      return json(res, 200, { ok: true, telegram: { chatId: '', tokenSet: false } }, origin);
    }
    const tg = body.telegram || {};
    const chatId = String(tg.chatId || '').trim();
    // Blank token = keep the existing one (so the UI never has to re-show it).
    let botToken = String(tg.botToken || '').trim();
    if (!botToken) botToken = _config.telegram.botToken;
    if (!botToken || !chatId) return json(res, 400, { error: 'BadRequest', message: '需要 botToken 和 chatId' }, origin);
    if (!TG_TOKEN_RE.test(botToken)) return json(res, 400, { error: 'BadRequest', message: 'token 格式不正确' }, origin);
    if (!TG_CHAT_RE.test(chatId)) return json(res, 400, { error: 'BadRequest', message: 'chat id 格式不正确(数字或 @用户名)' }, origin);
    _config = { telegram: { botToken, chatId } };
    saveConfig();
    return json(res, 200, { ok: true, telegram: { chatId, tokenSet: true } }, origin);
  }

  if (req.method === 'POST' && pathName === '/deployer/config/test') {
    const r = await sendTelegram('✅ AWS 面板:Telegram 通知已连通');
    return json(res, r.ok ? 200 : 400, r, origin);
  }

  // ---- Account store (DEK-encrypted) -------------------------------------
  if (req.method === 'GET' && pathName === '/deployer/accounts') {
    return json(res, 200, { accounts: _store.accounts.map(accountMeta), groups: _store.groups }, origin);
  }

  if (req.method === 'POST' && pathName === '/deployer/accounts/add') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const err = validAccountInput(body);
    if (err) return json(res, 400, { error: 'BadRequest', message: err }, origin);
    const rec = buildAccountRecord(body);
    _store.accounts.push(rec);
    saveStore();
    return json(res, 200, accountMeta(rec), origin);
  }

  if (req.method === 'POST' && pathName === '/deployer/accounts/update') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const rec = findAccount(body.id);
    if (!rec) return json(res, 404, { error: 'NotFound', message: 'account not found' }, origin);
    const credsProvided = !!(body.accessKey || body.secretKey);
    if (credsProvided && (!AK_RE.test(body.accessKey || '') || String(body.secretKey || '').length < 16)) {
      return json(res, 400, { error: 'BadRequest', message: '凭证格式非法' }, origin);
    }
    if (body.defaultRegion !== undefined && !REGION_RE.test(body.defaultRegion)) {
      return json(res, 400, { error: 'BadRequest', message: 'region 非法' }, origin);
    }
    for (const f of ['alias', 'group', 'note', 'defaultRegion', 'color', 'verified', 'pinnedRegion']) {
      if (body[f] !== undefined) rec[f] = body[f];
    }
    let enabledMonitor = false;
    if (body.monitorVcpu !== undefined) {
      const next = !!body.monitorVcpu;
      enabledMonitor = next && !rec.monitorVcpu;
      rec.monitorVcpu = next;
      if (!next) { rec.vcpuValue = null; rec.vcpuCheckedAt = null; }
    }
    if (credsProvided) {
      rec.ak = encryptSecret(body.accessKey);
      rec.sk = encryptSecret(body.secretKey);
    }
    rec.updatedAt = Date.now();
    saveStore();
    // Establish a baseline immediately when monitoring is switched on.
    if (enabledMonitor) void checkAccountVcpu(rec);
    return json(res, 200, accountMeta(rec), origin);
  }

  if (req.method === 'POST' && pathName === '/deployer/accounts/delete') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const before = _store.accounts.length;
    _store.accounts = _store.accounts.filter((a) => a.id !== body.id);
    if (_store.accounts.length !== before) saveStore();
    return json(res, 200, { ok: true }, origin);
  }

  if (req.method === 'POST' && pathName === '/deployer/accounts/creds') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const rec = findAccount(body.id);
    if (!rec) return json(res, 404, { error: 'NotFound', message: 'account not found' }, origin);
    try {
      return json(res, 200, { accessKey: decryptSecret(rec.ak), secretKey: decryptSecret(rec.sk) }, origin);
    } catch {
      return json(res, 500, { error: 'DecryptError', message: '解密失败(DEK 可能已变更)' }, origin);
    }
  }

  if (req.method === 'POST' && pathName === '/deployer/accounts/quota') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const rec = findAccount(body.id);
    if (!rec) return json(res, 404, { error: 'NotFound', message: 'account not found' }, origin);
    rec.quota = { ...(rec.quota || {}), ...(body.quota || {}), fetchedAt: Date.now() };
    rec.updatedAt = Date.now();
    saveStore();
    return json(res, 200, accountMeta(rec), origin);
  }

  if (req.method === 'POST' && pathName === '/deployer/accounts/import') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const items = Array.isArray(body.accounts) ? body.accounts : [];
    let imported = 0;
    let skipped = 0;
    for (const it of items) {
      if (validAccountInput(it)) { skipped++; continue; }
      _store.accounts.push(buildAccountRecord(it));
      imported++;
    }
    // Merge any groups referenced.
    const names = new Set(_store.groups.map((g) => g.name));
    for (const it of items) {
      if (it.group && !names.has(it.group)) {
        _store.groups.push({ name: it.group, createdAt: Date.now() });
        names.add(it.group);
      }
    }
    if (imported) saveStore();
    return json(res, 200, { imported, skipped }, origin);
  }

  // ---- Groups ------------------------------------------------------------
  if (req.method === 'POST' && pathName === '/deployer/groups/add') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const name = String(body.name || '').trim();
    if (!name) return json(res, 400, { error: 'BadRequest', message: '分组名为空' }, origin);
    if (_store.groups.some((g) => g.name === name)) {
      return json(res, 400, { error: 'BadRequest', message: '分组已存在' }, origin);
    }
    _store.groups.push({ name, createdAt: Date.now() });
    saveStore();
    return json(res, 200, { ok: true }, origin);
  }

  if (req.method === 'POST' && pathName === '/deployer/groups/delete') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const name = String(body.name || '').trim();
    _store.groups = _store.groups.filter((g) => g.name !== name);
    saveStore();
    return json(res, 200, { ok: true }, origin);
  }

  if (req.method === 'POST' && pathName === '/deployer/groups/rename') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const oldName = String(body.oldName || '').trim();
    const newName = String(body.newName || '').trim();
    if (!oldName || !newName) return json(res, 400, { error: 'BadRequest', message: '名称为空' }, origin);
    const g = _store.groups.find((x) => x.name === oldName);
    if (!g) return json(res, 404, { error: 'NotFound', message: '分组不存在' }, origin);
    if (_store.groups.some((x) => x.name === newName)) {
      return json(res, 400, { error: 'BadRequest', message: '目标分组名已存在' }, origin);
    }
    g.name = newName;
    let updated = 0;
    for (const a of _store.accounts) {
      if (a.group === oldName) { a.group = newName; a.updatedAt = Date.now(); updated++; }
    }
    saveStore();
    return json(res, 200, { ok: true, accountsUpdated: updated }, origin);
  }

  // ---- Deployer (host) accounts — separate set used to host worker Lambdas
  if (req.method === 'GET' && pathName === '/deployer/deployer-accounts') {
    return json(res, 200, { accounts: _store.deployerAccounts.map(deployerAccountMeta) }, origin);
  }

  if (req.method === 'POST' && pathName === '/deployer/deployer-accounts/add') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const err = validAccountInput(body);
    if (err) return json(res, 400, { error: 'BadRequest', message: err }, origin);
    const now = Date.now();
    const rec = {
      id: crypto.randomUUID(),
      alias: String(body.alias || '').slice(0, 256) || (body.verified && body.verified.accountId) || 'deployer',
      defaultRegion: body.defaultRegion,
      note: body.note || null,
      ak: encryptSecret(body.accessKey),
      sk: encryptSecret(body.secretKey),
      verified: body.verified || null,
      createdAt: now,
      updatedAt: now,
    };
    _store.deployerAccounts.push(rec);
    saveStore();
    return json(res, 200, deployerAccountMeta(rec), origin);
  }

  if (req.method === 'POST' && pathName === '/deployer/deployer-accounts/delete') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const before = _store.deployerAccounts.length;
    _store.deployerAccounts = _store.deployerAccounts.filter((a) => a.id !== body.id);
    if (_store.deployerAccounts.length !== before) saveStore();
    return json(res, 200, { ok: true }, origin);
  }

  if (req.method === 'POST' && pathName === '/deployer/deployer-accounts/creds') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const rec = _store.deployerAccounts.find((a) => a.id === body.id);
    if (!rec) return json(res, 404, { error: 'NotFound', message: 'account not found' }, origin);
    try {
      return json(res, 200, { accessKey: decryptSecret(rec.ak), secretKey: decryptSecret(rec.sk) }, origin);
    } catch {
      return json(res, 500, { error: 'DecryptError', message: '解密失败' }, origin);
    }
  }

  // Deploy (SSE)
  if (req.method === 'POST' && pathName === '/deployer/deploy') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const targets = Array.isArray(body.targets) ? body.targets : [];
    if (targets.length === 0) return json(res, 400, { error: 'BadRequest', message: 'targets 为空' }, origin);
    const corsOrigin = ORIGIN_RE.test(body.corsOrigin || '') ? body.corsOrigin : DEFAULT_CORS_ORIGIN;
    for (const t of targets) {
      const err = validateTarget(t);
      if (err) return json(res, 400, { error: 'BadRequest', message: err }, origin);
    }

    sseInit(res, origin);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 15000);
    req.on('close', () => clearInterval(ping));

    const results = [];
    try {
      const built = await ensureBuild(res);
      if (!built) {
        sse(res, 'done', { ok: false, error: 'sam build 失败', results });
        clearInterval(ping);
        return res.end();
      }
      // Serialize targets (avoid concurrent sam writes to .aws-sam/).
      for (const t of targets) {
        const r = await deployTarget(res, t, corsOrigin);
        results.push(r);
      }
      const okCount = results.filter((r) => r.ok).length;
      sse(res, 'done', { ok: okCount === results.length, okCount, total: results.length, results });
    } catch (e) {
      sse(res, 'done', { ok: false, error: e.message, results });
    } finally {
      clearInterval(ping);
      res.end();
    }
    return;
  }

  // Scan for existing worker stacks across accounts × regions (SSE).
  // Used to re-adopt nodes after a local registry loss (e.g. OS reinstall):
  // we discover which (account, region) pairs already have the worker stack,
  // then the frontend re-runs deploy on them (idempotent → fresh key + URL).
  if (req.method === 'POST' && pathName === '/deployer/scan') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const accountsIn = Array.isArray(body.accounts) ? body.accounts : [];
    // Optional candidate filter; when omitted we scan each account's enabled regions.
    const requested = (Array.isArray(body.regions) ? body.regions : []).filter((r) => REGION_RE.test(r));
    if (accountsIn.length === 0) return json(res, 400, { error: 'BadRequest', message: 'accounts 为空' }, origin);
    for (const a of accountsIn) {
      if (!AK_RE.test(a.accessKey || '') || typeof a.secretKey !== 'string' || a.secretKey.length < 16) {
        return json(res, 400, { error: 'BadRequest', message: '账号凭证格式非法' }, origin);
      }
    }

    sseInit(res, origin);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 15000);
    req.on('close', () => clearInterval(ping));

    const found = [];
    try {
      for (const acct of accountsIn) {
        const idEnv = targetEnv('us-east-1', acct.accessKey, acct.secretKey);
        const accountId = await getAccountId(idEnv);
        if (!accountId) {
          sse(res, 'scan-account-error', { alias: acct.alias || null, error: '凭证无效或无 sts 权限' });
          continue;
        }
        // Only scan regions the account has actually enabled (skip disabled
        // opt-in regions). Fall back to the default-enabled set if we can't
        // read them. An optional `regions` filter narrows it further.
        const enabled = (await getEnabledRegions(idEnv)) || DEFAULT_ENABLED_REGIONS;
        let regions = requested.length ? enabled.filter((r) => requested.includes(r)) : enabled;
        sse(res, 'scan-account-start', { alias: acct.alias || null, accountId, regions: regions.length });
        await mapLimit(regions, 8, async (region) => {
          const env = targetEnv(region, acct.accessKey, acct.secretKey);
          const status = await getStackStatus(env, region);
          sse(res, 'scan-progress', { accountId, region, found: !!status });
          if (status) {
            const url = await getStackUrl(env, region);
            const entry = {
              accountRef: acct.accountRef || null,
              alias: acct.alias || null,
              accountId,
              region,
              status,
              url,
            };
            found.push(entry);
            sse(res, 'scan-found', entry);
          }
        });
      }
      sse(res, 'done', { ok: true, found });
    } catch (e) {
      sse(res, 'done', { ok: false, error: e.message, found });
    } finally {
      clearInterval(ping);
      res.end();
    }
    return;
  }

  // Destroy (SSE)
  if (req.method === 'POST' && pathName === '/deployer/destroy') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BadRequest', message: e.message }, origin); }
    const err = validateTarget(body);
    if (err) return json(res, 400, { error: 'BadRequest', message: err }, origin);

    sseInit(res, origin);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 15000);
    req.on('close', () => clearInterval(ping));
    try {
      const r = await destroyTarget(res, body);
      sse(res, 'done', { ok: r.ok, results: [r] });
    } catch (e) {
      sse(res, 'done', { ok: false, error: e.message });
    } finally {
      clearInterval(ping);
      res.end();
    }
    return;
  }

  return json(res, 404, { error: 'NotFound', message: `no route for ${req.method} ${pathName}` }, origin);
});

// Disable Node's default 5-min request timeout — deploys can run longer.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

server.listen(PORT, HOST, () => {
  console.log(`[deployer] listening on http://${HOST}:${PORT}`);
  console.log(`[deployer] backend dir: ${BACKEND_DIR}`);
  console.log(`[deployer] worker stack: ${WORKER_STACK_NAME}`);
  console.log(`[deployer] registry: ${REGISTRY_FILE}`);
  console.log(`[deployer] gate key: ${GATE_KEY ? 'loaded' : 'MISSING'}`);
  loadConfig();
  loadSessions();
  pruneSessions();
  loadOrCreateDek();
  loadStore();
  console.log(`[deployer] telegram: ${_config.telegram.botToken ? 'configured' : 'not configured'}`);
  console.log(`[deployer] sessions: ${_sessions.length} active`);
  console.log(`[deployer] accounts: ${_store.accounts.length} stored`);
  void tgPollLoop();
  // Initial probe shortly after boot, then on a fixed interval.
  setTimeout(() => { probeAll().catch(() => {}); }, 3000);
  setInterval(() => { probeAll().catch(() => {}); }, PROBE_INTERVAL_MS);
  // vCPU quota monitoring sweep.
  setInterval(() => { monitorVcpuAll().catch(() => {}); }, VCPU_MONITOR_INTERVAL_MS);
});
