/**
 * The one uuid check.
 *
 * Every route that takes an id from the path validates it before touching the
 * database, because Postgres raises a cast error on a malformed uuid and a
 * 500 is the wrong answer to "no such issue". That check was written out
 * eight separate times before this existed; the risk is not the duplication
 * itself but the day someone tightens one copy and leaves seven behind.
 *
 * Exposed as a function rather than the pattern so no caller can attach the
 * `g` flag to a shared RegExp and inherit its `lastIndex` between calls.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
