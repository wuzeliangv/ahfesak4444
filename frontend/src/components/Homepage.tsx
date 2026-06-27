/**
 * Public landing page — shown when the URL carries no access token.
 *
 * A full-bleed single-screen hero (no login / no sign-up entry by design).
 * Access to the actual panel is via a tokenized link (#token=…) delivered
 * through Telegram; this page is just the public face.
 *
 * The big visual is pure CSS (layered aurora gradients) so there's no binary
 * asset to ship — swap in a real background image later if desired.
 */

import { Logo } from './ui/Logo';

export function Homepage() {
  return (
    <main className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-[var(--color-bg-deep)] px-6">
      {/* ---- Aurora / big-image backdrop ---- */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className="absolute -left-[10%] -top-[20%] size-[60vmax] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, oklch(0.62 0.17 262 / 0.45), transparent 60%)' }}
        />
        <div
          className="absolute -bottom-[25%] -right-[5%] size-[55vmax] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, oklch(0.60 0.13 210 / 0.40), transparent 60%)' }}
        />
        <div
          className="absolute left-[35%] top-[30%] size-[40vmax] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, oklch(0.55 0.12 300 / 0.28), transparent 70%)' }}
        />
        {/* faint grid for depth */}
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              'linear-gradient(oklch(1 0 0) 1px, transparent 1px), linear-gradient(90deg, oklch(1 0 0) 1px, transparent 1px)',
            backgroundSize: '56px 56px',
            maskImage: 'radial-gradient(ellipse 80% 60% at 50% 40%, black, transparent 80%)',
          }}
        />
      </div>

      {/* ---- Hero content ---- */}
      <div className="relative z-10 flex max-w-3xl flex-col items-center text-center">
        <Logo
          size={104}
          className="rounded-[1.6rem] shadow-[0_20px_70px_-20px_oklch(0.55_0.18_260/0.9)]"
        />

        <h1 className="mt-8 bg-gradient-to-b from-[var(--color-fg-primary)] to-[var(--color-fg-secondary)] bg-clip-text text-5xl font-bold tracking-tight text-transparent sm:text-6xl">
          AWS 管理助手
        </h1>

        <p className="mt-5 max-w-xl text-base leading-relaxed text-[var(--color-fg-secondary)] sm:text-lg">
          多账号 · 多区域的轻量 AWS 控制台。凭证加密集中托管,出口 IP 可分散到全球节点,随处安全可达。
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-2 text-xs text-[var(--color-fg-muted)]">
          {['多账号统一管理', '多区域节点出口', 'EC2 · Lightsail', '配额 / 账单监控'].map((t) => (
            <span
              key={t}
              className="rounded-full border border-[var(--color-border-glass)] bg-white/5 px-3 py-1 backdrop-blur-md"
            >
              {t}
            </span>
          ))}
        </div>

        <p className="mt-10 inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border-glass)] bg-white/5 px-3 py-1.5 text-xs text-[var(--color-fg-muted)] backdrop-blur-md">
          <span className="size-1.5 rounded-full bg-[var(--color-status-running)]" />
          受保护的私有面板 · 仅限授权访问
        </p>
      </div>

      <footer className="absolute bottom-5 left-0 right-0 text-center text-[11px] text-[var(--color-fg-muted)]">
        © {new Date().getFullYear()} AWS 管理助手
      </footer>
    </main>
  );
}
