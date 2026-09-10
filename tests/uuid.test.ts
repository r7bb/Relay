import { describe, expect, test } from 'bun:test';
import { isUuid } from '@relay/shared';

/**
 * The id guard every route runs before touching the database.
 *
 * It used to be eight copies of one regex. Now that it is one function, the
 * cases it must not regress on are worth stating: Postgres raises a cast error
 * on a malformed uuid, so anything this lets through becomes a 500 instead of
 * a 404.
 */

describe('isUuid', () => {
  test('accepts a generated uuid', () => {
    for (let i = 0; i < 20; i++) {
      expect(isUuid(crypto.randomUUID())).toBe(true);
    }
  });

  test('accepts either case', () => {
    const lower = '11111111-2222-4333-8444-555555555555';
    expect(isUuid(lower)).toBe(true);
    expect(isUuid(lower.toUpperCase())).toBe(true);
  });

  test('rejects the shapes that would reach Postgres as a cast error', () => {
    for (const value of [
      '',
      'not-a-uuid',
      '11111111222243338444555555555555', // unhyphenated
      '11111111-2222-4333-8444-55555555555', // one short
      '11111111-2222-4333-8444-5555555555555', // one long
      '11111111-2222-4333-8444-55555555555g', // not hex
      ' 11111111-2222-4333-8444-555555555555',
      '11111111-2222-4333-8444-555555555555 ',
    ]) {
      expect(isUuid(value)).toBe(false);
    }
  });

  /**
   * An anchored pattern is the whole point: a SQL fragment smuggled after a
   * valid uuid must not pass. This would be the bug if the anchors were ever
   * dropped.
   */
  test('rejects a valid uuid with anything appended', () => {
    expect(isUuid("11111111-2222-4333-8444-555555555555'; drop table issues;--")).toBe(false);
    expect(
      isUuid('11111111-2222-4333-8444-555555555555\n22222222-2222-4333-8444-555555555555'),
    ).toBe(false);
  });

  /** No `g` flag, so repeated calls cannot alternate via `lastIndex`. */
  test('is stateless across calls', () => {
    const id = crypto.randomUUID();
    expect(isUuid(id)).toBe(true);
    expect(isUuid(id)).toBe(true);
    expect(isUuid(id)).toBe(true);
  });
});
