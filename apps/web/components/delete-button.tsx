'use client';

import { useEffect, useId, useRef, useState } from 'react';

/**
 * Destructive actions, behind a confirmation.
 *
 * Everything deletable in Relay cascades to something: a workspace takes its
 * projects, issues and comments with it, a project takes its issues, a
 * document takes its edit history. None of it is recoverable, so the dialog
 * names what is about to go and what goes with it rather than asking a generic
 * "are you sure?".
 *
 * The dialog is a real modal rather than `window.confirm`: the native one
 * cannot say what will cascade, cannot be styled to match the theme, and
 * blocks the event loop while it is open, which would stall the sync flush
 * and the WebSocket in the background.
 */

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <path d="M2.5 4h11M6 4V2.75A.75.75 0 0 1 6.75 2h2.5a.75.75 0 0 1 .75.75V4M6.5 7v4.5M9.5 7v4.5M3.75 4l.6 8.4a1 1 0 0 0 1 .93h5.3a1 1 0 0 0 1-.93l.6-8.4" />
    </svg>
  );
}

export type DeleteButtonProps = {
  /** What is being deleted, e.g. "REL-12" or the workspace name. */
  name: string;
  /** The kind of thing, lowercase: "issue", "project", "workspace". */
  kind: string;
  /** What else disappears. Rendered as a warning when present. */
  cascade?: string;
  onConfirm: () => void | Promise<void>;
  /** Hidden entirely when false, for callers whose role forbids the action. */
  allowed?: boolean;
  /** Tucked into a list row, so it can sit inside a link without triggering it. */
  className?: string;
};

export function DeleteButton({
  name,
  kind,
  cascade,
  onConfirm,
  allowed = true,
  className = '',
}: DeleteButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  /** Where focus came from, so closing puts it back. */
  const openerRef = useRef<HTMLButtonElement>(null);

  // Cancel is focused rather than the destructive action: a stray Enter on an
  // opened dialog should not delete anything.
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!allowed) return null;

  function close() {
    setOpen(false);
    setError(null);
    openerRef.current?.focus();
  }

  async function confirm() {
    setBusy(true);
    setError(null);

    try {
      await onConfirm();
      setOpen(false);
    } catch (cause) {
      // Staying open with the reason visible beats closing and leaving the row
      // on screen with no explanation.
      setError(cause instanceof Error ? cause.message : 'Could not delete that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        aria-label={`Delete ${kind} ${name}`}
        title={`Delete ${kind}`}
        onClick={(event) => {
          // These often sit inside a link or a draggable card.
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        className={`rounded p-1.5 text-faint transition hover:bg-danger/10 hover:text-danger-soft focus:outline-none focus-visible:ring-1 focus-visible:ring-danger ${className}`}
      >
        <TrashIcon />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* The dismiss-on-click-outside target is a real button rather than
              a handler on a plain div, so it is announced and reachable
              instead of being a click trap for anyone not using a mouse. It
              is out of the tab order because Cancel already does this. */}
          <button
            type="button"
            aria-label="Cancel deletion"
            tabIndex={-1}
            onClick={close}
            className="absolute inset-0 h-full w-full cursor-default bg-black/60"
          />

          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="relative w-full max-w-sm rounded-xl border border-line bg-raised p-5 shadow-2xl"
          >
            <h2 id={titleId} className="text-sm font-semibold text-content">
              Delete {kind}
            </h2>

            <p className="mt-2 text-sm text-muted">
              <span className="font-medium text-content">{name}</span> will be permanently deleted.
              This cannot be undone.
            </p>

            {cascade && (
              <p className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger-soft">
                {cascade}
              </p>
            )}

            {error && (
              <p role="alert" className="mt-3 text-sm text-danger-soft">
                {error}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                ref={cancelRef}
                type="button"
                onClick={close}
                disabled={busy}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-content disabled:opacity-50"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={confirm}
                disabled={busy}
                className="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-danger-contrast hover:bg-danger-hover disabled:opacity-50"
              >
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
