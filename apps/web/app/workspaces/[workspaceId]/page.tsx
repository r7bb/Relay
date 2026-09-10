'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { NotificationBell } from '../../../components/notification-bell.tsx';
import { PresenceBar } from '../../../components/presence.tsx';
import { ErrorState, RoleBadge } from '../../../components/ui.tsx';
import {
  api,
  type DocumentSummary,
  type Member,
  type ProjectSummary,
  type WorkspaceSummary,
} from '../../../lib/api.ts';
import { useRealtime } from '../../../lib/realtime.ts';

export default function WorkspacePage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');

  // No location: on the workspace index you are "in the workspace", not in a
  // particular project.
  const { presence, state: realtimeState } = useRealtime(workspaceId, null);

  const workspace = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => api<{ workspace: WorkspaceSummary }>(`/workspaces/${workspaceId}`),
  });

  const projects = useQuery({
    queryKey: ['projects', workspaceId],
    queryFn: () => api<{ projects: ProjectSummary[] }>(`/workspaces/${workspaceId}/projects`),
  });

  const [documentTitle, setDocumentTitle] = useState('');

  const documentList = useQuery({
    queryKey: ['documents', workspaceId],
    queryFn: () => api<{ documents: DocumentSummary[] }>(`/workspaces/${workspaceId}/documents`),
  });

  const createDocument = useMutation({
    mutationFn: (title: string) =>
      api<{ document: DocumentSummary }>(`/workspaces/${workspaceId}/documents`, {
        method: 'POST',
        body: { title },
      }),
    onSuccess: () => {
      setDocumentTitle('');
      queryClient.invalidateQueries({ queryKey: ['documents', workspaceId] });
    },
  });

  const members = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api<{ members: Member[] }>(`/workspaces/${workspaceId}/members`),
  });

  const createProject = useMutation({
    mutationFn: (projectName: string) =>
      api<{ project: ProjectSummary }>(`/workspaces/${workspaceId}/projects`, {
        method: 'POST',
        body: { name: projectName },
      }),
    onSuccess: () => {
      setName('');
      queryClient.invalidateQueries({ queryKey: ['projects', workspaceId] });
    },
  });

  if (workspace.isError) {
    return <ErrorState message={(workspace.error as Error).message} />;
  }

  function onCreate(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) createProject.mutate(name.trim());
  }

  const role = workspace.data?.workspace.role;
  // Mirrors the server matrix: guests may look, not build. The API enforces
  // this regardless; hiding the control just avoids offering a dead button.
  const canCreateProject = role !== undefined && role !== 'GUEST';

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <nav className="text-sm text-slate-500">
        <Link href="/workspaces" className="hover:text-slate-300">
          Workspaces
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-300">{workspace.data?.workspace.name ?? '…'}</span>
      </nav>

      <header className="mt-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-white">
            {workspace.data?.workspace.name}
          </h1>
          {role && <RoleBadge role={role} />}
        </div>

        <div className="flex items-center gap-4">
          <PresenceBar users={presence} state={realtimeState} />
          <NotificationBell />
        </div>
      </header>

      {canCreateProject && (
        <form onSubmit={onCreate} className="mt-8 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New project name"
            className="flex-1 rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={createProject.isPending || !name.trim()}
            className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
          >
            Create project
          </button>
        </form>
      )}

      <section className="mt-8 grid gap-3 sm:grid-cols-2">
        {projects.data?.projects.map((project) => (
          <Link
            key={project.id}
            href={`/workspaces/${workspaceId}/projects/${project.id}`}
            className="rounded-lg border border-surface-border bg-surface-raised p-4 transition hover:border-slate-600"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-100">{project.name}</span>
              <span className="font-mono text-xs text-slate-500">{project.key}</span>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              {project.openIssues} open {project.openIssues === 1 ? 'issue' : 'issues'}
            </p>
          </Link>
        ))}
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">Documents</h2>

        {canCreateProject && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = documentTitle.trim();
              if (trimmed) createDocument.mutate(trimmed);
            }}
            className="mt-3 flex gap-2"
          >
            <input
              value={documentTitle}
              onChange={(event) => setDocumentTitle(event.target.value)}
              placeholder="New document title"
              className="flex-1 rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              disabled={createDocument.isPending || !documentTitle.trim()}
              className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
            >
              Create document
            </button>
          </form>
        )}

        <ul className="mt-3 space-y-2">
          {documentList.data?.documents.map((document) => (
            <li key={document.id}>
              <Link
                href={`/workspaces/${workspaceId}/documents/${document.id}`}
                className="block rounded-lg border border-surface-border bg-surface-raised px-4 py-3 text-sm text-slate-200 transition hover:border-slate-600"
              >
                {document.title}
              </Link>
            </li>
          ))}
        </ul>

        {documentList.isSuccess && documentList.data.documents.length === 0 && (
          <p className="mt-3 text-sm text-slate-500">
            No documents yet. Create one to try collaborative editing.
          </p>
        )}
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">Members</h2>
        <ul className="mt-3 divide-y divide-surface-border rounded-lg border border-surface-border bg-surface-raised">
          {members.data?.members.map((member) => (
            <li key={member.userId} className="flex items-center justify-between px-4 py-2.5">
              <span>
                <span className="text-sm text-slate-200">{member.name}</span>
                <span className="ml-2 text-xs text-slate-500">{member.email}</span>
              </span>
              <RoleBadge role={member.role} />
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
