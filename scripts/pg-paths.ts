/**
 * Locate the Postgres binaries shipped by `@embedded-postgres/<platform>`.
 *
 * Resolution has to cope with two node_modules layouts: the classic hoisted
 * tree, and Bun's isolated linker, which keeps real packages in
 * `node_modules/.bun/<name>@<version>/node_modules/`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

function candidateRoots(): string[] {
  const roots = [join(ROOT, 'node_modules')];
  const store = join(ROOT, 'node_modules', '.bun');

  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      if (entry.startsWith('@embedded-postgres+')) {
        roots.push(join(store, entry, 'node_modules'));
      }
    }
  }

  return roots;
}

/** Absolute path to the platform package's `native` directory, or null. */
export function nativeDir(): string | null {
  for (const root of candidateRoots()) {
    for (const platform of PLATFORMS) {
      const dir = join(root, '@embedded-postgres', platform, 'native');
      if (existsSync(dir)) return dir;
    }
  }
  return null;
}

export function nativeLibDirs(): string[] {
  const dirs: string[] = [];

  for (const root of candidateRoots()) {
    for (const platform of PLATFORMS) {
      const dir = join(root, '@embedded-postgres', platform, 'native', 'lib');
      if (existsSync(dir)) dirs.push(dir);
    }
  }

  return dirs;
}

/** Absolute path to a Postgres executable such as `pg_ctl`, or null. */
export function pgBin(name: string): string | null {
  const native = nativeDir();
  if (!native) return null;

  const bin = join(native, 'bin', name);
  return existsSync(bin) ? bin : null;
}
