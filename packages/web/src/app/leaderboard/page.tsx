'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getLeaderboard } from '@/lib/api';

interface LeaderboardEntry {
  rank: number;
  id: string;
  display_name: string;
  elo: number;
  games_played: number;
}

export default function LeaderboardPage() {
  const [tab, setTab] = useState<'human' | 'bot'>('human');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getLeaderboard(tab, page)
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [tab, page]);

  return (
    <main className="min-h-screen max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold">Leaderboard</h1>
        <Link href="/" className="text-gray-400 hover:text-white text-sm">
          Back to home
        </Link>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-card rounded-lg p-1 mb-6">
        {(['human', 'bot'] as const).map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              setPage(1);
            }}
            className={`flex-1 py-2 rounded-md text-sm font-semibold transition-colors ${
              tab === t ? 'bg-primary text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            {t === 'human' ? 'Humans' : 'Bots'}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-card rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800 text-sm text-gray-400">
              <th className="text-left px-4 py-3 w-16">Rank</th>
              <th className="text-left px-4 py-3">Name</th>
              <th className="text-right px-4 py-3">Elo</th>
              <th className="text-right px-4 py-3">Games</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                  No players yet
                </td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr
                  key={e.id}
                  className="border-b border-gray-800/50 hover:bg-surface/50 transition-colors"
                >
                  <td className="px-4 py-3 text-gray-400">#{e.rank}</td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/profile/${e.id}`}
                      className="hover:text-primary transition-colors"
                    >
                      {e.display_name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{e.elo}</td>
                  <td className="px-4 py-3 text-right text-gray-400">{e.games_played}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex justify-center gap-4 mt-6">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page === 1}
          className="text-sm text-gray-400 hover:text-white disabled:opacity-30"
        >
          Previous
        </button>
        <span className="text-sm text-gray-500">Page {page}</span>
        <button
          onClick={() => setPage((p) => p + 1)}
          disabled={entries.length < 20}
          className="text-sm text-gray-400 hover:text-white disabled:opacity-30"
        >
          Next
        </button>
      </div>
    </main>
  );
}
