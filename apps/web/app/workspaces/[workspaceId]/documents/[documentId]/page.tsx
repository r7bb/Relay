'use client';

import { diffEdit } from '@relay/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';
import { ErrorState } from '../../../../../components/ui.tsx';
import { api, type WorkspaceSummary } from '../../../../../lib/api.ts';
import { lastTheme, useApplyTheme } from '../../../../../lib/theme.ts';
import { useDocument } from '../../../../../lib/use-document.ts';

type DocumentMeta = { id: string; title: string };

function DocumentView() {
  const { workspaceId, documentId } = useParams<{ workspaceId: string; documentId: string }>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const meta = useQuery({
    queryKey: ['document', workspaceId, documentId],
    queryFn: () =>
      api<{ document: DocumentMeta }>(`/workspaces/${workspaceId}/documents/${documentId}`),
  });

  const workspace = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => api<{ workspace: WorkspaceSummary }>(`/workspaces/${workspaceId}`),
  });

  useApplyTheme(workspace.data?.workspace.theme ?? lastTheme());

  const doc = useDocument(workspaceId, documentId);

  /*
   * Starter text for a document created from a guide.
   *
   * Written from the client rather than seeded server-side, because the
   * content is a CRDT and the API has no business producing Yjs updates. It
   * is inserted once, and only into a genuinely empty document -- opening the
   * seeded URL a second time, or in a second window, must not duplicate it.
   */
  const seed = useSearchParams().get('seed');
  const seeded = useRef(false);

  useEffect(() => {
    if (!seed || seeded.current || !doc.connected) return;
    if (doc.text.length > 0) {
      // Someone got here first; leave their content alone.
      seeded.current = true;
      return;
    }

    seeded.current = true;
    doc.edit(0, 0, seed);
  }, [seed, doc.connected, doc.text, doc.edit]);

  if (meta.isError) return <ErrorState message={(meta.error as Error).message} />;

  /**
   * A textarea reports its whole new value, but the CRDT needs the actual
   * change. `diffEdit` recovers it so two people typing in different paragraphs
   * merge instead of overwriting each other.
   */
  function onChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const { from, to, insert } = diffEdit(doc.text, event.target.value);
    if (to === from && !insert) return;

    // Remember where the caret should sit; the value comes back from the CRDT,
    // which would otherwise push it to the end on every keystroke.
    const caret = event.target.selectionStart;
    doc.edit(from, to, insert);

    queueMicrotask(() => {
      const element = textareaRef.current;
      if (element) element.setSelectionRange(caret, caret);
    });
  }

  const others = doc.collaborators.filter((user) => user.cursor !== null);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <nav className="text-sm text-faint">
        <Link href="/workspaces" className="hover:text-muted">
          Workspaces
        </Link>
        <span className="mx-2">/</span>
        <Link href={`/workspaces/${workspaceId}`} className="hover:text-muted">
          {workspace.data?.workspace.name ?? '…'}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-muted">{meta.data?.document.title ?? 'Document'}</span>
      </nav>

      <header className="mt-4 flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight text-content">
          {meta.data?.document.title ?? '…'}
        </h1>

        <span className="flex items-center gap-1.5 text-xs text-faint">
          <span
            aria-hidden
            className={[
              'h-1.5 w-1.5 rounded-full',
              doc.connected ? 'bg-emerald-400' : 'bg-amber-400',
            ].join(' ')}
          />
          {doc.connected
            ? others.length > 0
              ? `${others.length} other${others.length === 1 ? '' : 's'} editing`
              : 'Connected'
            : 'Connecting…'}
        </span>
      </header>

      {others.length > 0 && (
        <p className="mt-2 text-xs text-faint">
          {others.map((user) => user.name).join(', ')} — editing now
        </p>
      )}

      <textarea
        ref={textareaRef}
        value={doc.text}
        onChange={onChange}
        onSelect={(event) => doc.reportCursor(event.currentTarget.selectionStart)}
        onBlur={() => doc.reportCursor(null)}
        spellCheck={false}
        placeholder="Start typing. Open this page in another window to see edits merge."
        aria-label="Document content"
        className="mt-6 h-[28rem] w-full resize-none rounded-lg border border-line bg-raised p-4 font-mono text-sm leading-relaxed text-content outline-none focus:border-accent"
      />

      <p className="mt-3 text-xs text-faint">
        Edits merge as a CRDT — concurrent changes to the same paragraph both survive.
      </p>
    </main>
  );
}

/** `useSearchParams` needs a boundary so the route can still be prerendered. */
export default function DocumentPage() {
  return (
    <Suspense
      fallback={<main className="mx-auto max-w-3xl px-6 py-12 text-sm text-faint">Loading…</main>}
    >
      <DocumentView />
    </Suspense>
  );
}
