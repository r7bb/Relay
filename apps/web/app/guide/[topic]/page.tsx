'use client';

import {
  isNudgeKind,
  NUDGE_GUIDES,
  SAMPLE_DOCUMENT_BODY,
  SAMPLE_DOCUMENT_TITLE,
} from '@relay/shared';
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ErrorState } from '../../../components/ui.tsx';
import { api, type DocumentSummary } from '../../../lib/api.ts';
import { lastTheme, useApplyTheme } from '../../../lib/theme.ts';

/**
 * A short how-to, opened from a nudge.
 *
 * A prompt that only says "you should try documents" puts the work back on the
 * reader. This explains the thing in four lines and ends in a button that
 * actually does it, so the nudge is a shortcut rather than a chore.
 */
function Guide() {
  const { topic } = useParams<{ topic: string }>();
  const params = useSearchParams();
  const router = useRouter();

  const workspaceId = params.get('w');

  // Guides are rendered outside any workspace, so there is no theme to load;
  // reuse whichever one the reader last saw.
  useApplyTheme(lastTheme());

  const createSample = useMutation({
    mutationFn: async () => {
      if (!workspaceId) throw new Error('No workspace to create a document in');

      const { document } = await api<{ document: DocumentSummary }>(
        `/workspaces/${workspaceId}/documents`,
        { method: 'POST', body: { title: SAMPLE_DOCUMENT_TITLE } },
      );

      return document;
    },
    onSuccess: (document) => {
      // The starter text is typed into the CRDT by the editor once it connects;
      // seeding it server-side would mean the API writing Yjs updates, which is
      // the gateway's job.
      router.push(
        `/workspaces/${workspaceId}/documents/${document.id}?seed=${encodeURIComponent(
          SAMPLE_DOCUMENT_BODY,
        )}`,
      );
    },
  });

  if (!isNudgeKind(topic)) {
    return <ErrorState message="That guide does not exist." />;
  }

  const guide = NUDGE_GUIDES[topic];

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <nav className="text-sm text-faint">
        <Link href="/workspaces" className="hover:text-content">
          Workspaces
        </Link>
        <span className="mx-2">/</span>
        <span className="text-muted">Tips</span>
      </nav>

      <h1 className="mt-6 text-3xl font-semibold tracking-tight text-content">{guide.title}</h1>
      <p className="mt-3 text-base leading-relaxed text-muted">{guide.summary}</p>

      <ol className="mt-8 space-y-4">
        {guide.steps.map((step, index) => (
          <li key={step} className="flex gap-4">
            <span
              aria-hidden
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-contrast"
            >
              {index + 1}
            </span>
            <span className="pt-1 text-sm leading-relaxed text-muted">{step}</span>
          </li>
        ))}
      </ol>

      {guide.note && (
        <p className="mt-8 rounded-lg border border-line bg-raised p-4 text-sm leading-relaxed text-faint">
          {guide.note}
        </p>
      )}

      <div className="mt-10 flex items-center gap-3">
        <GuideAction
          guide={guide}
          workspaceId={workspaceId}
          onSample={() => createSample.mutate()}
          pending={createSample.isPending}
        />

        <Link href="/workspaces" className="text-sm text-faint hover:text-content">
          Not now
        </Link>
      </div>

      {createSample.isError && (
        <p role="alert" className="mt-3 text-sm text-danger-soft">
          {(createSample.error as Error).message}
        </p>
      )}
    </main>
  );
}

function GuideAction({
  guide,
  workspaceId,
  onSample,
  pending,
}: {
  guide: (typeof NUDGE_GUIDES)[keyof typeof NUDGE_GUIDES];
  workspaceId: string | null;
  onSample: () => void;
  pending: boolean;
}) {
  const className =
    'rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-contrast transition hover:bg-accent-hover disabled:opacity-50';

  if (guide.action.kind === 'sample-document') {
    // Falls back to a plain link when we do not know which workspace to put
    // the document in -- better than a button that cannot work.
    if (!workspaceId) {
      return (
        <Link href="/workspaces" className={className}>
          Go to workspaces
        </Link>
      );
    }

    return (
      <button type="button" onClick={onSample} disabled={pending} className={className}>
        {pending ? 'Creating…' : guide.action.label}
      </button>
    );
  }

  const href =
    guide.action.kind === 'workspace' && workspaceId ? `/workspaces/${workspaceId}` : '/workspaces';

  return (
    <Link href={href} className={className}>
      {guide.action.label}
    </Link>
  );
}

/**
 * `useSearchParams` opts a route into client-side rendering, and Next requires
 * a boundary so the rest of the page can still be prerendered.
 */
export default function GuidePage() {
  return (
    <Suspense
      fallback={<main className="mx-auto max-w-2xl px-6 py-16 text-sm text-faint">Loading…</main>}
    >
      <Guide />
    </Suspense>
  );
}
