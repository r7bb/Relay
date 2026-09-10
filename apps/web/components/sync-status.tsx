'use client';

/**
 * Offline / unsynced indicator.
 *
 * Local-first only works if the user can trust it, and trust needs visible
 * state: whether the app is reaching the server, and whether anything is still
 * waiting to be sent. Silence would be indistinguishable from data loss.
 */
export function SyncStatus({ online, pending }: { online: boolean; pending: number }) {
  if (online && pending === 0) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-faint">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        Synced
      </span>
    );
  }

  const message = !online
    ? pending > 0
      ? `Offline — ${pending} change${pending === 1 ? '' : 's'} saved on this device`
      : 'Offline — changes will be saved locally'
    : `Syncing ${pending} change${pending === 1 ? '' : 's'}…`;

  return (
    <span
      role="status"
      className={[
        'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs',
        online ? 'bg-sky-950/60 text-sky-300' : 'bg-amber-950/60 text-amber-300',
      ].join(' ')}
    >
      <span
        aria-hidden
        className={['h-1.5 w-1.5 rounded-full', online ? 'bg-sky-400' : 'bg-amber-400'].join(' ')}
      />
      {message}
    </span>
  );
}
