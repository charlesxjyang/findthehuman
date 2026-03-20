import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Find the Human',
  description: 'Can you fool 5 AIs? A social deduction game where you blend in with bots.',
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
