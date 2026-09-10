import { describe, expect, test } from 'bun:test';
import { handleFor, parseMentions, resolveMentions, splitMentions } from '@relay/shared';

/**
 * Mention parsing decides who gets notified, so its failure modes are
 * asymmetric: missing a mention is an annoyance, inventing one sends someone
 * a notification about a conversation they were never part of.
 */
describe('parseMentions', () => {
  test('finds a simple mention', () => {
    expect(parseMentions('hey @rohit can you look')).toEqual(['rohit']);
  });

  test('finds several, in order, deduplicated', () => {
    expect(parseMentions('@ada and @grace, also @ada again')).toEqual(['ada', 'grace']);
  });

  test('is case-insensitive and normalises to lowercase', () => {
    expect(parseMentions('@Rohit and @ROHIT')).toEqual(['rohit']);
  });

  test('leaves trailing punctuation out of the handle', () => {
    expect(parseMentions('thanks @ada!')).toEqual(['ada']);
    expect(parseMentions('cc @ada, @grace.')).toEqual(['ada', 'grace']);
    expect(parseMentions('(@ada)')).toEqual(['ada']);
  });

  test('a mention at the very start counts', () => {
    expect(parseMentions('@ada ping')).toEqual(['ada']);
  });

  /**
   * The important negative case. An email in prose contains an `@`, and
   * treating its domain as a handle would notify whoever happens to share that
   * name.
   */
  test('an email address in prose is not a mention', () => {
    expect(parseMentions('write to ada@relay.dev about it')).toEqual([]);
    expect(parseMentions('ada@relay.dev')).toEqual([]);
  });

  test('a bare @ is not a mention', () => {
    expect(parseMentions('meet @ 5pm')).toEqual([]);
    expect(parseMentions('@')).toEqual([]);
  });

  test('handles inside words are ignored', () => {
    expect(parseMentions('foo@bar')).toEqual([]);
  });

  test('dots and hyphens inside a handle are kept', () => {
    expect(parseMentions('@ada.lovelace and @jean-luc')).toEqual(['ada.lovelace', 'jean-luc']);
  });

  test('empty and mention-free text yields nothing', () => {
    expect(parseMentions('')).toEqual([]);
    expect(parseMentions('no mentions here at all')).toEqual([]);
  });
});

describe('handleFor', () => {
  test('is the local part of the email, lowercased', () => {
    expect(handleFor('Rohit@Relay.dev')).toBe('rohit');
    expect(handleFor('ada.lovelace@relay.dev')).toBe('ada.lovelace');
  });
});

describe('resolveMentions', () => {
  const members = [
    { id: 'u1', email: 'rohit@relay.dev' },
    { id: 'u2', email: 'ada@relay.dev' },
  ];

  test('resolves handles to members', () => {
    expect(resolveMentions('@rohit and @ada', members).map((m) => m.id)).toEqual(['u1', 'u2']);
  });

  test('unknown handles are dropped, not errors', () => {
    expect(resolveMentions('@nobody @rohit', members).map((m) => m.id)).toEqual(['u1']);
  });

  /**
   * Two members whose emails share a local part across domains. Guessing would
   * notify the wrong person, which is worse than notifying neither.
   */
  test('ambiguous handles are dropped rather than guessed', () => {
    const ambiguous = [
      { id: 'a', email: 'sam@relay.dev' },
      { id: 'b', email: 'sam@example.com' },
    ];

    expect(resolveMentions('@sam look at this', ambiguous)).toEqual([]);
  });

  test('an email in prose does not resolve to a member', () => {
    expect(resolveMentions('reply to ada@relay.dev', members)).toEqual([]);
  });

  test('a member list that is empty resolves nothing', () => {
    expect(resolveMentions('@rohit', [])).toEqual([]);
  });
});

/**
 * The client highlights mentions using this split, and the worker notifies
 * using `parseMentions`. They used to be two regexes kept together by a
 * comment; these tests are what replaces the comment.
 */
describe('splitMentions', () => {
  test('reassembles into the original text', () => {
    for (const text of [
      '',
      'no mentions here',
      '@rohit at the start',
      'at the end @rohit',
      'hey @rohit and @ada, see ada@relay.dev',
      '@@rohit',
      'thanks @ada!',
      'multi\nline @rohit text',
    ]) {
      expect(
        splitMentions(text)
          .map((s) => s.text)
          .join(''),
      ).toBe(text);
    }
  });

  test('tags mention runs and leaves the rest alone', () => {
    expect(splitMentions('hi @ada!')).toEqual([
      { text: 'hi ', handle: null },
      { text: '@ada', handle: 'ada' },
      { text: '!', handle: null },
    ]);
  });

  test('a mention at position zero produces no empty leading run', () => {
    expect(splitMentions('@ada hi')).toEqual([
      { text: '@ada', handle: 'ada' },
      { text: ' hi', handle: null },
    ]);
  });

  test('an email address is not split into a mention', () => {
    expect(splitMentions('write to ada@relay.dev')).toEqual([
      { text: 'write to ada@relay.dev', handle: null },
    ]);
  });

  /**
   * The property that matters: anything highlighted is notified, and anything
   * notified is highlighted. Drift between the two is the bug this prevents.
   */
  test('agrees with parseMentions on every sample', () => {
    for (const text of [
      'hey @rohit and @ada',
      'ada@relay.dev is not @ada... or is it @ada',
      '@a @b @c @a',
      'thanks @ada! and @Rohit.',
      'nothing to see',
      '@ADA shouting',
    ]) {
      const fromSplit = [
        ...new Set(
          splitMentions(text)
            .map((s) => s.handle)
            .filter((h): h is string => h !== null),
        ),
      ];

      expect(fromSplit).toEqual(parseMentions(text));
    }
  });
});
