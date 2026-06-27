/**
 * 分组管理 — Add, rename, and delete groups used to label account cards.
 *
 * Group data lives in IndexedDB. Each row shows the group name plus how many
 * accounts currently reference it; deleting a non-empty group warns the user.
 * Renaming retags those accounts in the same IndexedDB transaction so cards
 * stay associated with the new name (no orphans).
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, AlertCircle, Pencil, Check, X as XIcon } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import {
  addGroup,
  deleteGroup,
  listAccounts,
  listGroups,
  renameGroup,
} from '@/lib/vault';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function GroupModal({ open, onClose }: Props) {
  const qc = useQueryClient();
  const groupsQ = useQuery({ queryKey: ['groups'], queryFn: listGroups, enabled: open });
  const accountsQ = useQuery({ queryKey: ['accounts'], queryFn: listAccounts, enabled: open });

  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const addMu = useMutation({
    mutationFn: addGroup,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups'] });
      setName('');
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const removeMu = useMutation({
    mutationFn: deleteGroup,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });

  const renameMu = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) => renameGroup(from, to),
    onSuccess: () => {
      // Group list AND account cards (their `group` field changes) need to refresh.
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      setEditingName(null);
      setEditError(null);
    },
    onError: (e: Error) => setEditError(e.message),
  });

  // Per-group account count, for the "N 个账号" badge.
  const counts = new Map<string, number>();
  for (const a of accountsQ.data ?? []) {
    if (a.group) counts.set(a.group, (counts.get(a.group) ?? 0) + 1);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    addMu.mutate(name);
  }

  function startEdit(currentName: string) {
    setEditingName(currentName);
    setEditDraft(currentName);
    setEditError(null);
  }

  function commitEdit() {
    if (!editingName) return;
    const trimmed = editDraft.trim();
    if (!trimmed || trimmed === editingName) {
      setEditingName(null);
      setEditError(null);
      return;
    }
    renameMu.mutate({ from: editingName, to: trimmed });
  }

  function cancelEdit() {
    setEditingName(null);
    setEditError(null);
  }

  const groups = groupsQ.data ?? [];

  return (
    <Modal open={open} onClose={onClose} title="分组管理" size="sm">
      <form onSubmit={submit} className="flex items-start gap-2">
        <div className="flex-1">
          <Input
            name="group-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="新分组名称,例如:日本区"
            autoFocus
          />
        </div>
        <Button
          type="submit"
          size="md"
          loading={addMu.isPending}
          leadingIcon={<Plus size={14} />}
        >
          添加
        </Button>
      </form>

      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--color-status-error)]/40 bg-[var(--color-status-error)]/10 px-3 py-2 text-sm text-[var(--color-status-error)]">
          <AlertCircle size={15} className="shrink-0" />
          {error}
        </div>
      )}

      <div className="mt-4">
        {groups.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--color-border-glass)] py-6 text-center text-sm text-[var(--color-fg-muted)]">
            还没有分组 — 加一个,账号表单里就会出现下拉框
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border-glass)] rounded-lg border border-[var(--color-border-glass)]">
            {groups.map((g) => {
              const n = counts.get(g.name) ?? 0;
              const isEditing = editingName === g.name;
              return (
                <li key={g.name} className="flex items-center gap-2 px-3 py-2">
                  {isEditing ? (
                    <EditRow
                      initial={editDraft}
                      onChange={setEditDraft}
                      onCommit={commitEdit}
                      onCancel={cancelEdit}
                      busy={renameMu.isPending}
                      error={editError}
                    />
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{g.name}</p>
                        <p className="text-xs text-[var(--color-fg-muted)]">{n} 个账号</p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`重命名分组 ${g.name}`}
                        className="!size-8 !p-0"
                        onClick={() => startEdit(g.name)}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`删除分组 ${g.name}`}
                        className="!size-8 !p-0 hover:!text-[var(--color-status-error)]"
                        onClick={() => removeMu.mutate(g.name)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Inline rename row: input + ✓ / ✕. Enter commits, Esc cancels.
// ---------------------------------------------------------------------------

function EditRow({
  initial,
  onChange,
  onCommit,
  onCancel,
  busy,
  error,
}: {
  initial: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus + select on mount so user can just type
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="flex w-full items-center gap-2">
      <div className="min-w-0 flex-1">
        <input
          ref={inputRef}
          defaultValue={initial}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onCommit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
          disabled={busy}
          className="glass-input block h-9 w-full px-3 text-sm outline-none"
        />
        {error && (
          <p className="mt-1 text-xs text-[var(--color-status-error)]">{error}</p>
        )}
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="!size-8 !p-0 text-green-500 hover:!bg-green-500/10"
        aria-label="确认重命名"
        onClick={onCommit}
        loading={busy}
      >
        <Check size={14} />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="!size-8 !p-0"
        aria-label="取消"
        onClick={onCancel}
        disabled={busy}
      >
        <XIcon size={14} />
      </Button>
    </div>
  );
}
