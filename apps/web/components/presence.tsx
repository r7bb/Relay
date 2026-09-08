'use client';

import type { PresenceUser } from '@relay/shared';
import type { ConnectionState } from '../lib/realtime.ts';

const AVATAR_COLORS = [
  'bg-indigo-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-sky-500',
  'bg-violet-500',
];

/** Stable colour per user, so the same person keeps the same swatch across
 * reloads and across other people's screens. */
function colorFor(userId: string): string {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts.at(-1)![0]!).toUpperCase();
}

export function PresenceBar({
  users,
  state,
  /** When set, users reporting this location get a "here" ring. */
  here,
}: {
  users: PresenceUser[];
  state: ConnectionState;
  here?: string | null;
}) {
  const label =
    state === 'live'
      ? `${users.length} online`
      : state === 'connecting'
        ? 'Connecting…'
        : 'Reconnecting…';

  return (
    <div className="flex items-center gap-3">
      <div className="flex -space-x-2">
        {users.map((user) => (
          <span
            key={user.userId}
            title={here && user.location === here ? `${user.name} — viewing this board` : user.name}
            className={[
              'grid h-7 w-7 place-items-center rounded-full text-[10px] font-semibold text-white ring-2',
              colorFor(user.userId),
              here && user.location === here ? 'ring-emerald-400' : 'ring-surface',
            ].join(' ')}
          >
            {initials(user.name)}
          </span>
        ))}
      </div>

      <span className="flex items-center gap-1.5 text-xs text-slate-500">
        <span
          aria-hidden
          className={[
            'h-1.5 w-1.5 rounded-full',
            state === 'live'
              ? 'bg-emerald-400'
              : state === 'connecting'
                ? 'bg-amber-400'
                : 'bg-slate-600',
          ].join(' ')}
        />
        {label}
      </span>
    </div>
  );
}
