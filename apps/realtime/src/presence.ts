import type { PresenceUser } from '@relay/shared';

/**
 * Who is currently connected, per workspace.
 *
 * Presence is deliberately *not* stored in Postgres. It changes on every route
 * navigation and every heartbeat, and none of it is worth durability -- writing
 * it would turn a read-mostly database into a write-heavy one for data that is
 * meaningless thirty seconds later.
 *
 * It is therefore in-memory and per-instance. Two gateway processes each know
 * only their own connections, so they exchange deltas over the same Postgres
 * NOTIFY channel the domain events use. That keeps the merged view correct
 * without a shared store.
 *
 * The gap this leaves: a gateway that dies takes its entries with it silently,
 * so peers would show ghosts. `sweep()` handles that -- every entry carries a
 * `lastSeenAt` refreshed by the client heartbeat, and anything stale is
 * dropped. Redis with per-key TTLs would do the same job without the sweep.
 */

export type PresenceEntry = {
  connectionId: string;
  instanceId: string;
  workspaceId: string;
  userId: string;
  name: string;
  location: string | null;
  lastSeenAt: number;
};

/** Drop entries not refreshed within this window. Must exceed the client's
 * heartbeat interval by enough to tolerate a missed beat. */
export const PRESENCE_TTL_MS = 45_000;

export class PresenceRegistry {
  private readonly entries = new Map<string, PresenceEntry>();

  /** Insert or refresh an entry. Returns true if the visible set changed. */
  upsert(entry: PresenceEntry): boolean {
    const existing = this.entries.get(entry.connectionId);
    this.entries.set(entry.connectionId, entry);

    // A heartbeat that changes nothing but `lastSeenAt` should not cause a
    // broadcast; only membership and location are visible to other clients.
    return (
      existing === undefined ||
      existing.location !== entry.location ||
      existing.workspaceId !== entry.workspaceId
    );
  }

  remove(connectionId: string): boolean {
    return this.entries.delete(connectionId);
  }

  /** Remove every entry belonging to an instance that has gone away. */
  removeInstance(instanceId: string): boolean {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (entry.instanceId === instanceId) {
        this.entries.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  sweep(now = Date.now()): string[] {
    const affected = new Set<string>();

    for (const [id, entry] of this.entries) {
      if (now - entry.lastSeenAt > PRESENCE_TTL_MS) {
        this.entries.delete(id);
        affected.add(entry.workspaceId);
      }
    }

    return [...affected];
  }

  /**
   * Presence for a workspace, deduplicated by user. Someone with three tabs
   * open is one person; their reported location is whichever connection was
   * seen most recently.
   */
  forWorkspace(workspaceId: string): PresenceUser[] {
    const byUser = new Map<string, PresenceEntry>();

    for (const entry of this.entries.values()) {
      if (entry.workspaceId !== workspaceId) continue;

      const current = byUser.get(entry.userId);
      if (!current || entry.lastSeenAt > current.lastSeenAt) byUser.set(entry.userId, entry);
    }

    return [...byUser.values()]
      .map(({ userId, name, location }) => ({ userId, name, location }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Workspaces this registry currently knows about, for targeted broadcasts. */
  workspaces(): string[] {
    return [...new Set([...this.entries.values()].map((e) => e.workspaceId))];
  }

  get size(): number {
    return this.entries.size;
  }
}
