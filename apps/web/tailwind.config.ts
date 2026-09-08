import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#0e1014',
          raised: '#16191f',
          border: '#252a33',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
