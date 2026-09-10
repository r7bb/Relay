'use client';

import { DEFAULT_THEME, resolveTheme, type ThemeId, themeVariables } from '@relay/shared';
import { useEffect } from 'react';

/**
 * Apply a workspace's theme to the document.
 *
 * Variables go on `documentElement` rather than a wrapper, because the page
 * background is painted by `body` and a scoped wrapper would leave the area
 * outside it unthemed. `globals.css` ships the default inline, so the first
 * paint is already correct and switching only ever overwrites.
 */
export function useApplyTheme(themeId: ThemeId | string | null | undefined) {
  useEffect(() => {
    const theme = resolveTheme(themeId);
    const root = document.documentElement;

    for (const [property, value] of Object.entries(themeVariables(theme))) {
      root.style.setProperty(property, value);
    }

    // Drives native controls and scrollbars; without it a light theme keeps
    // dark dropdowns.
    root.style.colorScheme = theme.colorScheme;
    root.dataset.theme = theme.id;
  }, [themeId]);
}

/**
 * Remember the last theme seen, so navigating between workspaces does not
 * flash the default while the new one loads.
 */
const STORAGE_KEY = 'relay:last-theme';

export function rememberTheme(themeId: string | null | undefined) {
  if (typeof window === 'undefined' || !themeId) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, themeId);
  } catch {
    // Private mode and disabled storage are not worth failing a render over.
  }
}

export function lastTheme(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    return resolveTheme(window.localStorage.getItem(STORAGE_KEY)).id;
  } catch {
    return DEFAULT_THEME;
  }
}
