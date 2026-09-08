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
  | { type: 'member.changed'; workspaceId: string; actorId: string }
  | { type: 'document.created'; workspaceId: string; documentId: string; actorId: string };

export type PresenceUser = {
  userId: string;
  name: string;
  /** Route the user currently has open, e.g. a projectId. Null on the index. */
  location: string | null;
};

/**
 * Document sync messages.
 *
 * Yjs updates are binary, and this socket carries JSON, so they travel
 * base64-encoded. That costs ~33% in size; the alternative is a second binary
 * socket, which is not worth the complexity at this scale. The encoding is
 * confined to these two message types.
 */
export type DocumentClientMessage =
  | { type: 'doc.open'; documentId: string }
  | { type: 'doc.close'; documentId: string }
  /** A Yjs update this client produced, base64-encoded. */
  | { type: 'doc.update'; documentId: string; update: string }
  /** Ephemeral cursor/selection state. Never persisted. */
  | { type: 'doc.awareness'; documentId: string; state: DocumentAwareness };

export type DocumentAwareness = {
  /** Caret offset in the shared text, or null when not focused. */
  cursor: number | null;
  /** Selection end, when a range is selected. */
  anchor?: number | null;
};

export type DocumentServerMessage =
  /** Full state on open, so a joining client catches up in one round trip. */
  | { type: 'doc.sync'; documentId: string; update: string }
  | { type: 'doc.update'; documentId: string; update: string; actorId: string }
  | {
      type: 'doc.awareness';
      documentId: string;
      users: (DocumentAwareness & { userId: string; name: string })[];
    };

/** Messages the gateway sends down the socket. */
export type ServerMessage =
  | { type: 'ready'; userId: string; workspaceId: string }
  | { type: 'event'; event: ServerEvent }
  | { type: 'presence'; workspaceId: string; users: PresenceUser[] }
  | { type: 'error'; message: string }
  | DocumentServerMessage;

/** Messages the client sends up the socket. */
export type ClientMessage =
  | { type: 'subscribe'; workspaceId: string }
  | { type: 'location'; location: string | null }
  | { type: 'ping' }
  | DocumentClientMessage;

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
