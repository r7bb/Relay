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
  deleteIssue: (issueId: string) => Promise<void>;
  /** Pull server state, e.g. after a realtime event. */
  refresh: () => Promise<void>;
};

/**
 * Whether the browser believes it has a network interface.
 *
 * This is necessary but not sufficient: `navigator.onLine` is false only when
 * there is no interface at all. Connected to a captive portal, or to a network
 * that cannot reach our server, it happily reports true. It is used here as a
 * fast negative signal, and reachability is judged separately by whether sync
 * actually succeeds.
 */
function useNetworkInterface(): boolean {
  // Assume online during SSR and before hydration; `navigator` does not exist
  // on the server and guessing offline would flash the banner on every load.
  const [present, setPresent] = useState(true);

  useEffect(() => {
    const update = () => setPresent(navigator.onLine);
    update();

    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return present;
}

export function useOfflineBoard(workspaceId: string, projectId: string): BoardState {
  const engine = getSyncEngine();
  const hasInterface = useNetworkInterface();

  const [issues, setIssues] = useState<LocalIssue[]>([]);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  /** Set when a sync attempt fails, cleared when one succeeds. */
  const [reachable, setReachable] = useState(true);

  // Reaching the server is the claim the indicator actually makes, so both
  // signals have to agree before it says "synced".
  const online = hasInterface && reachable;

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
      setReachable(true);
    } catch {
      // Offline, or the server is unhappy. The queue is durable, so the next
      // attempt picks up where this one stopped -- but stop claiming to be
      // synced in the meantime.
      setReachable(false);
    }
    await readLocal();
  }, [engine, workspaceId, projectId, readLocal]);

  // Paint from disk immediately, then reconcile in the background.
  useEffect(() => {
    void readLocal().then(() => sync());
  }, [readLocal, sync]);

  /*
   * Keep retrying whenever an interface exists, even after a failure -- the
   * failure is exactly what needs re-testing, and a captive portal or a
   * restarted server produces no `online` event to wake us up. With no
   * interface at all there is nothing to retry against, so the timer stops.
   */
  useEffect(() => {
    if (!hasInterface) return;

    void sync();
    const timer = setInterval(() => void sync(), FLUSH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasInterface, sync]);

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

  const deleteIssue = useCallback(
    async (issueId: string) => {
      await engine.deleteIssue(workspaceId, issueId);
      await readLocal();
      void sync();
    },
    [engine, workspaceId, readLocal, sync],
  );

  return {
    issues,
    online,
    pending,
    loading,
    createIssue,
    updateIssue,
    deleteIssue,
    refresh: sync,
  };
}
