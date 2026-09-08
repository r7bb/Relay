/**
 * Repair `@embedded-postgres/darwin-*` shared-library symlinks after install.
 *
 * The Postgres binaries link against soname-style paths (`libicudata.77.dylib`)
 * but the npm tarball only contains the fully-versioned files
 * (`libicudata.77.1.dylib`) -- the intermediate symlinks are lost in packing.
 * Without them `initdb` aborts with a dyld "Library not loaded" error.
 *
 * Runs from `postinstall` so a fresh clone works with a plain `bun install`.
 * No-op on platforms where the package isn't present.
 */
import { readdir, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeLibDirs } from './pg-paths.ts';

/**
 * `libicudata.77.1.dylib` is referenced by two different names depending on the
 * consumer: `libicudata.77.dylib` (from the other ICU libraries) and the bare
 * `libicudata.dylib` (from the Postgres binaries). Both aliases are needed.
 */
const VERSIONED = /^(lib.+?)\.(\d+)(?:\.\d+)*\.dylib$/;

let created = 0;

for (const dir of nativeLibDirs()) {
  for (const file of await readdir(dir)) {
    const match = VERSIONED.exec(file);
    if (!match) continue;

    const [, stem, major] = match;

    for (const alias of [`${stem}.${major}.dylib`, `${stem}.dylib`]) {
      if (alias === file) continue;

      const aliasPath = join(dir, alias);
      // Replace rather than skip: a broken link from a previous version would
      // otherwise survive and keep failing.
      await unlink(aliasPath).catch(() => {});
      await symlink(file, aliasPath);
      created++;
    }
  }
}

console.log(
  created > 0
    ? `fix-pg-dylibs: linked ${created} shared libraries`
    : 'fix-pg-dylibs: nothing to do',
);
