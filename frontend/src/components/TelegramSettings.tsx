/**
 * Telegram notification settings — rendered on the Lambda 部署 page.
 *
 * The daemon's health-probe loop pushes a message when a node goes offline or
 * recovers. Here the user provides the bot token + chat id. The token is
 * stored locally by the daemon (chmod 600) and never returned to the browser
 * (the form shows only whether one is set).
 */

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, KeyRound, Hash } from 'lucide-react';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { toast } from '@/lib/toast';
import {
  getDeployerConfig,
  setDeployerConfig,
  clearDeployerConfig,
  testTelegram,
} from '@/lib/deployer';

export function TelegramSettings() {
  const qc = useQueryClient();
  const cfgQ = useQuery({ queryKey: ['deployer-config'], queryFn: () => getDeployerConfig() });
  const tokenSet = cfgQ.data?.telegram.tokenSet ?? false;

  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (cfgQ.data) setChatId(cfgQ.data.telegram.chatId || '');
  }, [cfgQ.data]);

  async function save() {
    if (!chatId.trim()) {
      toast.warning('请填写 Chat ID');
      return;
    }
    setSaving(true);
    try {
      await setDeployerConfig({ botToken: token.trim() || undefined, chatId: chatId.trim() });
      setToken('');
      qc.invalidateQueries({ queryKey: ['deployer-config'] });
      toast.success('已保存 Telegram 配置');
    } catch (e) {
      toast.error((e as Error).message, { title: '保存失败' });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    try {
      const r = await testTelegram();
      if (r.ok) toast.success('测试消息已发送,请检查你的 Telegram');
      else toast.error(r.error || '发送失败', { title: 'Telegram 测试失败' });
    } finally {
      setTesting(false);
    }
  }

  async function clear() {
    if (!window.confirm('清除 Telegram 通知配置?')) return;
    try {
      await clearDeployerConfig();
      setToken('');
      qc.invalidateQueries({ queryKey: ['deployer-config'] });
      toast.success('已清除');
    } catch (e) {
      toast.error((e as Error).message, { title: '清除失败' });
    }
  }

  return (
    <section className="glass-panel mt-4 p-4">
      <div className="mb-1 flex items-center gap-2">
        <Bell size={15} className="text-[var(--color-accent-400)]" />
        <h2 className="text-sm font-semibold">节点失效通知 (Telegram)</h2>
        <span
          className={
            tokenSet
              ? 'rounded bg-[var(--color-status-running)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-status-running)]'
              : 'rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-[var(--color-fg-muted)]'
          }
        >
          {tokenSet ? '已配置' : '未配置'}
        </span>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
        节点离线或恢复时推送到 Telegram。找 <span className="font-mono">@BotFather</span> 建机器人拿 token;
        给机器人发一条消息后,用 <span className="font-mono">@userinfobot</span> 获取你的 Chat ID。
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Bot Token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={tokenSet ? '已配置,留空保持不变' : '123456789:ABCdef...'}
          autoComplete="off"
          spellCheck={false}
          leadingIcon={<KeyRound size={14} />}
        />
        <Input
          label="Chat ID"
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          placeholder="123456789 或 @频道名"
          autoComplete="off"
          spellCheck={false}
          leadingIcon={<Hash size={14} />}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} loading={saving}>
          保存
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={test}
          loading={testing}
          disabled={!tokenSet}
          title={tokenSet ? '用已保存的配置发送一条测试消息' : '请先保存配置'}
        >
          发送测试
        </Button>
        {tokenSet && (
          <Button size="sm" variant="ghost" onClick={clear} className="hover:!text-[var(--color-status-error)]">
            清除
          </Button>
        )}
      </div>
    </section>
  );
}
