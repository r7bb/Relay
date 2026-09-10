import type { Config } from 'tailwindcss';

/**
 * Colours resolve through CSS variables so a workspace theme can swap them at
 * runtime. The `rgb(var(--x) / <alpha-value>)` form is what keeps opacity
 * modifiers like `bg-raised/50` working against a variable.
 *
 * Status colours (red, amber, emerald) are deliberately left as Tailwind's
 * defaults: they carry meaning, and a red that shifts per workspace is a red
 * nobody learns to read.
 */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: token('surface'),
        raised: token('raised'),
        line: token('border'),
        content: token('content'),
        muted: token('muted'),
        faint: token('faint'),
        accent: {
          DEFAULT: token('accent'),
          hover: token('accent-hover'),
          soft: token('accent-soft'),
          contrast: token('accent-contrast'),
        },
        /**
         * Destructive actions and errors. Literal values rather than
         * variables, for the reason above: this red means the same thing in
         * every theme, so it must not move with one.
         */
        danger: {
          DEFAULT: '#ef4444',
          hover: '#dc2626',
          /** Red text on a themed surface, where the solid fill is too heavy. */
          soft: '#f87171',
          contrast: '#ffffff',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
