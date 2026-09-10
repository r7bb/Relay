/**
 * Workspace themes.
 *
 * Colours are stored as space-separated RGB channels rather than hex, because
 * Tailwind composes them as `rgb(var(--token) / <alpha-value>)` -- which is
 * what lets `bg-raised/50` keep working once the value comes from a variable.
 *
 * Only surface and accent colours are themed. Status colours (error, warning,
 * success) stay fixed across every theme: they carry meaning, and a red that
 * shifts per workspace is a red nobody learns to read.
 */

export const THEME_IDS = ['midnight', 'graphite', 'forest', 'ember', 'orchid', 'daylight'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = 'midnight';

export type ThemeTokens = {
  /** Page background. */
  surface: string;
  /** Cards, inputs, anything lifted off the page. */
  raised: string;
  border: string;
  /** Primary text. */
  content: string;
  /** Secondary text: labels, metadata. */
  muted: string;
  /** Tertiary text: hints, counts. */
  faint: string;
  accent: string;
  accentHover: string;
  /** Accent tinted for text on a dark-or-light surface. */
  accentSoft: string;
  /** Text placed on top of `accent`. */
  accentContrast: string;
};

export type Theme = {
  id: ThemeId;
  label: string;
  /** Drives form controls and scrollbars; must match the surface. */
  colorScheme: 'dark' | 'light';
  /** Shown in the picker so a theme is recognisable before it is applied. */
  swatch: string;
  tokens: ThemeTokens;
};

export const THEMES: Record<ThemeId, Theme> = {
  midnight: {
    id: 'midnight',
    label: 'Midnight',
    colorScheme: 'dark',
    swatch: '#6366f1',
    tokens: {
      surface: '14 16 20',
      raised: '22 25 31',
      border: '37 42 51',
      content: '226 232 240',
      muted: '148 163 184',
      faint: '100 116 139',
      accent: '99 102 241',
      accentHover: '129 140 248',
      accentSoft: '165 180 252',
      accentContrast: '255 255 255',
    },
  },

  graphite: {
    id: 'graphite',
    label: 'Graphite',
    colorScheme: 'dark',
    swatch: '#14b8a6',
    tokens: {
      surface: '17 19 21',
      raised: '26 29 33',
      border: '44 48 54',
      content: '228 231 235',
      muted: '156 163 172',
      faint: '110 117 126',
      accent: '20 184 166',
      accentHover: '45 212 191',
      accentSoft: '94 234 212',
      accentContrast: '4 22 20',
    },
  },

  forest: {
    id: 'forest',
    label: 'Forest',
    colorScheme: 'dark',
    swatch: '#22c55e',
    tokens: {
      surface: '11 20 16',
      raised: '17 30 24',
      border: '30 51 41',
      content: '220 236 227',
      muted: '143 176 158',
      faint: '100 133 116',
      accent: '34 197 94',
      accentHover: '74 222 128',
      accentSoft: '134 239 172',
      accentContrast: '4 20 11',
    },
  },

  ember: {
    id: 'ember',
    label: 'Ember',
    colorScheme: 'dark',
    swatch: '#f97316',
    tokens: {
      surface: '23 17 13',
      raised: '33 25 19',
      border: '56 42 31',
      content: '240 231 222',
      muted: '186 163 143',
      faint: '140 118 100',
      accent: '249 115 22',
      accentHover: '251 146 60',
      accentSoft: '253 186 116',
      accentContrast: '25 12 3',
    },
  },

  orchid: {
    id: 'orchid',
    label: 'Orchid',
    colorScheme: 'dark',
    swatch: '#d946ef',
    tokens: {
      surface: '19 14 25',
      raised: '28 21 37',
      border: '48 36 62',
      content: '234 226 243',
      muted: '176 160 194',
      faint: '132 116 152',
      accent: '217 70 239',
      accentHover: '232 121 249',
      accentSoft: '240 171 252',
      accentContrast: '26 6 30',
    },
  },

  daylight: {
    id: 'daylight',
    label: 'Daylight',
    colorScheme: 'light',
    swatch: '#4f46e5',
    tokens: {
      surface: '248 250 252',
      raised: '255 255 255',
      border: '226 232 240',
      content: '15 23 42',
      muted: '71 85 105',
      faint: '100 116 139',
      accent: '79 70 229',
      // Light surfaces need the hover to go *darker*, not lighter; each theme
      // supplies its own so the direction is a property of the palette.
      accentHover: '67 56 202',
      accentSoft: '67 56 202',
      accentContrast: '255 255 255',
    },
  },
};

export const THEME_LIST: Theme[] = THEME_IDS.map((id) => THEMES[id]);

/** Unknown or missing ids fall back rather than rendering an unstyled page. */
export function resolveTheme(id: string | null | undefined): Theme {
  return THEMES[(id ?? '') as ThemeId] ?? THEMES[DEFAULT_THEME];
}

/** CSS custom properties for a theme, keyed as they appear in stylesheets. */
export function themeVariables(theme: Theme): Record<string, string> {
  return {
    '--surface': theme.tokens.surface,
    '--raised': theme.tokens.raised,
    '--border': theme.tokens.border,
    '--content': theme.tokens.content,
    '--muted': theme.tokens.muted,
    '--faint': theme.tokens.faint,
    '--accent': theme.tokens.accent,
    '--accent-hover': theme.tokens.accentHover,
    '--accent-soft': theme.tokens.accentSoft,
    '--accent-contrast': theme.tokens.accentContrast,
  };
}
