import { resolveSession, SESSION_COOKIE } from '@relay/auth';
import {
  type Database,
  findMembership,
  publishPresence,
  subscribeToEvents,
  subscribeToPresence,
} from '@relay/database';
import type {
  ClientMessage,
  DocumentAwareness,
  PresenceMessage,
  ServerEvent,
  ServerMessage,
} from '@relay/shared';
import type postgres from 'postgres';
import { DocumentRooms, documentInWorkspace } from './documents.ts';
import { PresenceRegistry } from './presence.ts';

/**
 * WebSocket gateway.
 *
 * A separate process from the REST API rather than an upgrade handler bolted
 * onto Fastify. Two reasons: long-lived sockets and short request/response
 * traffic have opposite scaling shapes -- one is bounded by memory and file
 * descriptors, the other by CPU -- and separating them means a deploy of the
 * API does not drop every open connection.
 *
 * It shares the database and the session logic with the API, so there is one
 * definition of who you are and what you may see.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How often each instance re-announces its presence entries to peers. Must be
 * comfortably below PRESENCE_TTL_MS so peers never expire a live connection. */
const REANNOUNCE_INTERVAL_MS = 15_000;
const SWEEP_INTERVAL_MS = 10_000;

type SocketData = {
  connectionId: string;
  userId: string;
  name: string;
  /** Null until the client sends `subscribe` and passes the membership check. */
  workspaceId: string | null;
  location: string | null;
  /** Documents this connection has open, so close can release all of them. */
  openDocuments: Set<string>;
};

export type GatewayOptions = {
  db: Database;
  /** Raw client: LISTEN holds a dedicated connection and must bypass the pool. */
  listenClient: postgres.Sql;
  port?: number;
  /** Origin allowed to open a socket. */
  webOrigin?: string;
  instanceId?: string;
};

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }

  return null;
}

