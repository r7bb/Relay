/**
 * Wire format for realtime messages.
 *
 * Shared by the API (which publishes), the gateway (which fans out) and the web
 * client (which reacts), so a change to an event shape is a compile error in
 * all three rather than a silently ignored message.
 */

export const REALTIME_CHANNEL = 'relay_events';

/** Separate channel so a gateway can subscribe to presence without parsing
 * every domain event, and so the two can be split later. */
export const PRESENCE_CHANNEL = 'relay_presence';

/** Server -> client domain events. */
export type ServerEvent =
  | {
      type: 'issue.created';
      workspaceId: string;
      projectId: string;
      issueId: string;
      actorId: string;
    }
  | {
      type: 'issue.updated';
      workspaceId: string;
      projectId: string;
      issueId: string;
      actorId: string;
    }
  | {
      type: 'issue.deleted';
      workspaceId: string;
      projectId: string;
      issueId: string;
      actorId: string;
    }
  | { type: 'project.created'; workspaceId: string; projectId: string; actorId: string }
  | { type: 'project.deleted'; workspaceId: string; projectId: string; actorId: string }
  | { type: 'comment.created'; workspaceId: string; issueId: string; actorId: string }
  | { type: 'member.changed'; workspaceId: string; actorId: string };

export type PresenceUser = {
  userId: string;
  name: string;
  /** Route the user currently has open, e.g. a projectId. Null on the index. */
  location: string | null;
};

/** Messages the gateway sends down the socket. */
export type ServerMessage =
  | { type: 'ready'; userId: string; workspaceId: string }
  | { type: 'event'; event: ServerEvent }
  | { type: 'presence'; workspaceId: string; users: PresenceUser[] }
  | { type: 'error'; message: string };

/** Messages the client sends up the socket. */
export type ClientMessage =
  | { type: 'subscribe'; workspaceId: string }
  | { type: 'location'; location: string | null }
  | { type: 'ping' };

/**
 * Presence gossip between gateway instances.
 *
 * Deltas rather than snapshots, so payloads stay small. Instances re-announce
 * their entries periodically, which both refreshes peers' TTLs and repairs any
 * delta that was missed while a listener was reconnecting.
 */
export type PresenceMessage =
  | {
      kind: 'upsert';
      instanceId: string;
      connectionId: string;
      workspaceId: string;
      userId: string;
      name: string;
      location: string | null;
    }
  | { kind: 'remove'; instanceId: string; connectionId: string; workspaceId: string }
  | { kind: 'bye'; instanceId: string };

/**
 * Postgres NOTIFY truncates payloads above 8000 bytes. Every event above is a
 * handful of uuids, so this is a guard against a future field rather than a
 * limit anyone should be near.
 */
export const MAX_NOTIFY_BYTES = 7500;
