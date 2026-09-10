'use client';

import { can } from '@relay/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { DeleteButton } from '../../components/delete-button.tsx';
import { NotificationBell } from '../../components/notification-bell.tsx';
import { RoleBadge } from '../../components/ui.tsx';
import { api, type Me, type WorkspaceSummary } from '../../lib/api.ts';

export default function WorkspacesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), retry: false });

  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api<{ workspaces: WorkspaceSummary[] }>('/workspaces'),
    enabled: me.isSuccess,
  });

  const createWorkspace = useMutation({
    mutationFn: (workspaceName: string) =>
      api<{ workspace: WorkspaceSummary }>('/workspaces', {
        method: 'POST',
        body: { name: workspaceName },
      }),
    onSuccess: () => {
      setName('');
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });

  const deleteWorkspace = useMutation({
    mutationFn: (workspaceId: string) =>
      api<void>(`/workspaces/${workspaceId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
  });

  const signOut = useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      // Navigate before clearing: dropping the cache first makes this still
      // mounted page refetch `/auth/me`, get a 401, and bounce through the
      // unauthenticated redirect below for no reason.
      router.replace('/login');
      queryClient.clear();
    },
  });

  // `/auth/me` failing means no valid session -- the cookie expired, or the
  // user just signed out. Redirecting has to happen in an effect: navigation
  // updates the router's state, and React forbids updating another component
  // while this one is rendering.
  const unauthenticated = me.isError;

  useEffect(() => {
    if (unauthenticated) router.replace('/login');
  }, [unauthenticated, router]);

  if (unauthenticated) return null;

  function onCreate(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) createWorkspace.mutate(name.trim());
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-content">Workspaces</h1>
          {me.data && <p className="mt-1 text-sm text-muted">Signed in as {me.data.user.name}</p>}
        </div>

        <div className="flex items-center gap-4">
          <NotificationBell />

          <button
            type="button"
            onClick={() => signOut.mutate()}
            className="text-sm text-muted hover:text-content"
          >
            Sign out
          </button>
        </div>
      </header>

      <form onSubmit={onCreate} className="mt-8 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New workspace name"
          className="flex-1 rounded-md border border-line bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={createWorkspace.isPending || !name.trim()}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-contrast hover:bg-accent-hover disabled:opacity-50"
        >
          Create
        </button>
      </form>

      {createWorkspace.isError && (
        <p role="alert" className="mt-3 text-sm text-danger-soft">
          {(createWorkspace.error as Error).message}
        </p>
      )}

      <ul className="mt-8 space-y-2">
        {workspaces.data?.workspaces.map((workspace) => (
          <li
            key={workspace.id}
            className="flex items-center rounded-lg border border-line bg-raised transition hover:border-faint"
          >
            <Link
              href={`/workspaces/${workspace.id}`}
              className="flex flex-1 items-center justify-between px-4 py-3"
            >
              <span>
                <span className="font-medium text-content">{workspace.name}</span>
                <span className="ml-2 text-xs text-faint">/{workspace.slug}</span>
              </span>
              <RoleBadge role={workspace.role} />
            </Link>

            <DeleteButton
              allowed={can(workspace.role, 'workspace:delete')}
              kind="workspace"
              name={workspace.name}
              cascade="Every project, issue, document, comment and membership in this workspace is deleted. Other members lose access immediately."
              onConfirm={() => deleteWorkspace.mutateAsync(workspace.id)}
              className="mr-2"
            />
          </li>
        ))}
      </ul>

      {workspaces.isSuccess && workspaces.data.workspaces.length === 0 && (
        <p className="mt-8 text-sm text-faint">
          No workspaces yet. Create one above to get started.
        </p>
      )}
    </main>
  );
}