export async function createGateway(options: GatewayOptions) {
  const { db, listenClient, port = 4001, webOrigin = 'http://localhost:3000' } = options;
  const instanceId = options.instanceId ?? crypto.randomUUID();

  const presence = new PresenceRegistry();
  const rooms = new DocumentRooms(db);
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>();

  function send(socket: Bun.ServerWebSocket<SocketData>, message: ServerMessage) {
    socket.send(JSON.stringify(message));
  }

  /** Push the current presence roster for a workspace to everyone in it. */
  function broadcastPresence(workspaceId: string) {
    const users = presence.forWorkspace(workspaceId);
    const message = JSON.stringify({
      type: 'presence',
      workspaceId,
      users,
    } satisfies ServerMessage);

    for (const socket of sockets) {
      if (socket.data.workspaceId === workspaceId) socket.send(message);
    }
  }

  function broadcastEvent(event: ServerEvent) {
    const message = JSON.stringify({ type: 'event', event } satisfies ServerMessage);

    for (const socket of sockets) {
      // Membership was verified at subscribe time, and revocation closes the
      // socket, so workspace id is sufficient to scope the fan-out here.
      if (socket.data.workspaceId === event.workspaceId) socket.send(message);
    }
  }

  const server = Bun.serve<SocketData>({
    port,

    async fetch(request, srv) {
      const url = new URL(request.url);

      if (url.pathname === '/health') {
        return Response.json({
          status: 'ok',
          instanceId,
          connections: sockets.size,
          presence: presence.size,
          documentRooms: rooms.size,
        });
      }

      if (url.pathname !== '/ws') return new Response('Not found', { status: 404 });

      // Browsers do not enforce same-origin on WebSockets, so the gateway has
      // to check Origin itself; otherwise any site could open an authenticated
      // socket using the visitor's cookie.
      const origin = request.headers.get('origin');
      if (origin && origin !== webOrigin) {
        return new Response('Forbidden origin', { status: 403 });
      }

      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      if (!token) return new Response('Unauthorized', { status: 401 });

      const user = await resolveSession(db, token);
      if (!user) return new Response('Unauthorized', { status: 401 });

      const upgraded = srv.upgrade(request, {
        data: {
          connectionId: crypto.randomUUID(),
          userId: user.id,
          name: user.name,
          workspaceId: null,
          location: null,
          openDocuments: new Set<string>(),
        } satisfies SocketData,
      });

      return upgraded ? undefined : new Response('Upgrade failed', { status: 400 });
    },

    websocket: {
      open(socket) {
        sockets.add(socket);
      },

      async message(socket, raw) {
        let message: ClientMessage;
        try {
          message = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          return send(socket, { type: 'error', message: 'Malformed message' });
        }

        // One handler per message type, so adding a message kind does not make
        // an already-long switch longer.
        switch (message.type) {
          case 'subscribe':
            return handleSubscribe(socket, message.workspaceId);
          case 'location':
            return handleLocation(socket, message.location);
          case 'ping':
            return handlePing(socket);
          case 'doc.open':
            return handleDocOpen(socket, message.documentId);
          case 'doc.close':
            return handleDocClose(socket, message.documentId);
          case 'doc.update':
            return handleDocUpdate(socket, message.documentId, message.update);
          case 'doc.awareness':
            return handleDocAwareness(socket, message.documentId, message.state);
        }
      },

      async close(socket) {
        sockets.delete(socket);
        const { workspaceId, connectionId, openDocuments } = socket.data;

        // Leaving the last seat in a room flushes its pending writes, so a
        // closed tab does not strand unsaved edits.
        for (const documentId of openDocuments) {
          const room = await rooms.leave(documentId, connectionId);
          if (room) broadcastAwareness(documentId);
        }
        openDocuments.clear();

        if (!workspaceId) return;

        presence.remove(connectionId);
        broadcastPresence(workspaceId);
        await publishPresence(db, { kind: 'remove', instanceId, connectionId, workspaceId });
      },
    },
  });

  /**
   * Join a workspace feed.
   *
   * Authorization happens here rather than at connect time: the cookie proves
   * who you are, membership proves what you may watch.
   */
  async function handleSubscribe(socket: Bun.ServerWebSocket<SocketData>, workspaceId: string) {
    const membership = await findMembership(db, workspaceId, socket.data.userId);

    if (!membership) {
      return send(socket, { type: 'error', message: 'Not a member of that workspace' });
    }

    const previous = socket.data.workspaceId;
    socket.data.workspaceId = workspaceId;
    socket.data.location = null;

    await announce(socket);
    send(socket, { type: 'ready', userId: socket.data.userId, workspaceId });

    broadcastPresence(workspaceId);
    // Leaving one workspace for another changes both rosters.
    if (previous && previous !== workspaceId) broadcastPresence(previous);
  }

  async function handleLocation(socket: Bun.ServerWebSocket<SocketData>, location: string | null) {
    const { workspaceId } = socket.data;
    if (!workspaceId) return;

    socket.data.location = location;
    await announce(socket);
    broadcastPresence(workspaceId);
  }

  /** Refreshes this connection's TTL locally and on peers. */
  async function handlePing(socket: Bun.ServerWebSocket<SocketData>) {
    if (socket.data.workspaceId) await announce(socket);
  }

  /** Push the current cursor roster for a document to everyone editing it. */
  function broadcastAwareness(documentId: string) {
    const room = rooms.get(documentId);
    if (!room) return;

    const message = JSON.stringify({
      type: 'doc.awareness',
      documentId,
      users: room.awarenessList(),
    } satisfies ServerMessage);

    for (const socket of sockets) {
      if (socket.data.openDocuments.has(documentId)) socket.send(message);
    }
  }

  /** Relay a document update to every other editor. The sender already has it. */
  function broadcastDocUpdate(documentId: string, update: string, from: string) {
    const message = JSON.stringify({
      type: 'doc.update',
      documentId,
      update,
      actorId: from,
    } satisfies ServerMessage);

    for (const socket of sockets) {
      if (socket.data.connectionId === from) continue;
      if (socket.data.openDocuments.has(documentId)) socket.send(message);
    }
  }

  /**
   * Join a document room.
   *
   * The document must live in the workspace this socket is subscribed to --
   * membership was checked at subscribe time, and this ties the document to
   * that same tenant so a document id from elsewhere is not reachable.
   */
  async function handleDocOpen(socket: Bun.ServerWebSocket<SocketData>, documentId: string) {
    const { workspaceId } = socket.data;
    if (!workspaceId) {
      return send(socket, { type: 'error', message: 'Subscribe to a workspace first' });
    }

    if (!UUID_RE.test(documentId) || !(await documentInWorkspace(db, documentId, workspaceId))) {
      return send(socket, { type: 'error', message: 'Document not found' });
    }

    const room = await rooms.join(documentId, {
      connectionId: socket.data.connectionId,
      userId: socket.data.userId,
      name: socket.data.name,
      awareness: { cursor: null },
    });

    socket.data.openDocuments.add(documentId);

    // One catch-up message rather than a replay of the update log.
    send(socket, {
      type: 'doc.sync',
      documentId,
      update: Buffer.from(room.fullState()).toString('base64'),
    });

    broadcastAwareness(documentId);
  }

  async function handleDocClose(socket: Bun.ServerWebSocket<SocketData>, documentId: string) {
    if (!socket.data.openDocuments.delete(documentId)) return;

    const room = await rooms.leave(documentId, socket.data.connectionId);
    if (room) broadcastAwareness(documentId);
  }

  function handleDocUpdate(
    socket: Bun.ServerWebSocket<SocketData>,
    documentId: string,
    encoded: string,
  ) {
    if (!socket.data.openDocuments.has(documentId)) return;

    const room = rooms.get(documentId);
    if (!room) return;

    let update: Uint8Array;
    try {
      update = new Uint8Array(Buffer.from(encoded, 'base64'));
    } catch {
      return send(socket, { type: 'error', message: 'Malformed document update' });
    }

    // Nothing new means nothing to relay -- Yjs tolerates duplicates, but the
    // other editors should not pay for them.
    if (room.applyUpdate(update)) {
      broadcastDocUpdate(documentId, encoded, socket.data.connectionId);
    }
  }

  function handleDocAwareness(
    socket: Bun.ServerWebSocket<SocketData>,
    documentId: string,
    state: DocumentAwareness,
  ) {
    const room = rooms.get(documentId);
    const participant = room?.participants.get(socket.data.connectionId);
    if (!participant) return;

    // Cursor positions are ephemeral by definition; they are never persisted.
    participant.awareness = state;
    broadcastAwareness(documentId);
  }

  /** Record a connection locally and tell peers about it. */
  async function announce(socket: Bun.ServerWebSocket<SocketData>) {
    const { connectionId, userId, name, workspaceId, location } = socket.data;
    if (!workspaceId) return;

    presence.upsert({
      connectionId,
      instanceId,
      workspaceId,
      userId,
      name,
      location,
      lastSeenAt: Date.now(),
    });

    await publishPresence(db, {
      kind: 'upsert',
      instanceId,
      connectionId,
      workspaceId,
      userId,
      name,
      location,
    });
  }

  const unsubscribeEvents = await subscribeToEvents(listenClient, broadcastEvent);

  /** Apply a peer's presence delta and rebroadcast any roster it changed. */
  function applyPresenceGossip(message: PresenceMessage) {
    // Our own gossip is already applied locally.
    if (message.instanceId === instanceId) return;

    for (const workspaceId of presence.apply(message)) broadcastPresence(workspaceId);
  }

  const unsubscribePresence = await subscribeToPresence(listenClient, applyPresenceGossip);

  const reannounce = setInterval(() => {
    for (const socket of sockets) void announce(socket);
  }, REANNOUNCE_INTERVAL_MS);

  const sweeper = setInterval(() => {
    for (const workspaceId of presence.sweep()) broadcastPresence(workspaceId);
  }, SWEEP_INTERVAL_MS);

  return {
    server,
    port: server.port,
    instanceId,
    presence,

    async close() {
      clearInterval(reannounce);
      clearInterval(sweeper);

      // Tell peers to drop our entries immediately rather than waiting for TTL.
      await publishPresence(db, { kind: 'bye', instanceId }).catch(() => {});
      await unsubscribeEvents().catch(() => {});
      await unsubscribePresence().catch(() => {});

      for (const socket of sockets) socket.close(1001, 'Server shutting down');
      sockets.clear();

      // Persist anything still debounced before the process goes away.
      await rooms.closeAll();

      await server.stop(true);
    },
  };
}
