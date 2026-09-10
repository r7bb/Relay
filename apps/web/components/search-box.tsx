'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, type SearchHit } from '../lib/api.ts';

/** Wait this long after typing stops before querying. */
const DEBOUNCE_MS = 200;

const KIND_LABELS: Record<SearchHit['kind'], string> = {
  issue: 'Issue',
  document: 'Document',
  comment: 'Comment',
};

export function SearchBox({ workspaceId }: { workspaceId: string }) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // Debounce so a full-text query does not run on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const results = useQuery({
    queryKey: ['search', workspaceId, query],
    queryFn: () =>
      api<{ results: SearchHit[] }>(
        `/workspaces/${workspaceId}/search?q=${encodeURIComponent(query)}`,
      ),
    enabled: query.length > 0,
    // Results for a given query do not change often, and re-running a
    // full-text search on every focus is wasteful.
    staleTime: 30_000,
  });

  const hits = results.data?.results ?? [];

  return (
    <div ref={containerRef} className="relative">
      <input
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search issues, documents and comments"
        aria-label="Search this workspace"
        className="w-full rounded-md border border-line bg-raised px-3 py-2 text-sm text-content outline-none focus:border-accent"
      />

      {open && query.length > 0 && (
        <div className="absolute z-10 mt-2 w-full overflow-hidden rounded-lg border border-line bg-raised shadow-xl">
          {results.isPending ? (
            <p className="px-4 py-4 text-sm text-faint">Searching…</p>
          ) : hits.length === 0 ? (
            <p className="px-4 py-4 text-sm text-faint">Nothing matches “{query}”.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-line overflow-y-auto">
              {hits.map((hit) => (
                <li key={`${hit.kind}:${hit.id}`}>
                  <Link
                    href={hrefFor(workspaceId, hit)}
                    onClick={() => setOpen(false)}
                    className="block px-4 py-3 hover:bg-surface"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm text-content">{hit.title}</span>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-faint">
                        {KIND_LABELS[hit.kind]}
                      </span>
                    </div>

                    <Snippet html={hit.snippet} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function hrefFor(workspaceId: string, hit: SearchHit): string {
  if (hit.kind === 'document') return `/workspaces/${workspaceId}/documents/${hit.id}`;
  // A comment's own id is not addressable, so it points at its issue.
  if (hit.issueId) return `/workspaces/${workspaceId}/issues/${hit.issueId}`;
  return `/workspaces/${workspaceId}`;
}

/**
 * Render the highlighted excerpt.
 *
 * Postgres returns the snippet with `<mark>` around the matched terms and
 * everything else HTML-escaped. Rather than trust that and use
 * `dangerouslySetInnerHTML`, the string is split on the marks and rebuilt as
 * React nodes -- so even a stored `<script>` renders as text.
 */
function Snippet({ html }: { html: string }) {
  const parts = html.split(/(<mark>.*?<\/mark>)/g);

  return (
    <p className="mt-1 line-clamp-2 text-xs text-faint">
      {parts.map((part, index) => {
        const match = /^<mark>(.*)<\/mark>$/s.exec(part);

        return match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: split output is positional and re-rendered wholesale, so the index is the only identity available.
          <mark key={index} className="rounded bg-accent/20 px-0.5 text-accent-soft">
            {decodeEntities(match[1] ?? '')}
          </mark>
        ) : (
          decodeEntities(part)
        );
      })}
    </p>
  );
}

/** `ts_headline` escapes the surrounding text, so it comes back encoded. */
function decodeEntities(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}
