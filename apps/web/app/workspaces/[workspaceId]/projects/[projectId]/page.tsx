'use client';

import { BOARD_COLUMNS, type IssueStatus } from '@relay/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { PresenceBar } from '../../../../../components/presence.tsx';
import { SyncStatus } from '../../../../../components/sync-status.tsx';
import { ErrorState } from '../../../../../components/ui.tsx';
import { api, type WorkspaceSummary } from '../../../../../lib/api.ts';
import { useRealtime } from '../../../../../lib/realtime.ts';
import { lastTheme, useApplyTheme } from '../../../../../lib/theme.ts';
import { useOfflineBoard } from '../../../../../lib/use-offline-board.ts';

const COLUMN_LABELS: Record<IssueStatus, string> = {
  TODO: 'Todo',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  DONE: 'Done',
  CANCELED: 'Canceled',
};

export default function BoardPage() {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  const [title, setTitle] = useState('');

  // The board reads from IndexedDB rather than the network, so it renders with
  // no connection and survives a reload mid-edit.
  const board = useOfflineBoard(workspaceId, projectId);

  // Reporting the project as our location is what lets other people see who
  // else is looking at this board. Domain events pull straight through to a
  // reconcile, so someone else's change lands immediately instead of waiting
  // for the next scheduled sync.
  const { presence, state: realtimeState } = useRealtime(workspaceId, projectId, board.refresh);

  const workspace = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => api<{ workspace: WorkspaceSummary }>(`/workspaces/${workspaceId}`),
  });

  useApplyTheme(workspace.data?.workspace.theme ?? lastTheme());

  // Reconnecting means we may have missed events while the socket was down.
  const { refresh } = board;
  useEffect(() => {
    if (realtimeState === 'live') void refresh();
  }, [realtimeState, refresh]);

  if (workspace.isError) return <ErrorState message={(workspace.error as Error).message} />;

  function onCreate(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    setTitle('');
    void board.createIssue({ title: trimmed });
  }

  const role = workspace.data?.workspace.role;
  const canEdit = role !== undefined && role !== 'GUEST';

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <nav className="text-sm text-faint">
        <Link href="/workspaces" className="hover:text-muted">
          Workspaces
        </Link>
        <span className="mx-2">/</span>
        <Link href={`/workspaces/${workspaceId}`} className="hover:text-muted">
          {workspace.data?.workspace.name ?? '…'}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-muted">Board</span>
      </nav>

      <div className="mt-4 flex items-center justify-between gap-4">
        <SyncStatus online={board.online} pending={board.pending} />
        <PresenceBar users={presence} state={realtimeState} here={projectId} />
      </div>

      {canEdit && (
        <form onSubmit={onCreate} className="mt-6 flex gap-2">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs doing?"
            className="flex-1 rounded-md border border-line bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={!title.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-contrast hover:bg-accent-hover disabled:opacity-50"
          >
            Add issue
          </button>
        </form>
      )}

      <div className="mt-8 grid gap-4 md:grid-cols-4">
        {BOARD_COLUMNS.map((column) => {
          const columnIssues = board.issues.filter((issue) => issue.status === column);

          return (
            <section key={column} className="rounded-lg border border-line bg-raised/50 p-3">
              <h2 className="flex items-baseline justify-between text-xs font-medium uppercase tracking-wide text-muted">
                {COLUMN_LABELS[column]}
                <span className="text-faint">{columnIssues.length}</span>
              </h2>

              <ul className="mt-3 space-y-2">
                {columnIssues.map((issue) => (
                  <li
                    key={issue.id}
                    className={[
                      'rounded-md border bg-raised p-3',
                      issue.pending ? 'border-amber-500/40' : 'border-line',
                    ].join(' ')}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-[10px] text-faint">{issue.key}</span>

                      {issue.pending ? (
                        <span
                          title="Saved on this device, not yet synced"
                          className="text-[10px] uppercase tracking-wide text-amber-500/90"
                        >
                          Unsynced
                        </span>
                      ) : (
                        issue.priority !== 'NONE' && (
                          <span className="text-[10px] uppercase tracking-wide text-amber-500/80">
                            {issue.priority}
                          </span>
                        )
                      )}
                    </div>

                    {/* Offline-created issues have no server row yet, so
                        there is nothing to open until they sync. */}
                    {issue.pending ? (
                      <p className="mt-1 text-sm text-content">{issue.title}</p>
                    ) : (
                      <Link
                        href={`/workspaces/${workspaceId}/issues/${issue.id}`}
                        className="mt-1 block text-sm text-content hover:text-content hover:underline"
                      >
                        {issue.title}
                      </Link>
                    )}

                    {issue.assigneeName && (
                      <p className="mt-2 text-xs text-faint">{issue.assigneeName}</p>
                    )}

                    {canEdit && (
                      <select
                        value={issue.status}
                        onChange={(event) =>
                          void board.updateIssue(issue.id, {
                            status: event.target.value as IssueStatus,
                          })
                        }
                        aria-label={`Status for ${issue.key}`}
                        className="mt-3 w-full rounded border border-line bg-surface px-2 py-1 text-xs text-muted outline-none focus:border-accent"
                      >
                        {BOARD_COLUMNS.map((status) => (
                          <option key={status} value={status}>
                            {COLUMN_LABELS[status]}
                          </option>
                        ))}
                      </select>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </main>
  );
}
