import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { ServiceWorker } from '../components/service-worker.tsx';
import { Providers } from './providers.tsx';

export const metadata: Metadata = {
  title: 'Relay',
  description: 'Collaborative workspace for issues, projects and documents.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ServiceWorker />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
