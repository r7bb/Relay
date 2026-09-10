'use client';

import {
  BOARD_COLUMNS,
  can,
  ISSUE_PRIORITIES,
  type IssuePriority,
  type IssueStatus,
} from '@relay/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { CommentThread } from '../../../../../components/comment-thread.tsx';
import { DeleteButton } from '../../../../../components/delete-button.tsx';
import { PresenceBar } from '../../../../../components/presence.tsx';
import { ErrorState } from '../../../../../components/ui.tsx';
import {
  api,
  type IssueDetail,
  type Member,
  type WorkspaceSummary,
} from '../../../../../lib/api.ts';
import { useRealtime } from '../../../../../lib/realtime.ts';
import { lastTheme, useApplyTheme } from '../../../../../lib/theme.ts';

const STATUS_LABELS: Record<IssueStatus, string> = {
  TODO: 'Todo',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  DONE: 'Done',
  CANCELED: 'Canceled',
};

export default function IssuePage() {
  const { workspaceId, issueId } = useParams<{ workspaceId: string; issueId: string }>();
  const router = useRouter();
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

  useApplyTheme(workspace.data?.workspace.theme ?? lastTheme());

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

  const remove = useMutation({
    mutationFn: () =>
      api<void>(`/workspaces/${workspaceId}/issues/${issueId}`, { method: 'DELETE' }),
    onSuccess: () => {
      // This page is about to 404, so leave before invalidating.
      const projectId = issue.data?.issue.projectId;
      router.replace(
        projectId
          ? `/workspaces/${workspaceId}/projects/${projectId}`
          : `/workspaces/${workspaceId}`,
      );
      queryClient.invalidateQueries({ queryKey: ['issue', workspaceId] });
    },
  });

  if (issue.isError) return <ErrorState message={(issue.error as Error).message} />;

  const data = issue.data?.issue;
  const role = workspace.data?.workspace.role;
  const canEdit = role !== undefined && role !== 'GUEST';
  const canDelete = role !== undefined && can(role, 'issue:delete');

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <nav className="text-sm text-faint">
        <Link href="/workspaces" className="hover:text-muted">
          Workspaces
        </Link>
        <span className="mx-2">/</span>
        <Link href={`/workspaces/${workspaceId}`} className="hover:text-muted">
          {workspace.data?.workspace.name ?? '…'}
        </Link>
        {data && (
          <>
            <span className="mx-2">/</span>
            <Link
              href={`/workspaces/${workspaceId}/projects/${data.projectId}`}
              className="hover:text-muted"
            >
              Board
            </Link>
          </>
        )}
        <span className="mx-2">/</span>
        <span className="font-mono text-muted">{data?.key ?? '…'}</span>
      </nav>

      <div className="mt-4 flex items-center justify-end gap-3">
        <PresenceBar users={presence} state={realtimeState} here={issueId} />

        {data && (
          <DeleteButton
            allowed={canDelete}
            kind="issue"
            name={`${data.key} · ${data.title}`}
            cascade="Comments on this issue are deleted with it."
            onConfirm={() => remove.mutateAsync()}
          />
        )}
      </div>

      {data && (
        <>
          <EditableTitle
            title={data.title}
            draft={title}
            canEdit={canEdit}
            onStart={() => setTitle(data.title)}
            onChange={setTitle}
            onSave={(next) => {
              if (next && next !== data.title) update.mutate({ title: next });
              setTitle(null);
            }}
          />

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
            <p role="alert" className="mt-3 text-sm text-danger-soft">
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

/**
 * Click-to-edit heading.
 *
 * Extracted from the page because the two states plus the permission check
 * are most of its branching, and a heading that is sometimes a button and
 * sometimes a form reads better named than inlined.
 */
function EditableTitle({
  title,
  draft,
  canEdit,
  onStart,
  onChange,
  onSave,
}: {
  title: string;
  /** Null when not editing; the in-progress text otherwise. */
  draft: string | null;
  canEdit: boolean;
  onStart: () => void;
  onChange: (value: string) => void;
  onSave: (value: string) => void;
}) {
  if (draft === null) {
    return (
      <h1
        className={[
          'mt-4 text-2xl font-semibold tracking-tight text-content',
          canEdit ? 'cursor-text rounded px-1 -mx-1 hover:bg-raised' : '',
        ].join(' ')}
        onClick={() => canEdit && onStart()}
        onKeyDown={(event) => {
          if (canEdit && event.key === 'Enter') onStart();
        }}
        // Only interactive when editable, so a guest gets a plain heading.
        {...(canEdit ? { role: 'button', tabIndex: 0 } : {})}
      >
        {title}
      </h1>
    );
  }

  const save = (event: FormEvent) => {
    event.preventDefault();
    onSave(draft.trim());
  };

  return (
    <form onSubmit={save} className="mt-4">
      <input
        // biome-ignore lint/a11y/noAutofocus: this input only exists because the user just clicked the title to edit it, so focus is where they are already looking.
        autoFocus
        value={draft}
        onChange={(event) => onChange(event.target.value)}
        onBlur={save}
        aria-label="Issue title"
        className="w-full rounded-md border border-line bg-raised px-3 py-2 text-2xl font-semibold text-content outline-none focus:border-accent"
      />
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-faint">{label}</dt>
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
      className="w-full rounded-md border border-line bg-raised px-2 py-1.5 text-sm capitalize text-content outline-none focus:border-accent disabled:opacity-60"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
