'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, type Comment, type Me } from '../lib/api.ts';

/**
 * Comments on an issue.
 *
 * `@handle` in the body is picked up by the worker and turned into a
 * notification for that person, so the composer hints at it. Resolution
 * happens server-side against workspace members -- the client deliberately
 * does not autocomplete, because an unresolvable handle is harmless and
 * pretending otherwise would mean shipping the member list to render a textbox.
 */
export function CommentThread({
  workspaceId,
  issueId,
  canComment,
}: {
  workspaceId: string;
  issueId: string;
  canComment: boolean;
}) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');

  const key = ['comments', workspaceId, issueId] as const;
  const path = `/workspaces/${workspaceId}/issues/${issueId}/comments`;

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), retry: false });

  const comments = useQuery({
    queryKey: key,
    queryFn: () => api<{ comments: Comment[] }>(path),
  });

  const post = useMutation({
    mutationFn: (text: string) =>
      api<{ comment: Comment }>(path, { method: 'POST', body: { body: text } }),
    onSuccess: () => {
      setBody('');
      queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const remove = useMutation({
    mutationFn: (commentId: string) =>
      api<void>(`/workspaces/${workspaceId}/comments/${commentId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const text = body.trim();
    if (text) post.mutate(text);
  }

  const items = comments.data?.comments ?? [];

  return (
    <section className="mt-12">
      <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
        Comments{items.length > 0 && <span className="ml-2 text-slate-600">{items.length}</span>}
      </h2>

      <ul className="mt-3 space-y-3">
        {items.map((comment) => (
          <li
            key={comment.id}
            className="rounded-lg border border-surface-border bg-surface-raised p-4"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-slate-200">{comment.authorName}</span>

              <span className="flex items-center gap-3">
                <time className="text-xs text-slate-500" dateTime={comment.createdAt}>
                  {new Date(comment.createdAt).toLocaleString()}
                </time>

                {/* Own comments only; the API also refuses others unless you
                    are an admin, so this just avoids offering a dead control. */}
                {me.data?.user.id === comment.authorId && (
                  <button
                    type="button"
                    onClick={() => remove.mutate(comment.id)}
                    className="text-xs text-slate-500 hover:text-red-400"
                  >
                    Delete
                  </button>
                )}
              </span>
            </div>

            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">
              <Mentions text={comment.body} />
            </p>
          </li>
        ))}
      </ul>

      {items.length === 0 && comments.isSuccess && (
        <p className="mt-3 text-sm text-slate-500">No comments yet.</p>
      )}

      {canComment && (
        <form onSubmit={onSubmit} className="mt-4">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Leave a comment. Use @name to notify someone."
            rows={3}
            aria-label="New comment"
            className="w-full resize-none rounded-md border border-surface-border bg-surface-raised px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500"
          />

          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-slate-600">
              Mentions notify workspace members by the first part of their email.
            </span>

            <button
              type="submit"
              disabled={post.isPending || !body.trim()}
              className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
            >
              Comment
            </button>
          </div>
        </form>
      )}

      {post.isError && (
        <p role="alert" className="mt-2 text-sm text-red-400">
          {(post.error as Error).message}
        </p>
      )}
    </section>
  );
}

/** Highlight `@handle` so a mention is visible in the rendered comment. */
function Mentions({ text }: { text: string }) {
  // Same shape as the server-side parser: the `@` must start a word and must
  // not follow the tail of an email address.
  const parts = text.split(/((?:^|(?<![\w@.-]))@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)/gi);

  return (
    <>
      {parts.map((part, index) =>
        part.startsWith('@') ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: split output is positional and re-rendered wholesale, so the index is the only identity available.
          <span key={index} className="rounded bg-indigo-500/15 px-1 text-indigo-300">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
