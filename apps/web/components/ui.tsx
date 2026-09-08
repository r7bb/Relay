import Link from 'next/link';

/**
 * Shared presentational pieces. These live outside `app/` because Next.js
 * restricts what a route file may export -- a page module can only expose a
 * default component plus a fixed set of config fields.
 */

export function RoleBadge({ role }: { role: string }) {
  return (
    <span className="rounded-full border border-surface-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
      {role}
    </span>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-md px-6 py-24 text-center">
      <p className="text-sm text-slate-400">{message}</p>
      <Link
        href="/workspaces"
        className="mt-4 inline-block text-sm text-indigo-400 hover:underline"
      >
        Back to workspaces
      </Link>
    </main>
  );
}
