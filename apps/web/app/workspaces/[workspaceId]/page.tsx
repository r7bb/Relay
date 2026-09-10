'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { MemberList } from '../../../components/member-list.tsx';
import { NotificationBell } from '../../../components/notification-bell.tsx';
import { PresenceBar } from '../../../components/presence.tsx';
import { SearchBox } from '../../../components/search-box.tsx';
import { ThemePicker } from '../../../components/theme-picker.tsx';
import { ErrorState, RoleBadge } from '../../../components/ui.tsx';
import {
  api,
  type DocumentSummary,
  type ProjectSummary,
  type WorkspaceSummary,
} from '../../../lib/api.ts';
import { useRealtime } from '../../../lib/realtime.ts';
import { lastTheme, rememberTheme, useApplyTheme } from '../../../lib/theme.ts';

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

  // Fall back to the last theme seen so navigating between workspaces does
  // not flash the default while this one loads.
  const theme = workspace.data?.workspace.theme ?? lastTheme();
  useApplyTheme(theme);
  rememberTheme(workspace.data?.workspace.theme);

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
  // Theme is a workspace setting, so it needs the same permission as renaming.
  const canManageWorkspace = role === 'OWNER' || role === 'ADMIN';

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <nav className="text-sm text-faint">
        <Link href="/workspaces" className="hover:text-muted">
          Workspaces
        </Link>
        <span className="mx-2">/</span>
        <span className="text-muted">{workspace.data?.workspace.name ?? '…'}</span>
      </nav>

      <header className="mt-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-content">
            {workspace.data?.workspace.name}
          </h1>
          {role && <RoleBadge role={role} />}
        </div>

        <div className="flex items-center gap-4">
          <PresenceBar users={presence} state={realtimeState} />
          <NotificationBell />
        </div>
      </header>

      <div className="mt-8">
        <SearchBox workspaceId={workspaceId} />
      </div>

      {canCreateProject && (
        <form onSubmit={onCreate} className="mt-4 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New project name"
            className="flex-1 rounded-md border border-line bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={createProject.isPending || !name.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-contrast hover:bg-accent-hover disabled:opacity-50"
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
            className="rounded-lg border border-line bg-raised p-4 transition hover:border-faint"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-content">{project.name}</span>
              <span className="font-mono text-xs text-faint">{project.key}</span>
            </div>
            <p className="mt-2 text-xs text-faint">
              {project.openIssues} open {project.openIssues === 1 ? 'issue' : 'issues'}
            </p>
          </Link>
        ))}
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-medium uppercase tracking-wide text-faint">Documents</h2>

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
              className="flex-1 rounded-md border border-line bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button
              type="submit"
              disabled={createDocument.isPending || !documentTitle.trim()}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-contrast hover:bg-accent-hover disabled:opacity-50"
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
                className="block rounded-lg border border-line bg-raised px-4 py-3 text-sm text-content transition hover:border-faint"
              >
                {document.title}
              </Link>
            </li>
          ))}
        </ul>

        {documentList.isSuccess && documentList.data.documents.length === 0 && (
          <p className="mt-3 text-sm text-faint">
            No documents yet. Create one to try collaborative editing.
          </p>
        )}
      </section>

      <ThemePicker workspaceId={workspaceId} current={theme} canEdit={canManageWorkspace} />

      <MemberList workspaceId={workspaceId} viewerRole={role} />
    </main>
  );
}
