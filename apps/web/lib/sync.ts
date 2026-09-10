'use client';

import {
  createStorage,
  type LocalIssue,
  SyncEngine,
  SyncError,
  type SyncTransport,
} from '@relay/sync';
import { ApiError, api } from './api.ts';

/**
 * Wires the transport-agnostic sync engine to this app's HTTP client and to
 * IndexedDB. The engine itself knows nothing about fetch or the browser, which
 * is what lets it be unit-tested without either.
 */

function toSyncError(error: unknown): SyncError {
  // Distinguishing "server refused" from "network unreachable" is what decides
  // whether a queued mutation is retried or discarded.
  if (error instanceof ApiError) return new SyncError(error.message, error.status);
  return new SyncError(error instanceof Error ? error.message : 'Network unavailable');
}

const transport: SyncTransport = {
  async createIssue(workspaceId, projectId, body, idempotencyKey) {
    try {
      return await api<{ issue: LocalIssue }>(
        `/workspaces/${workspaceId}/projects/${projectId}/issues`,
        { method: 'POST', body, headers: { 'idempotency-key': idempotencyKey } },
      );
    } catch (error) {
      throw toSyncError(error);
    }
  },

  async updateIssue(workspaceId, issueId, body, idempotencyKey) {
    try {
      return await api<{ issue: LocalIssue }>(`/workspaces/${workspaceId}/issues/${issueId}`, {
        method: 'PATCH',
        body,
        headers: { 'idempotency-key': idempotencyKey },
      });
    } catch (error) {
      throw toSyncError(error);
    }
  },

  async deleteIssue(workspaceId, issueId) {
    try {
      await api<void>(`/workspaces/${workspaceId}/issues/${issueId}`, { method: 'DELETE' });
    } catch (error) {
      throw toSyncError(error);
    }
  },

  async listIssues(workspaceId, projectId) {
    try {
      return await api<{ issues: LocalIssue[] }>(
        `/workspaces/${workspaceId}/projects/${projectId}/issues?limit=100`,
      );
    } catch (error) {
      throw toSyncError(error);
    }
  },
};

let engine: SyncEngine | null = null;

/** One engine per tab. Created lazily so it is never constructed during SSR,
 * where there is no IndexedDB. */
export function getSyncEngine(): SyncEngine {
  engine ??= new SyncEngine(createStorage('relay'), transport);
  return engine;
}
