import { resolveSession, SESSION_COOKIE } from '@relay/auth';
import {
  type Database,
  findMembership,
  publishPresence,
  subscribeToEvents,
  subscribeToPresence,
} from '@relay/database';
import type { ClientMessage, PresenceMessage, ServerEvent, ServerMessage } from '@relay/shared';
import type postgres from 'postgres';
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
        }
      },

      async close(socket) {
        sockets.delete(socket);
        const { workspaceId, connectionId } = socket.data;
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

      await server.stop(true);
    },
  };
}
