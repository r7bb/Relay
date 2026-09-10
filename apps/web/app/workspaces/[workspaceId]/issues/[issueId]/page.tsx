'use client';

import {
  BOARD_COLUMNS,
  ISSUE_PRIORITIES,
  type IssuePriority,
  type IssueStatus,
} from '@relay/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { CommentThread } from '../../../../../components/comment-thread.tsx';
import { PresenceBar } from '../../../../../components/presence.tsx';
import { ErrorState } from '../../../../../components/ui.tsx';
import {
  api,
  type IssueDetail,
  type Member,
  type WorkspaceSummary,
} from '../../../../../lib/api.ts';
import { useRealtime } from '../../../../../lib/realtime.ts';

const STATUS_LABELS: Record<IssueStatus, string> = {
  TODO: 'Todo',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  DONE: 'Done',
  CANCELED: 'Canceled',
};

export default function IssuePage() {
  const { workspaceId, issueId } = useParams<{ workspaceId: string; issueId: string }>();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState<string | null>(null);

  const issueKey = ['issue', workspaceId, issueId] as const;

  // Refresh on any realtime event touching this workspace, so a field someone
  // else changed does not sit stale on screen.
  const { presence, state: realtimeState } = useRealtime(workspaceId, issueId, () => {
    queryClient.invalidateQueries({ queryKey: issueKey });
    queryClient.invalidateQueries({ queryKey: ['comments', workspaceId, issueId] });
  });

  const workspace = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => api<{ workspace: WorkspaceSummary }>(`/workspaces/${workspaceId}`),
  });

  const issue = useQuery({
    queryKey: issueKey,
    queryFn: () => api<{ issue: IssueDetail }>(`/workspaces/${workspaceId}/issues/${issueId}`),
  });

  const members = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api<{ members: Member[] }>(`/workspaces/${workspaceId}/members`),
  });

  const update = useMutation({
    mutationFn: (patch: Partial<IssueDetail>) =>
      api<{ issue: IssueDetail }>(`/workspaces/${workspaceId}/issues/${issueId}`, {
        method: 'PATCH',
        body: patch,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: issueKey }),
  });

  if (issue.isError) return <ErrorState message={(issue.error as Error).message} />;

  const data = issue.data?.issue;
  const role = workspace.data?.workspace.role;
  const canEdit = role !== undefined && role !== 'GUEST';

  function saveTitle(event: FormEvent) {
    event.preventDefault();
    const next = title?.trim();
    if (next && next !== data?.title) update.mutate({ title: next });
    setTitle(null);
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <nav className="text-sm text-slate-500">
        <Link href="/workspaces" className="hover:text-slate-300">
          Workspaces
        </Link>
        <span className="mx-2">/</span>
        <Link href={`/workspaces/${workspaceId}`} className="hover:text-slate-300">
          {workspace.data?.workspace.name ?? '…'}
        </Link>
        {data && (
          <>
            <span className="mx-2">/</span>
            <Link
              href={`/workspaces/${workspaceId}/projects/${data.projectId}`}
              className="hover:text-slate-300"
            >
              Board
            </Link>
          </>
        )}
        <span className="mx-2">/</span>
        <span className="font-mono text-slate-300">{data?.key ?? '…'}</span>
      </nav>

      <div className="mt-4 flex justify-end">
        <PresenceBar users={presence} state={realtimeState} here={issueId} />
      </div>

      {data && (
        <>
          {title === null ? (
            <h1
              className={[
                'mt-4 text-2xl font-semibold tracking-tight text-white',
                canEdit ? 'cursor-text rounded px-1 -mx-1 hover:bg-surface-raised' : '',
              ].join(' ')}
              onClick={() => canEdit && setTitle(data.title)}
              onKeyDown={(event) => {
                if (canEdit && event.key === 'Enter') setTitle(data.title);
              }}
              // Only interactive when editable, so a guest gets a plain heading.
              {...(canEdit ? { role: 'button', tabIndex: 0 } : {})}
            >
              {data.title}
            </h1>
          ) : (
            <form onSubmit={saveTitle} className="mt-4">
              <input
                // biome-ignore lint/a11y/noAutofocus: this input only exists because the user just clicked the title to edit it, so focus is where they are already looking.
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={saveTitle}
                aria-label="Issue title"
                className="w-full rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-2xl font-semibold text-white outline-none focus:border-indigo-500"
              />
            </form>
          )}

          <dl className="mt-6 grid gap-4 sm:grid-cols-3">
            <Field label="Status">
              <Select
                value={data.status}
                disabled={!canEdit}
                onChange={(value) => update.mutate({ status: value as IssueStatus })}
                options={BOARD_COLUMNS.map((status) => ({
                  value: status,
                  label: STATUS_LABELS[status],
                }))}
              />
            </Field>

            <Field label="Priority">
              <Select
                value={data.priority}
                disabled={!canEdit}
                onChange={(value) => update.mutate({ priority: value as IssuePriority })}
                options={ISSUE_PRIORITIES.map((priority) => ({
                  value: priority,
                  label: priority === 'NONE' ? 'None' : priority.toLowerCase(),
                }))}
              />
            </Field>

            <Field label="Assignee">
              <Select
                value={data.assigneeId ?? ''}
                disabled={!canEdit}
                onChange={(value) => update.mutate({ assigneeId: value || null })}
                options={[
                  { value: '', label: 'Unassigned' },
                  ...(members.data?.members ?? []).map((member) => ({
                    value: member.userId,
                    label: member.name,
                  })),
                ]}
              />
            </Field>
          </dl>

          {update.isError && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {(update.error as Error).message}
            </p>
          )}

          <CommentThread
            workspaceId={workspaceId}
            issueId={issueId}
            canComment={role !== undefined}
          />
        </>
      )}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Select({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-md border border-surface-border bg-surface-raised px-2 py-1.5 text-sm capitalize text-slate-200 outline-none focus:border-indigo-500 disabled:opacity-60"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
