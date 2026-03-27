import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Find the Human',
  description: 'Can you fool 4 AIs? A social deduction game where you blend in with bots.',
  openGraph: {
    title: 'Find the Human',
    description: 'One human. Four AI agents. Can you blend in?',
    images: [{ url: '/og.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Find the Human',
    description: 'One human. Four AI agents. Can you blend in?',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-surface text-white min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
