'use client';

import type { IssuePriority, IssueStatus } from '@relay/shared';
import type { LocalIssue } from '@relay/sync';
import { useCallback, useEffect, useState } from 'react';
import { getSyncEngine } from './sync.ts';

/**
 * Board state backed by the local store rather than by the network.
 *
 * Reads come from IndexedDB, so the board paints instantly and works with no
 * connection at all. Writes land locally and enter the queue; the flush is a
 * background concern the caller never awaits.
 */

/** How often to retry the queue while online. */
const FLUSH_INTERVAL_MS = 5_000;

export type BoardState = {
  issues: LocalIssue[];
  online: boolean;
  /** Mutations written locally but not yet acknowledged by the server. */
  pending: number;
  /** True until the first local read resolves. */
  loading: boolean;
  createIssue: (input: { title: string }) => Promise<void>;
  updateIssue: (
    issueId: string,
    input: Partial<{ title: string; status: IssueStatus; priority: IssuePriority }>,
  ) => Promise<void>;
  /** Pull server state, e.g. after a realtime event. */
  refresh: () => Promise<void>;
};

function useOnlineStatus(): boolean {
  // Assume online during SSR and before hydration; `navigator` does not exist
  // on the server and guessing offline would flash the banner on every load.
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();

    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return online;
}

export function useOfflineBoard(workspaceId: string, projectId: string): BoardState {
  const engine = getSyncEngine();
  const online = useOnlineStatus();

  const [issues, setIssues] = useState<LocalIssue[]>([]);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);

  /** Re-read the local store into React state. */
  const readLocal = useCallback(async () => {
    const [rows, queued] = await Promise.all([engine.localIssues(projectId), engine.queue.size()]);
    setIssues(rows);
    setPending(queued);
    setLoading(false);
  }, [engine, projectId]);

  /** Flush the queue, then pull server state, then repaint. */
  const sync = useCallback(async () => {
    try {
      await engine.flush();
      await engine.reconcile(workspaceId, projectId);
    } catch {
      // Offline, or the server is unhappy. The queue is durable, so the next
      // attempt picks up where this one stopped.
    }
    await readLocal();
  }, [engine, workspaceId, projectId, readLocal]);

  // Paint from disk immediately, then reconcile in the background.
  useEffect(() => {
    void readLocal().then(() => sync());
  }, [readLocal, sync]);

  // Retry while online. Skipping the timer when offline avoids a pointless
  // fetch every five seconds on a plane.
  useEffect(() => {
    if (!online) return;

    void sync();
    const timer = setInterval(() => void sync(), FLUSH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [online, sync]);

  const createIssue = useCallback(
    async (input: { title: string }) => {
      await engine.createIssue(workspaceId, projectId, input);
      // Repaint from the local store before the network is touched.
      await readLocal();
      void sync();
    },
    [engine, workspaceId, projectId, readLocal, sync],
  );

  const updateIssue = useCallback(
    async (
      issueId: string,
      input: Partial<{ title: string; status: IssueStatus; priority: IssuePriority }>,
    ) => {
      await engine.updateIssue(workspaceId, issueId, input);
      await readLocal();
      void sync();
    },
    [engine, workspaceId, readLocal, sync],
  );

  return { issues, online, pending, loading, createIssue, updateIssue, refresh: sync };
}
