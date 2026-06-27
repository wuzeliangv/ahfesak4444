import { useState, useEffect } from 'react';
import { Logo } from './ui/Logo';
import { Flag } from './ui/Flag';
import {
  Shield,
  Server,
  Globe,
  Activity,
  Cpu,
  Lock,
  Play,
  Square,
  RefreshCw,
  Database,
  Info
} from 'lucide-react';

interface MockEC2 {
  id: number;
  name: string;
  region: string;
  flag: string;
  type: string;
  status: 'Running' | 'Stopped' | 'Starting' | 'Stopping';
  ip: string;
}

export function Homepage() {
  const [activeTab, setActiveTab] = useState<'ec2' | 'lightsail' | 'quota' | 'billing'>('ec2');
  
  // --- Simulated EC2 State ---
  const [ec2Instances, setEc2Instances] = useState<MockEC2[]>([
    { id: 1, name: 'prod-web-us', region: 'us-east-1', flag: 'US', type: 't3.medium', status: 'Running', ip: '54.210.12.8' },
    { id: 2, name: 'db-replica-sg', region: 'ap-southeast-1', flag: 'SG', type: 't4g.small', status: 'Stopped', ip: '-' },
    { id: 3, name: 'api-gateway-hk', region: 'ap-east-1', flag: 'HK', type: 't3.small', status: 'Running', ip: '47.91.56.22' }
  ]);

  const toggleInstance = (id: number) => {
    setEc2Instances(prev => prev.map(inst => {
      if (inst.id !== id) return inst;
      if (inst.status === 'Running') {
        setTimeout(() => {
          setEc2Instances(curr => curr.map(i => i.id === id ? { ...i, status: 'Stopped', ip: '-' } : i));
        }, 1200);
        return { ...inst, status: 'Stopping', ip: '-' };
      } else if (inst.status === 'Stopped') {
        const newIP = inst.region === 'us-east-1'
          ? `3.235.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`
          : inst.region === 'ap-southeast-1'
          ? `18.139.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`
          : `47.91.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
        setTimeout(() => {
          setEc2Instances(curr => curr.map(i => i.id === id ? { ...i, status: 'Running', ip: newIP } : i));
        }, 1200);
        return { ...inst, status: 'Starting', ip: '分配中...' };
      }
      return inst;
    }));
  };

  // --- Simulated Lightsail IP Rotation State ---
  const [lsIP, setLsIP] = useState('18.130.40.111');
  const [lsStatus, setLsStatus] = useState<'ready' | 'detaching' | 'allocating' | 'attaching'>('ready');

  const rotateLsIP = () => {
    if (lsStatus !== 'ready') return;
    setLsStatus('detaching');
    setTimeout(() => {
      setLsStatus('allocating');
      setTimeout(() => {
        setLsStatus('attaching');
        setTimeout(() => {
          setLsIP(`18.130.40.${Math.floor(Math.random() * 253) + 2}`);
          setLsStatus('ready');
        }, 1000);
      }, 1000);
    }, 800);
  };

  // --- Dynamic Aurora Pulse ---
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    const int = setInterval(() => setPulse(p => !p), 4000);
    return () => clearInterval(int);
  }, []);

  return (
    <main className="relative flex min-h-screen w-full flex-col items-center justify-center overflow-x-hidden bg-[var(--color-bg-deep)] px-4 py-12 md:px-8 lg:px-16 animate-fadeIn">
      
      {/* ---- Backing Aurora Glow ---- */}
      <div aria-hidden className="pointer-events-none absolute inset-0 select-none">
        <div
          className="absolute -left-[10%] -top-[10%] size-[60vmax] rounded-full blur-[120px] transition-all duration-[4000ms] ease-in-out"
          style={{
            background: pulse 
              ? 'radial-gradient(circle, oklch(0.65 0.18 260 / 0.38), transparent 70%)'
              : 'radial-gradient(circle, oklch(0.60 0.15 250 / 0.45), transparent 70%)'
          }}
        />
        <div
          className="absolute -bottom-[20%] -right-[5%] size-[55vmax] rounded-full blur-[120px] transition-all duration-[4000ms] ease-in-out"
          style={{
            background: pulse
              ? 'radial-gradient(circle, oklch(0.55 0.12 210 / 0.35), transparent 70%)'
              : 'radial-gradient(circle, oklch(0.62 0.16 220 / 0.28), transparent 70%)'
          }}
        />
        <div
          className="absolute left-[30%] top-[25%] size-[45vmax] rounded-full blur-[140px] opacity-40"
          style={{ background: 'radial-gradient(circle, oklch(0.58 0.14 290 / 0.20), transparent 70%)' }}
        />
        {/* Luminous grid overlay */}
        <div
          className="absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              'linear-gradient(oklch(1 0 0) 1px, transparent 1px), linear-gradient(90deg, oklch(1 0 0) 1px, transparent 1px)',
            backgroundSize: '56px 56px',
            maskImage: 'radial-gradient(ellipse 70% 60% at 50% 40%, black, transparent 80%)',
          }}
        />
      </div>

      {/* ---- Content Shell ---- */}
      <div className="relative z-10 grid w-full max-w-7xl grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-16">
        
        {/* ================= LEFT COLUMN: INTRO & BRAND ================= */}
        <div className="flex flex-col justify-center lg:col-span-5 text-left">
          
          {/* Security Banner */}
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[var(--color-border-glass)] bg-white/5 px-3.5 py-1.5 text-xs text-[var(--color-fg-secondary)] backdrop-blur-md">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-status-running)] opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-status-running)]"></span>
            </span>
            <span className="font-medium tracking-wide">受保护的私有网关 · 仅限授权访问</span>
          </div>

          {/* Logo & Branding */}
          <div className="mt-8 flex items-center gap-4">
            <Logo
              size={64}
              className="rounded-2xl shadow-[0_10px_40px_-10px_oklch(0.60_0.16_255/0.8)]"
            />
            <div>
              <h1 className="bg-gradient-to-r from-[var(--color-fg-primary)] to-[var(--color-fg-secondary)] bg-clip-text text-4xl font-extrabold tracking-tight text-transparent sm:text-5xl">
                AWS 管理助手
              </h1>
              <p className="text-xs text-[var(--color-fg-muted)] tracking-wider uppercase mt-1 font-mono">Cloud Management Hub</p>
            </div>
          </div>

          <p className="mt-6 text-base leading-relaxed text-[var(--color-fg-secondary)] sm:text-lg">
            专门面向多账号、多区域的轻量化 AWS 运维控制中心。凭证本地加密安全托管，出口 IP 随心部署与流转，全面掌控云端实例。
          </p>

          {/* Feature Grid */}
          <div className="mt-10 space-y-6">
            <div className="group flex gap-4 rounded-2xl border border-transparent p-4 transition-all duration-300 hover:border-[var(--color-border-glass)] hover:bg-white/3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400 group-hover:scale-110 transition-transform duration-300">
                <Shield size={20} />
              </div>
              <div>
                <h3 className="font-semibold text-[var(--color-fg-primary)]">零信任加密托管</h3>
                <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
                  使用 AES-256-GCM 本地双重加密，浏览器不存明文，随时锁定以阻断一切未授权物理提取。
                </p>
              </div>
            </div>

            <div className="group flex gap-4 rounded-2xl border border-transparent p-4 transition-all duration-300 hover:border-[var(--color-border-glass)] hover:bg-white/3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 group-hover:scale-110 transition-transform duration-300">
                <Globe size={20} />
              </div>
              <div>
                <h3 className="font-semibold text-[var(--color-fg-primary)]">出口 IP 多样化</h3>
                <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
                  一键在全球多区域自动化部署 Lambda Worker 节点，轻松避开 IP 限制，确保业务出站的高可用。
                </p>
              </div>
            </div>

            <div className="group flex gap-4 rounded-2xl border border-transparent p-4 transition-all duration-300 hover:border-[var(--color-border-glass)] hover:bg-white/3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-purple-500/10 text-purple-400 group-hover:scale-110 transition-transform duration-300">
                <Server size={20} />
              </div>
              <div>
                <h3 className="font-semibold text-[var(--color-fg-primary)]">EC2 & Lightsail 闪控</h3>
                <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
                  支持启动、停止、重命名与一键 IP 轮换，无延迟查询全地域 vCPU 配额利用率与账单月报。
                </p>
              </div>
            </div>
          </div>

          {/* Secure Access Alert */}
          <div className="mt-10 flex items-start gap-3 rounded-2xl border border-[var(--color-border-glass)] bg-white/3 p-4 backdrop-blur-md">
            <Lock className="mt-0.5 size-4 shrink-0 text-[var(--color-accent-300)]" />
            <div className="text-xs text-[var(--color-fg-secondary)] leading-relaxed">
              <span className="font-semibold text-[var(--color-fg-primary)]">登录说明：</span>
              此控制台不设公共的注册或登录账户表单。请在你的 Telegram 客户端中联系授权机器人，发送 <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[var(--color-accent-300)]">/login</code> 指令获取带有时效性特权 Token 的加密访问链接。
            </div>
          </div>

        </div>

        {/* ================= RIGHT COLUMN: INTERACTIVE DEMO ================= */}
        <div className="flex flex-col justify-center lg:col-span-7">
          
          {/* Glass Console Shell */}
          <div className="glass-card overflow-hidden transition-all duration-500 hover:shadow-[0_20px_50px_oklch(0.20_0.02_265/0.5)]">
            
            {/* Header / Tabs */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border-glass)] bg-black/25 px-6 py-4">
              <div className="flex items-center gap-2">
                <div className="size-3 rounded-full bg-red-500/80" />
                <div className="size-3 rounded-full bg-yellow-500/80" />
                <div className="size-3 rounded-full bg-green-500/80" />
                <span className="ml-3 font-mono text-xs text-[var(--color-fg-muted)] tracking-wider">AWS_PANEL_LIVE_PREVIEW.exe</span>
              </div>
              
              <div className="flex items-center gap-1 bg-black/20 p-1 rounded-lg border border-[var(--color-border-glass)]">
                {(['ec2', 'lightsail', 'quota', 'billing'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`rounded-md px-3 py-1 text-xs font-medium tracking-wide uppercase transition-all ${
                      activeTab === tab 
                        ? 'bg-[var(--color-accent-500)] text-white shadow-sm' 
                        : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]'
                    }`}
                  >
                    {tab === 'quota' ? 'vCPU 配额' : tab === 'billing' ? '账单监控' : tab}
                  </button>
                ))}
              </div>
            </div>

            {/* Main Preview Screen */}
            <div className="relative min-h-[340px] p-6 bg-black/10">
              
              {/* === EC2 PREVIEW TAB === */}
              {activeTab === 'ec2' && (
                <div className="space-y-4 animate-fadeIn">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[var(--color-fg-secondary)] flex items-center gap-1.5 uppercase font-mono">
                      <Cpu size={14} className="text-blue-400" /> EC2 实例集群预览
                    </span>
                    <span className="text-[10px] text-[var(--color-fg-muted)] font-mono">点击控制按钮模拟交互</span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs font-mono">
                      <thead>
                        <tr className="border-b border-[var(--color-border-glass)] text-[var(--color-fg-muted)]">
                          <th className="pb-2 font-normal">实例名称 / 区域</th>
                          <th className="pb-2 font-normal">规格</th>
                          <th className="pb-2 font-normal">运行状态</th>
                          <th className="pb-2 font-normal">公网 IP</th>
                          <th className="pb-2 font-normal text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border-glass)]">
                        {ec2Instances.map((inst) => (
                          <tr key={inst.id} className="hover:bg-white/2 transition-colors">
                            <td className="py-3 font-semibold text-[var(--color-fg-primary)]">
                              <div className="flex items-center gap-2">
                                <Flag code={inst.flag} className="text-sm shrink-0" />
                                <div>
                                  <div>{inst.name}</div>
                                  <div className="text-[10px] text-[var(--color-fg-muted)]">{inst.region}</div>
                                </div>
                              </div>
                            </td>
                            <td className="py-3 text-[var(--color-fg-secondary)]">{inst.type}</td>
                            <td className="py-3">
                              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                inst.status === 'Running' ? 'bg-emerald-500/10 text-emerald-400' :
                                inst.status === 'Stopped' ? 'bg-zinc-500/10 text-zinc-400' :
                                'bg-amber-500/10 text-amber-400'
                              }`}>
                                <span className={`size-1.5 rounded-full ${
                                  inst.status === 'Running' ? 'bg-emerald-400' :
                                  inst.status === 'Stopped' ? 'bg-zinc-400' :
                                  'bg-amber-400 animate-pulse'
                                }`} />
                                {inst.status === 'Running' ? '运行中' : 
                                 inst.status === 'Stopped' ? '已停止' : 
                                 inst.status === 'Starting' ? '启动中...' : '停止中...'}
                              </span>
                            </td>
                            <td className="py-3 text-[var(--color-fg-secondary)] font-mono">{inst.ip}</td>
                            <td className="py-3 text-right">
                              <button
                                disabled={inst.status === 'Starting' || inst.status === 'Stopping'}
                                onClick={() => toggleInstance(inst.id)}
                                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all ${
                                  inst.status === 'Running'
                                    ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                                    : inst.status === 'Stopped'
                                    ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                                    : 'bg-white/5 text-[var(--color-fg-muted)] cursor-not-allowed'
                                }`}
                              >
                                {inst.status === 'Running' ? <Square size={10} fill="currentColor" /> : <Play size={10} fill="currentColor" />}
                                {inst.status === 'Running' ? '关机' : '开机'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* === LIGHTSAIL PREVIEW TAB === */}
              {activeTab === 'lightsail' && (
                <div className="space-y-5 animate-fadeIn">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[var(--color-fg-secondary)] flex items-center gap-1.5 uppercase font-mono">
                      <Server size={14} className="text-purple-400" /> LIGHTSAIL 节点 IP 轮换模拟
                    </span>
                    <span className="text-[10px] text-[var(--color-fg-muted)] font-mono">测试极速更换静态公网 IP 机制</span>
                  </div>

                  {/* Lightsail Card Mock */}
                  <div className="rounded-xl border border-[var(--color-border-glass)] bg-white/3 p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Flag code="HK" className="text-lg" />
                        <div>
                          <h4 className="text-sm font-semibold text-[var(--color-fg-primary)]">lightsail-proxy-hk</h4>
                          <p className="text-[10px] text-[var(--color-fg-muted)]">亚太地区 (香港) ap-east-1a</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] text-zinc-400 block font-mono">已挂载静态 IP</span>
                        <span className="font-mono text-sm font-semibold text-[var(--color-accent-300)]">{lsIP}</span>
                      </div>
                    </div>

                    {/* Bandwidth simulation */}
                    <div className="mt-4 pt-3 border-t border-white/5 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 text-[var(--color-fg-secondary)]">
                        <Activity size={12} className="text-emerald-400 animate-pulse" />
                        <span>带宽出口状态: <span className="text-emerald-400">稳定</span></span>
                      </div>
                      <span className="text-[var(--color-fg-muted)]">累计出站流量: <span className="font-semibold text-[var(--color-fg-primary)]">3.24 TB</span> / 5 TB</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-4">
                    <div className="text-[11px] text-[var(--color-fg-muted)] leading-relaxed max-w-[70%]">
                      {lsStatus === 'ready' && <span className="text-zinc-400">💡 轮换机制：创建新静态 IP ➡ 切换挂载 ➡ 释放旧 IP，全程自动。</span>}
                      {lsStatus === 'detaching' && <span className="text-amber-400 animate-pulse">⚙️ 正在解除绑定旧 IP...</span>}
                      {lsStatus === 'allocating' && <span className="text-amber-400 animate-pulse">⚙️ 正在申请分配新的 AWS 静态 IP...</span>}
                      {lsStatus === 'attaching' && <span className="text-amber-400 animate-pulse">⚙️ 正在将新 IP 挂载到容器实例...</span>}
                    </div>

                    <button
                      disabled={lsStatus !== 'ready'}
                      onClick={rotateLsIP}
                      className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold tracking-wide transition-all ${
                        lsStatus === 'ready'
                          ? 'bg-[var(--color-accent-500)] text-white hover:bg-[var(--color-accent-600)] shadow-sm'
                          : 'bg-white/5 text-[var(--color-fg-muted)] cursor-not-allowed'
                      }`}
                    >
                      <RefreshCw size={12} className={lsStatus !== 'ready' ? 'animate-spin' : ''} />
                      {lsStatus === 'ready' ? '一键更换 IP' : '正在更换...'}
                    </button>
                  </div>
                </div>
              )}

              {/* === VCPU QUOTA TAB === */}
              {activeTab === 'quota' && (
                <div className="space-y-4 animate-fadeIn">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[var(--color-fg-secondary)] flex items-center gap-1.5 uppercase font-mono">
                      <Globe size={14} className="text-emerald-400" /> 多区域 vCPU 配额看板
                    </span>
                    <span className="text-[10px] text-[var(--color-fg-muted)] font-mono">跨账号/跨区域实时采集数据</span>
                  </div>

                  {/* Orbs list */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    
                    {/* Quota Orb Mock 1 */}
                    <div className="rounded-xl border border-[var(--color-border-glass)] bg-white/3 p-4 flex flex-col items-center text-center">
                      <Flag code="US" className="text-xl mb-2" />
                      <span className="text-xs font-semibold text-[var(--color-fg-primary)]">美国 弗吉尼亚东部</span>
                      <span className="text-[10px] text-[var(--color-fg-muted)] mt-0.5">us-east-1</span>
                      {/* Meter bar */}
                      <div className="mt-3 w-full bg-white/5 rounded-full h-1.5 overflow-hidden">
                        <div className="bg-gradient-to-r from-blue-500 to-indigo-500 h-full w-[50%]" />
                      </div>
                      <div className="mt-2 text-xs font-mono font-semibold text-[var(--color-fg-secondary)]">32 / 64 <span className="text-[10px] text-[var(--color-fg-muted)]">vCPUs</span></div>
                    </div>

                    {/* Quota Orb Mock 2 */}
                    <div className="rounded-xl border border-[var(--color-border-glass)] bg-white/3 p-4 flex flex-col items-center text-center">
                      <Flag code="HK" className="text-xl mb-2" />
                      <span className="text-xs font-semibold text-[var(--color-fg-primary)]">中国香港</span>
                      <span className="text-[10px] text-[var(--color-fg-muted)] mt-0.5">ap-east-1</span>
                      {/* Meter bar */}
                      <div className="mt-3 w-full bg-white/5 rounded-full h-1.5 overflow-hidden">
                        <div className="bg-gradient-to-r from-blue-500 to-indigo-500 h-full w-[25%]" />
                      </div>
                      <div className="mt-2 text-xs font-mono font-semibold text-[var(--color-fg-secondary)]">2 / 8 <span className="text-[10px] text-[var(--color-fg-muted)]">vCPUs</span></div>
                    </div>

                    {/* Quota Orb Mock 3 */}
                    <div className="rounded-xl border border-[var(--color-border-glass)] bg-white/3 p-4 flex flex-col items-center text-center">
                      <Flag code="SG" className="text-xl mb-2" />
                      <span className="text-xs font-semibold text-[var(--color-fg-primary)]">新加坡</span>
                      <span className="text-[10px] text-[var(--color-fg-muted)] mt-0.5">ap-southeast-1</span>
                      {/* Meter bar */}
                      <div className="mt-3 w-full bg-white/5 rounded-full h-1.5 overflow-hidden">
                        <div className="bg-gradient-to-r from-blue-500 to-indigo-500 h-full w-[25%]" />
                      </div>
                      <div className="mt-2 text-xs font-mono font-semibold text-[var(--color-fg-secondary)]">320 / 1280 <span className="text-[10px] text-[var(--color-fg-muted)]">vCPUs</span></div>
                    </div>

                  </div>
                </div>
              )}

              {/* === BILLING TAB === */}
              {activeTab === 'billing' && (
                <div className="space-y-4 animate-fadeIn">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[var(--color-fg-secondary)] flex items-center gap-1.5 uppercase font-mono">
                      <Database size={14} className="text-amber-400" /> 月度账单实时跟踪
                    </span>
                    <span className="text-[10px] text-[var(--color-fg-muted)] font-mono">基于 Cost Explorer 数据接口分析</span>
                  </div>

                  <div className="rounded-xl border border-[var(--color-border-glass)] bg-white/3 p-4">
                    <div className="flex items-end justify-between">
                      <div>
                        <span className="text-[10px] text-[var(--color-fg-muted)] block font-mono">本月累计预计消费 (MTD)</span>
                        <span className="text-2xl font-mono font-bold text-transparent bg-gradient-to-r from-[var(--color-fg-primary)] to-[var(--color-accent-300)] bg-clip-text">$181.80</span>
                      </div>
                      <span className="text-xs text-emerald-400 bg-emerald-500/10 rounded px-1.5 py-0.5 font-semibold font-mono">比上月减少 -12.4%</span>
                    </div>

                    {/* Breakdown Chart */}
                    <div className="mt-5 space-y-2.5 text-xs">
                      <div>
                        <div className="flex justify-between text-[var(--color-fg-secondary)] mb-1">
                          <span>弹性云服务器 (EC2)</span>
                          <span className="font-mono">$124.50 (68%)</span>
                        </div>
                        <div className="w-full bg-white/5 h-2 rounded-full overflow-hidden">
                          <div className="bg-gradient-to-r from-amber-400 to-orange-500 h-full w-[68%]" />
                        </div>
                      </div>

                      <div>
                        <div className="flex justify-between text-[var(--color-fg-secondary)] mb-1">
                          <span>轻量型服务器 (Lightsail)</span>
                          <span className="font-mono">$45.00 (25%)</span>
                        </div>
                        <div className="w-full bg-white/5 h-2 rounded-full overflow-hidden">
                          <div className="bg-gradient-to-r from-purple-400 to-indigo-500 h-full w-[25%]" />
                        </div>
                      </div>

                      <div>
                        <div className="flex justify-between text-[var(--color-fg-secondary)] mb-1">
                          <span>其他网络及辅助组件</span>
                          <span className="font-mono">$12.30 (7%)</span>
                        </div>
                        <div className="w-full bg-white/5 h-2 rounded-full overflow-hidden">
                          <div className="bg-gradient-to-r from-zinc-400 to-zinc-600 h-full w-[7%]" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

            </div>

            {/* Lock / Authorized Access Overlay Bar */}
            <div className="flex items-center gap-2 border-t border-[var(--color-border-glass)] bg-black/30 px-6 py-3 text-xs text-[var(--color-fg-muted)]">
              <Info size={14} className="text-[var(--color-accent-300)] shrink-0" />
              <span>当前为只读交互演示版。要开始控制你的 AWS 节点，请联系你的 Telegram 授权 Bot 取得入口。</span>
            </div>

          </div>

        </div>

      </div>

      {/* ---- Footer ---- */}
      <footer className="absolute bottom-5 left-0 right-0 text-center text-[11px] text-[var(--color-fg-muted)]">
        © {new Date().getFullYear()} AWS 管理助手 · 全球云资源一站式控制中心
      </footer>

    </main>
  );
}
