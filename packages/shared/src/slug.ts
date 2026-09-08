/** URL-safe workspace slug: lowercase, hyphen-separated, no leading/trailing hyphens. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Project key used to build human-readable issue identifiers (`REL-104`).
 * Derived from the project name: initials for multi-word names, otherwise the
 * first letters. Callers must still resolve collisions within a workspace.
 */
export function deriveProjectKey(name: string): string {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);

  if (words.length === 0) return 'PRJ';
  if (words.length === 1) return words[0]!.slice(0, 3).padEnd(3, 'X');

  return words
    .slice(0, 3)
    .map((w) => w[0]!)
    .join('');
}
