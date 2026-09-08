'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
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

  const signOut = useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      queryClient.clear();
      router.replace('/login');
    },
  });

  if (me.isError) {
    router.replace('/login');
    return null;
  }

  function onCreate(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) createWorkspace.mutate(name.trim());
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white">Workspaces</h1>
          {me.data && (
            <p className="mt-1 text-sm text-slate-400">Signed in as {me.data.user.name}</p>
          )}
        </div>

        <button
          type="button"
          onClick={() => signOut.mutate()}
          className="text-sm text-slate-400 hover:text-slate-200"
        >
          Sign out
        </button>
      </header>

      <form onSubmit={onCreate} className="mt-8 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New workspace name"
          className="flex-1 rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-sm outline-none focus:border-indigo-500"
        />
        <button
          type="submit"
          disabled={createWorkspace.isPending || !name.trim()}
          className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
        >
          Create
        </button>
      </form>

      {createWorkspace.isError && (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {(createWorkspace.error as Error).message}
        </p>
      )}

      <ul className="mt-8 space-y-2">
        {workspaces.data?.workspaces.map((workspace) => (
          <li key={workspace.id}>
            <Link
              href={`/workspaces/${workspace.id}`}
              className="flex items-center justify-between rounded-lg border border-surface-border bg-surface-raised px-4 py-3 transition hover:border-slate-600"
            >
              <span>
                <span className="font-medium text-slate-100">{workspace.name}</span>
                <span className="ml-2 text-xs text-slate-500">/{workspace.slug}</span>
              </span>
              <RoleBadge role={workspace.role} />
            </Link>
          </li>
        ))}
      </ul>

      {workspaces.isSuccess && workspaces.data.workspaces.length === 0 && (
        <p className="mt-8 text-sm text-slate-500">
          No workspaces yet. Create one above to get started.
        </p>
      )}
    </main>
  );
}
