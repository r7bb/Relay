'use client';

import type { ClientMessage, PresenceUser, ServerEvent, ServerMessage } from '@relay/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? 'ws://localhost:4001/ws';

/** Must stay well under the gateway's presence TTL so a single dropped beat
 * does not evict a live connection. */
const HEARTBEAT_MS = 15_000;

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

export type ConnectionState = 'connecting' | 'live' | 'offline';

/**
 * Subscribe to a workspace's realtime feed.
 *
 * Events carry ids, not row contents, so the handler's job is to invalidate the
 * right query keys and let TanStack Query refetch through the normal authorized
 * endpoints. That keeps one authorization path instead of trusting whatever the
 * socket pushed, and it means a missed event during a reconnect is self-healing
 * -- the refetch on resubscribe brings everything current.
 */
export function useRealtime(workspaceId: string | null, location: string | null = null) {
  const queryClient = useQueryClient();
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [state, setState] = useState<ConnectionState>('connecting');

  const socketRef = useRef<WebSocket | null>(null);
  // Held in a ref so the reconnect loop can read the current location without
  // being torn down and rebuilt every time the user navigates.
  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    if (!workspaceId) return;

    let disposed = false;
    let attempt = 0;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const send = (message: ClientMessage) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify(message));
      }
    };

    function handleEvent(event: ServerEvent) {
      const invalidate = (key: unknown[]) => queryClient.invalidateQueries({ queryKey: key });

      switch (event.type) {
        case 'issue.created':
        case 'issue.updated':
        case 'issue.deleted':
          invalidate(['issues', event.workspaceId, event.projectId]);
          // Open-issue counts on the project list move too.
          invalidate(['projects', event.workspaceId]);
          return;

        case 'project.created':
        case 'project.deleted':
          invalidate(['projects', event.workspaceId]);
          return;

        case 'comment.created':
          invalidate(['comments', event.workspaceId, event.issueId]);
          return;

        case 'member.changed':
          invalidate(['members', event.workspaceId]);
          invalidate(['workspace', event.workspaceId]);
          return;
      }
    }

    function connect() {
      if (disposed) return;
      setState((current) => (current === 'live' ? 'connecting' : current));

      const socket = new WebSocket(REALTIME_URL);
      socketRef.current = socket;

      socket.onopen = () => {
        attempt = 0;
        send({ type: 'subscribe', workspaceId: workspaceId! });
      };

      socket.onmessage = (raw) => {
        const message = JSON.parse(String(raw.data)) as ServerMessage;

        switch (message.type) {
          case 'ready':
            setState('live');
            if (locationRef.current) send({ type: 'location', location: locationRef.current });
            // Anything that changed while we were disconnected is invisible to
            // us, so treat a fresh subscription as "refetch everything".
            queryClient.invalidateQueries();
            return;

          case 'presence':
            if (message.workspaceId === workspaceId) setPresence(message.users);
            return;

          case 'event':
            handleEvent(message.event);
            return;

          case 'error':
            console.warn('realtime:', message.message);
            return;
        }
      };

      socket.onclose = () => {
        if (disposed) return;
        setState('offline');
        setPresence([]);

        // Exponential backoff with jitter, so a gateway restart doesn't get a
        // synchronised stampede from every open tab.
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt++, RECONNECT_MAX_MS);
        retry = setTimeout(connect, delay + Math.random() * 250);
      };

      socket.onerror = () => socket.close();
    }

    connect();
    heartbeat = setInterval(() => send({ type: 'ping' }), HEARTBEAT_MS);

    return () => {
      disposed = true;
      clearInterval(heartbeat);
      clearTimeout(retry);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [workspaceId, queryClient]);

  // Location changes are sent on the existing socket rather than reconnecting.
  useEffect(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'location', location } satisfies ClientMessage));
    }
  }, [location]);

  return { presence, state };
}
