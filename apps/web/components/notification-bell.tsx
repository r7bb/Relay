'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, type NotificationItem } from '../lib/api.ts';

/** Poll interval for the inbox. Notifications arrive via a worker, so there is
 * no realtime event to key off -- the job may land seconds after the comment. */
const POLL_MS = 20_000;

/**
 * Inbox for the signed-in user.
 *
 * Scoped by recipient rather than workspace, because notifications span every
 * workspace you belong to; each entry links back into the one it came from.
 */
export function NotificationBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const inbox = useQuery({
    queryKey: ['notifications'],
    queryFn: () =>
      api<{ notifications: NotificationItem[]; unreadCount: number }>('/notifications'),
    refetchInterval: POLL_MS,
    retry: false,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api<void>(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markAllRead = useMutation({
    mutationFn: () => api<void>('/notifications/read-all', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  // Close on an outside click or Escape, the way a menu is expected to behave.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Signed out, or the API is unreachable: show nothing rather than an error.
  if (inbox.isError) return null;

  const items = inbox.data?.notifications ?? [];
  const unread = inbox.data?.unreadCount ?? 0;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        className="relative rounded-md px-2 py-1 text-sm text-slate-400 hover:text-slate-200"
      >
        Inbox
        {unread > 0 && (
          <span className="ml-1.5 rounded-full bg-indigo-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-2 w-96 overflow-hidden rounded-lg border border-surface-border bg-surface-raised shadow-xl">
          <div className="flex items-center justify-between border-b border-surface-border px-4 py-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Notifications
            </span>

            {unread > 0 && (
              <button
                type="button"
                onClick={() => markAllRead.mutate()}
                className="text-xs text-slate-400 hover:text-slate-200"
              >
                Mark all read
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-500">Nothing here yet.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-surface-border overflow-y-auto">
              {items.map((item) => (
                <li key={item.id} className={item.readAt ? 'opacity-60' : undefined}>
                  <Link
                    href={
                      item.payload.issueId
                        ? `/workspaces/${item.workspaceId}/issues/${item.payload.issueId}`
                        : `/workspaces/${item.workspaceId}`
                    }
                    onClick={() => {
                      if (!item.readAt) markRead.mutate(item.id);
                      setOpen(false);
                    }}
                    className="block px-4 py-3 hover:bg-surface"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm text-slate-200">
                        <span className="font-medium">{item.actorName ?? 'Someone'}</span> mentioned
                        you
                        {item.payload.issueKey && (
                          <span className="ml-1 font-mono text-xs text-slate-500">
                            {item.payload.issueKey}
                          </span>
                        )}
                      </span>

                      {!item.readAt && (
                        <span
                          aria-hidden
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400"
                        />
                      )}
                    </div>

                    {item.payload.excerpt && (
                      <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                        {item.payload.excerpt}
                      </p>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
