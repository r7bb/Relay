'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker that caches the app shell.
 *
 * Disabled in development by default: Next's dev server serves chunks that
 * change on every edit, and a cache-first worker in front of them produces
 * stale-module errors that look like application bugs. Set
 * `NEXT_PUBLIC_ENABLE_SW=1` to exercise it locally.
 */
const ENABLED = process.env.NODE_ENV === 'production' || process.env.NEXT_PUBLIC_ENABLE_SW === '1';

export function ServiceWorker() {
  useEffect(() => {
    if (!ENABLED || !('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('/sw.js').catch((error) => {
      // Registration failing degrades the app to online-only, which is worth a
      // warning but not worth breaking the page over.
      console.warn('service worker registration failed', error);
    });
  }, []);

  return null;
}
