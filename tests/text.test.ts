import { describe, expect, test } from 'bun:test';
import { applyEdit, diffEdit } from '@relay/shared';

/**
 * `diffEdit` turns a textarea's new value back into the edit that produced it.
 *
 * It is the seam between a controlled React input and the CRDT. Get it wrong
 * and every keystroke becomes "replace the whole document", which silently
 * destroys concurrent edits -- the exact failure the CRDT was chosen to avoid.
 */
describe('diffEdit', () => {
  test('typing a character reports only that character', () => {
    expect(diffEdit('helo', 'hello')).toEqual({ from: 3, to: 3, insert: 'l' });
  });

  test('deleting a character reports an empty insert', () => {
    expect(diffEdit('hello', 'helo')).toEqual({ from: 3, to: 4, insert: '' });
  });

  test('appending touches only the end', () => {
    expect(diffEdit('abc', 'abcdef')).toEqual({ from: 3, to: 3, insert: 'def' });
  });

  test('prepending touches only the start', () => {
    expect(diffEdit('abc', 'xyzabc')).toEqual({ from: 0, to: 0, insert: 'xyz' });
  });

  test('replacing a selection reports the replaced range', () => {
    expect(diffEdit('the quick fox', 'the slow fox')).toEqual({
      from: 4,
      to: 9,
      insert: 'slow',
    });
  });

  test('no change reports an empty edit', () => {
    expect(diffEdit('same', 'same')).toEqual({ from: 4, to: 4, insert: '' });
  });

  test('clearing everything reports the whole range', () => {
    expect(diffEdit('wipe me', '')).toEqual({ from: 0, to: 7, insert: '' });
  });

  test('typing into an empty document', () => {
    expect(diffEdit('', 'first')).toEqual({ from: 0, to: 0, insert: 'first' });
  });

  /**
   * Repeated characters are where a naive prefix/suffix scan goes wrong: the
   * prefix and suffix can try to claim the same characters.
   */
  test('repeated characters do not produce an overlapping range', () => {
    const edit = diffEdit('aaa', 'aaaa');
    expect(edit.to).toBeGreaterThanOrEqual(edit.from);
    expect(applyEdit('aaa', edit)).toBe('aaaa');
  });

  test('deleting from a run of repeated characters round-trips', () => {
    const edit = diffEdit('aaaa', 'aaa');
    expect(edit.to).toBeGreaterThanOrEqual(edit.from);
    expect(applyEdit('aaaa', edit)).toBe('aaa');
  });

  /** The property that actually matters: the diff must reconstruct the value. */
  test('every edit round-trips', () => {
    const cases: [string, string][] = [
      ['', ''],
      ['', 'x'],
      ['x', ''],
      ['hello world', 'hello brave world'],
      ['hello world', 'hell world'],
      ['aaa', 'aba'],
      ['abcabc', 'abc'],
      ['line one\nline two', 'line one\nline 2'],
      ['emoji 🙂 here', 'emoji 🙂🙂 here'],
      ['trailing   ', 'trailing'],
      ['The auth service', 'Draft: The auth service uses OAuth'],
    ];

    for (const [before, after] of cases) {
      const edit = diffEdit(before, after);
      expect(applyEdit(before, edit)).toBe(after);
      expect(edit.from).toBeLessThanOrEqual(edit.to);
    }
  });

  test('round-trips on random mutations', () => {
    const alphabet = 'abc \n';
    const random = (max: number) => Math.floor(Math.random() * max);

    for (let iteration = 0; iteration < 500; iteration++) {
      const before = Array.from(
        { length: random(20) },
        () => alphabet[random(alphabet.length)],
      ).join('');

      // A random single-range mutation, which is what an editor produces.
      const from = random(before.length + 1);
      const to = from + random(before.length - from + 1);
      const insert = Array.from(
        { length: random(5) },
        () => alphabet[random(alphabet.length)],
      ).join('');
      const after = before.slice(0, from) + insert + before.slice(to);

      const edit = diffEdit(before, after);
      expect(applyEdit(before, edit)).toBe(after);
    }
  });
});
