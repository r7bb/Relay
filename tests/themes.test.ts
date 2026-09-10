import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_THEME, resolveTheme, THEME_IDS, THEMES, themeVariables } from '@relay/shared';
import {
  addMember,
  closeHarness,
  createActor,
  createWorkspace,
  request,
  resetDatabase,
} from './harness.ts';

beforeEach(resetDatabase);
afterAll(closeHarness);

describe('theme definitions', () => {
  test('every theme defines every token', () => {
    const expected = Object.keys(THEMES[DEFAULT_THEME].tokens).sort();

    for (const id of THEME_IDS) {
      expect(Object.keys(THEMES[id].tokens).sort()).toEqual(expected);
    }
  });

  /** Tailwind composes these as `rgb(var(--x) / <alpha>)`, so anything that is
   * not three plain channels silently produces an invalid colour. */
  test('tokens are space-separated RGB channels', () => {
    for (const id of THEME_IDS) {
      for (const [name, value] of Object.entries(THEMES[id].tokens)) {
        const channels = value.split(' ');

        expect(channels, `${id}.${name}`).toHaveLength(3);
        for (const channel of channels) {
          const n = Number(channel);
          expect(Number.isInteger(n), `${id}.${name}`).toBe(true);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  /**
   * Body text against the page background. Below roughly 4.5:1 the theme is
   * unreadable, which is a bug however nice the palette looks.
   */
  test('content has adequate contrast against the surface in every theme', () => {
    for (const id of THEME_IDS) {
      const { surface, content, muted } = THEMES[id].tokens;

      expect(contrastRatio(content, surface), `${id} content`).toBeGreaterThanOrEqual(4.5);
      // Secondary text is allowed to be dimmer, but still has to be legible.
      expect(contrastRatio(muted, surface), `${id} muted`).toBeGreaterThanOrEqual(3);
    }
  });

  test('accent contrast text is readable on the accent', () => {
    for (const id of THEME_IDS) {
      const { accent, accentContrast } = THEMES[id].tokens;
      expect(contrastRatio(accentContrast, accent), `${id} accent`).toBeGreaterThanOrEqual(3);
    }
  });

  test('an unknown or missing id falls back rather than rendering unstyled', () => {
    expect(resolveTheme('nonsense').id).toBe(DEFAULT_THEME);
    expect(resolveTheme(null).id).toBe(DEFAULT_THEME);
    expect(resolveTheme(undefined).id).toBe(DEFAULT_THEME);
    expect(resolveTheme('forest').id).toBe('forest');
  });

  test('variables are emitted as CSS custom properties', () => {
    const vars = themeVariables(THEMES.forest);

    expect(vars['--surface']).toBe(THEMES.forest.tokens.surface);
    expect(vars['--accent-hover']).toBe(THEMES.forest.tokens.accentHover);
    expect(Object.keys(vars).every((key) => key.startsWith('--'))).toBe(true);
  });
});

describe('workspace theme', () => {
  test('a new workspace starts on the default', async () => {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);

    const response = await request(`/workspaces/${workspace.id}`, { actor: owner });
    expect(response.json().workspace.theme).toBe(DEFAULT_THEME);
  });

  test('an owner can change it, and everyone sees the change', async () => {
    const owner = await createActor('Owner');
    const member = await createActor('Member');
    const workspace = await createWorkspace(owner);
    await addMember(owner, workspace.id, member, 'MEMBER');

    const updated = await request(`/workspaces/${workspace.id}`, {
      method: 'PATCH',
      payload: { theme: 'ember' },
      actor: owner,
    });
    expect(updated.statusCode).toBe(200);

    // The theme belongs to the workspace, not the viewer.
    const asMember = await request(`/workspaces/${workspace.id}`, { actor: member });
    expect(asMember.json().workspace.theme).toBe('ember');
  });

  test('changing the theme leaves the name alone', async () => {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner, 'Keep This Name');

    await request(`/workspaces/${workspace.id}`, {
      method: 'PATCH',
      payload: { theme: 'orchid' },
      actor: owner,
    });

    const after = await request(`/workspaces/${workspace.id}`, { actor: owner });
    expect(after.json().workspace.name).toBe('Keep This Name');
    expect(after.json().workspace.theme).toBe('orchid');
  });

  test('an unknown theme id is rejected', async () => {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);

    const response = await request(`/workspaces/${workspace.id}`, {
      method: 'PATCH',
      payload: { theme: 'hot-pink' },
      actor: owner,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_failed');
  });

  /** Presentation is still workspace state, so it needs `workspace:update`. */
  test('a member cannot change the theme', async () => {
    const owner = await createActor('Owner');
    const member = await createActor('Member');
    const workspace = await createWorkspace(owner);
    await addMember(owner, workspace.id, member, 'MEMBER');

    const response = await request(`/workspaces/${workspace.id}`, {
      method: 'PATCH',
      payload: { theme: 'forest' },
      actor: member,
    });

    expect(response.statusCode).toBe(403);
  });

  test('the workspace list carries the theme, so navigation does not flash', async () => {
    const owner = await createActor('Owner');
    const workspace = await createWorkspace(owner);

    await request(`/workspaces/${workspace.id}`, {
      method: 'PATCH',
      payload: { theme: 'graphite' },
      actor: owner,
    });

    const list = await request('/workspaces', { actor: owner });
    expect(list.json().workspaces[0].theme).toBe('graphite');
  });
});

/**
 * A palette only works if nothing bypasses it.
 *
 * This caught a real bug: page headings kept `text-white` after the token
 * migration, which was invisible against the light theme's surface. A grep is
 * a blunt instrument, but it is the only thing that checks the classes the
 * tests never render.
 */
describe('no hardcoded colours outside the palette', () => {
  const SOURCE_DIRS = ['apps/web/app', 'apps/web/components'];

  /** Fixed by design: avatar initials sit on saturated, unthemed backgrounds. */
  const ALLOWED = new Set(['apps/web/components/presence.tsx']);

  function sourceFiles(): string[] {
    const files: string[] = [];

    for (const dir of SOURCE_DIRS) {
      const stack = [dir];
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const path = join(current, entry.name);
          if (entry.isDirectory()) stack.push(path);
          else if (path.endsWith('.tsx') || path.endsWith('.ts')) files.push(path);
        }
      }
    }

    return files;
  }

  test('text and surface colours come from theme tokens', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      if (ALLOWED.has(file)) continue;

      const source = readFileSync(file, 'utf8');
      // Slate and indigo were the pre-token palette; white is the one that
      // actually disappeared on a light background.
      for (const match of source.matchAll(
        /\b(?:text|bg|border|ring|divide)-(?:white|slate-\d{2,3}|indigo-\d{2,3})\b/g,
      )) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/** WCAG relative luminance and contrast ratio, for the readability checks. */
function relativeLuminance(rgb: string): number {
  const [r, g, b] = rgb.split(' ').map((channel) => {
    const value = Number(channel) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}
