/**
 * Narrow a full-value change into the minimal edit that produced it.
 *
 * A controlled textarea only reports its new value, but a CRDT needs to know
 * *what changed*. Replacing the whole text would encode every keystroke as
 * "delete everything, insert everything", and a concurrent edit from someone
 * else would be wiped rather than merged.
 *
 * Trimming the common prefix and suffix recovers a single replaced range. That
 * is not a true minimal diff -- two edits in different places collapse into one
 * range spanning both -- but a keystroke only ever changes one spot, which is
 * the case that matters.
 */
export type TextEdit = {
  /** Start of the replaced range. */
  from: number;
  /** End of the replaced range, exclusive. */
  to: number;
  /** Text inserted at `from`. */
  insert: string;
};

export function diffEdit(before: string, after: string): TextEdit {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix++;
  }

  // Bounded by the unmatched remainder on both sides, so the prefix and suffix
  // can never overlap when one string contains the other.
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}

/** Apply an edit, for verifying that a diff round-trips. */
export function applyEdit(text: string, edit: TextEdit): string {
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}
