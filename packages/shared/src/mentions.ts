/**
 * `@mention` extraction.
 *
 * Handles are matched loosely and resolved against workspace members later, so
 * this only has to decide *what looks like a mention*. Two cases make that less
 * trivial than a single regex:
 *
 * - An email address in prose contains an `@`. "write to ada@relay.dev" must
 *   not mention `relay`. So the character before the `@` may not be one that
 *   could end a handle or an address.
 * - Trailing punctuation belongs to the sentence, not the handle: "thanks
 *   @ada!" mentions `ada`.
 */

/**
 * `(^|[^\w@.-])` — the `@` must start a word, and must not follow the tail of
 * an email address. `[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?` — a handle starts and
 * ends alphanumeric, so trailing punctuation is left behind.
 */
const MENTION = /(^|[^\w@.-])@([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)/gi;

/** A run of text, tagged with the handle it mentions if it is one. */
export type MentionSegment = {
  text: string;
  /** Lowercased handle, or null for ordinary text. */
  handle: string | null;
};

/**
 * Split `text` into alternating plain and mention runs.
 *
 * This exists so the client can highlight mentions without owning a second
 * copy of the grammar. Highlighting and notifying disagreeing is a subtle bug
 * -- a handle styled as a mention that silently notifies nobody -- and a
 * comment saying "keep these in sync" is not a mechanism. Deriving both from
 * one traversal makes the two agree by construction.
 *
 * Concatenating every `text` returns the input unchanged.
 */
export function splitMentions(text: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(MENTION)) {
    const handle = match[2];
    if (handle === undefined || match.index === undefined) continue;

    // The match starts at the boundary character, not the `@`.
    const start = match.index + (match[1] ?? '').length;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), handle: null });

    segments.push({ text: `@${handle}`, handle: handle.toLowerCase() });
    cursor = start + handle.length + 1;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), handle: null });

  return segments;
}

/** Handles referenced in `text`, lowercased, in first-seen order, deduplicated. */
export function parseMentions(text: string): string[] {
  const seen = new Set<string>();

  for (const segment of splitMentions(text)) {
    if (segment.handle) seen.add(segment.handle);
  }

  return [...seen];
}

/**
 * The handle a user answers to: the local part of their email.
 *
 * Names are not usable as handles -- they collide, contain spaces, and change.
 * The email local part is unique per user in practice and stable.
 */
export function handleFor(email: string): string {
  return email.split('@')[0]!.toLowerCase();
}

/**
 * Resolve handles against a member list.
 *
 * Ambiguity is dropped rather than guessed: if two members share a handle,
 * silently notifying the wrong person is worse than notifying nobody. Unknown
 * handles are dropped too -- `@here` and typos are not errors worth failing a
 * comment over.
 */
export function resolveMentions<T extends { id: string; email: string }>(
  text: string,
  members: readonly T[],
): T[] {
  const byHandle = new Map<string, T | null>();

  for (const member of members) {
    const handle = handleFor(member.email);
    // Second occurrence marks the handle ambiguous.
    byHandle.set(handle, byHandle.has(handle) ? null : member);
  }

  const resolved: T[] = [];

  for (const handle of parseMentions(text)) {
    const member = byHandle.get(handle);
    if (member) resolved.push(member);
  }

  return resolved;
}
