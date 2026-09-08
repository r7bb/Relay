'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { type Me, api } from '../lib/api.ts';

/** Entry point: bounce to the workspace list or to sign-in. */
export default function Home() {
  const router = useRouter();

  const { data, isPending, isError } = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/auth/me'),
    retry: false,
  });

  useEffect(() => {
    if (isPending) return;
    router.replace(isError || !data ? '/login' : '/workspaces');
  }, [data, isError, isPending, router]);

  return (
    <main className="grid min-h-screen place-items-center text-sm text-slate-500">Loading…</main>
  );
}
