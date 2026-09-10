/**
 * Keyset pagination helpers.
 *
 * `OFFSET n` asks the database to count past n rows every time, which is both
 * slower as pages deepen and *wrong* under concurrent writes: a row inserted
 * before the current page shifts everything down, so the reader skips one row
 * and sees another twice. A cursor naming the last row seen has neither
 * problem -- the page boundary is a value, not a position.
 *
 * The cursor carries only the row id, never its timestamp. Postgres stores
 * `timestamptz` with microsecond precision and a JavaScript `Date` has
 * milliseconds, so round-tripping the sort key through JSON silently truncates
 * it -- the cursor lands fractionally before the row it names and the query
 * steps over everything in the gap. That is invisible until several rows share
 * a millisecond, which is exactly what a burst of concurrent inserts produces.
 *
 * Resolving the sort key from the id inside the query avoids the conversion
 * entirely, at the cost of one primary-key lookup per page.
 */
import { isUuid } from '@relay/shared';

/** Opaque to callers: encoded to signal it should be echoed, not constructed. */
export function encodeCursor(id: string): string {
  return Buffer.from(id).toString('base64url');
}

/** Returns null for anything malformed: a bad cursor means the first page. */
export function decodeCursor(encoded: string | undefined): string | null {
  if (!encoded) return null;

  try {
    const id = Buffer.from(encoded, 'base64url').toString('utf8');
    return isUuid(id) ? id : null;
  } catch {
    return null;
  }
}
