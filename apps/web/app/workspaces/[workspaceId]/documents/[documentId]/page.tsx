'use client';

import { diffEdit } from '@relay/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef } from 'react';
import { ErrorState } from '../../../../../components/ui.tsx';
import { api, type WorkspaceSummary } from '../../../../../lib/api.ts';
import { useDocument } from '../../../../../lib/use-document.ts';

type DocumentMeta = { id: string; title: string };

export default function DocumentPage() {
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

  const doc = useDocument(workspaceId, documentId);

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
      <nav className="text-sm text-slate-500">
        <Link href="/workspaces" className="hover:text-slate-300">
          Workspaces
        </Link>
        <span className="mx-2">/</span>
        <Link href={`/workspaces/${workspaceId}`} className="hover:text-slate-300">
          {workspace.data?.workspace.name ?? '…'}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-slate-300">{meta.data?.document.title ?? 'Document'}</span>
      </nav>

      <header className="mt-4 flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight text-white">
          {meta.data?.document.title ?? '…'}
        </h1>

        <span className="flex items-center gap-1.5 text-xs text-slate-500">
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
        <p className="mt-2 text-xs text-slate-500">
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
        className="mt-6 h-[28rem] w-full resize-none rounded-lg border border-surface-border bg-surface-raised p-4 font-mono text-sm leading-relaxed text-slate-200 outline-none focus:border-indigo-500"
      />

      <p className="mt-3 text-xs text-slate-600">
        Edits merge as a CRDT — concurrent changes to the same paragraph both survive.
      </p>
    </main>
  );
}
