'use client';

import { BOARD_COLUMNS, type IssueStatus } from '@relay/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { PresenceBar } from '../../../../../components/presence.tsx';
import { ErrorState } from '../../../../../components/ui.tsx';
import { useRealtime } from '../../../../../lib/realtime.ts';
import { type IssueSummary, type WorkspaceSummary, api } from '../../../../../lib/api.ts';

const COLUMN_LABELS: Record<IssueStatus, string> = {
  TODO: 'Todo',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  DONE: 'Done',
  CANCELED: 'Canceled',
};

type IssueList = { issues: IssueSummary[] };

export default function BoardPage() {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');

  const issuesKey = ['issues', workspaceId, projectId] as const;

  // Reporting the project as our location is what lets other people see who
  // else is looking at this board.
  const { presence, state: realtimeState } = useRealtime(workspaceId, projectId);

  const workspace = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => api<{ workspace: WorkspaceSummary }>(`/workspaces/${workspaceId}`),
  });

  const issues = useQuery({
    queryKey: issuesKey,
    queryFn: () =>
      api<IssueList>(`/workspaces/${workspaceId}/projects/${projectId}/issues?limit=100`),
  });

  const createIssue = useMutation({
    mutationFn: (issueTitle: string) =>
      api<{ issue: IssueSummary }>(`/workspaces/${workspaceId}/projects/${projectId}/issues`, {
        method: 'POST',
        body: { title: issueTitle },
      }),
    onSuccess: () => {
      setTitle('');
      queryClient.invalidateQueries({ queryKey: issuesKey });
    },
  });

  /**
   * Optimistic move: the card jumps columns immediately and only reconciles
   * with the server afterwards. This is the same shape the offline sync layer
   * will need -- apply locally first, reconcile later -- so the UI is already
   * written against it.
   */
  const moveIssue = useMutation({
    mutationFn: ({ id, status }: { id: string; status: IssueStatus }) =>
      api<{ issue: IssueSummary }>(`/workspaces/${workspaceId}/issues/${id}`, {
        method: 'PATCH',
        body: { status },
      }),

    onMutate: async ({ id, status }) => {
      // Stop an in-flight refetch from landing after the optimistic write and
      // clobbering it with stale data.
      await queryClient.cancelQueries({ queryKey: issuesKey });
      const previous = queryClient.getQueryData<IssueList>(issuesKey);

      queryClient.setQueryData<IssueList>(issuesKey, (current) =>
        current
          ? { issues: current.issues.map((i) => (i.id === id ? { ...i, status } : i)) }
          : current,
      );

      return { previous };
    },

    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(issuesKey, context.previous);
    },

    onSettled: () => queryClient.invalidateQueries({ queryKey: issuesKey }),
  });

  if (issues.isError) return <ErrorState message={(issues.error as Error).message} />;

  function onCreate(event: FormEvent) {
    event.preventDefault();
    if (title.trim()) createIssue.mutate(title.trim());
  }

  const role = workspace.data?.workspace.role;
  const canEdit = role !== undefined && role !== 'GUEST';

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <nav className="text-sm text-slate-500">
        <Link href="/workspaces" className="hover:text-slate-300">
          Workspaces
        </Link>
        <span className="mx-2">/</span>
        <Link href={`/workspaces/${workspaceId}`} className="hover:text-slate-300">
          {workspace.data?.workspace.name ?? '…'}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-300">Board</span>
      </nav>

      <div className="mt-4 flex justify-end">
        <PresenceBar users={presence} state={realtimeState} here={projectId} />
      </div>

      {canEdit && (
        <form onSubmit={onCreate} className="mt-6 flex gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
            className="flex-1 rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={createIssue.isPending || !title.trim()}
            className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
          >
            Add issue
          </button>
        </form>
      )}

      <div className="mt-8 grid gap-4 md:grid-cols-4">
        {BOARD_COLUMNS.map((column) => {
          const columnIssues = issues.data?.issues.filter((i) => i.status === column) ?? [];

          return (
            <section key={column} className="rounded-lg border border-surface-border bg-surface-raised/50 p-3">
              <h2 className="flex items-baseline justify-between text-xs font-medium uppercase tracking-wide text-slate-400">
                {COLUMN_LABELS[column]}
                <span className="text-slate-600">{columnIssues.length}</span>
              </h2>

              <ul className="mt-3 space-y-2">
                {columnIssues.map((issue) => (
                  <li
                    key={issue.id}
                    className="rounded-md border border-surface-border bg-surface-raised p-3"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-[10px] text-slate-500">{issue.key}</span>
                      {issue.priority !== 'NONE' && (
                        <span className="text-[10px] uppercase tracking-wide text-amber-500/80">
                          {issue.priority}
                        </span>
                      )}
                    </div>

                    <p className="mt-1 text-sm text-slate-200">{issue.title}</p>

                    {issue.assigneeName && (
                      <p className="mt-2 text-xs text-slate-500">{issue.assigneeName}</p>
                    )}

                    {canEdit && (
                      <select
                        value={issue.status}
                        onChange={(e) =>
                          moveIssue.mutate({ id: issue.id, status: e.target.value as IssueStatus })
                        }
                        aria-label={`Status for ${issue.key}`}
                        className="mt-3 w-full rounded border border-surface-border bg-surface px-2 py-1 text-xs text-slate-300 outline-none focus:border-indigo-500"
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
