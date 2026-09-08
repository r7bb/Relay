'use client';

import type { DocumentAwareness, ServerMessage } from '@relay/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';

const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? 'ws://localhost:4001/ws';

export type Collaborator = DocumentAwareness & { userId: string; name: string };

export type DocumentState = {
  text: string;
  collaborators: Collaborator[];
  connected: boolean;
  /** Replace the range [from, to) with `insert`. */
  edit: (from: number, to: number, insert: string) => void;
  reportCursor: (cursor: number | null) => void;
};

const encode = (update: Uint8Array) => btoa(String.fromCharCode(...update));

const decode = (encoded: string) =>
  Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));

/**
 * Bind a Yjs document to React state over the realtime gateway.
 *
 * The `Y.Doc` is the source of truth, not React state. Every local edit is
 * applied to the document first and React re-renders from the result, which is
 * what makes a remote edit arriving mid-keystroke merge instead of fighting the
 * local one.
 */
export function useDocument(workspaceId: string, documentId: string): DocumentState {
  const [text, setText] = useState('');
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [connected, setConnected] = useState(false);

  const docRef = useRef<Y.Doc | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const doc = new Y.Doc();
    docRef.current = doc;

    const socket = new WebSocket(REALTIME_URL);
    socketRef.current = socket;

    let disposed = false;

    const send = (message: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    /**
     * Forward local changes only. Without the origin check this would echo
     * every remote update straight back to the server.
     */
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      setText(doc.getText('content').toString());
      if (origin === 'remote') return;
      send({ type: 'doc.update', documentId, update: encode(update) });
    };

    doc.on('update', onUpdate);

    socket.onopen = () => {
      // Workspace membership is checked on subscribe; the document is then
      // checked against that workspace.
      send({ type: 'subscribe', workspaceId });
      send({ type: 'doc.open', documentId });
    };

    socket.onmessage = (raw) => {
      const message = JSON.parse(String(raw.data)) as ServerMessage;

      switch (message.type) {
        case 'doc.sync':
          if (message.documentId !== documentId) return;
          Y.applyUpdate(doc, decode(message.update), 'remote');
          setConnected(true);
          return;

        case 'doc.update':
          if (message.documentId !== documentId) return;
          Y.applyUpdate(doc, decode(message.update), 'remote');
          return;

        case 'doc.awareness':
          if (message.documentId !== documentId) return;
          setCollaborators(message.users);
          return;

        case 'error':
          console.warn('document:', message.message);
          return;
      }
    };

    socket.onclose = () => {
      if (!disposed) setConnected(false);
    };

    return () => {
      disposed = true;
      doc.off('update', onUpdate);
      send({ type: 'doc.close', documentId });
      socket.close();
      doc.destroy();
      docRef.current = null;
      socketRef.current = null;
    };
  }, [workspaceId, documentId]);

  /**
   * Apply a text change as a delete plus an insert on the shared type.
   *
   * Sending the whole textarea value would destroy the point of the CRDT: it
   * would look like "delete everything, insert everything", and a concurrent
   * edit would be wiped rather than merged.
   */
  const edit = useCallback((from: number, to: number, insert: string) => {
    const doc = docRef.current;
    if (!doc) return;

    const content = doc.getText('content');

    // One transaction so remote peers see a single atomic change.
    doc.transact(() => {
      if (to > from) content.delete(from, to - from);
      if (insert) content.insert(from, insert);
    });
  }, []);

  const reportCursor = useCallback(
    (cursor: number | null) => {
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return;

      socket.send(JSON.stringify({ type: 'doc.awareness', documentId, state: { cursor } }));
    },
    [documentId],
  );

  return { text, collaborators, connected, edit, reportCursor };
}
