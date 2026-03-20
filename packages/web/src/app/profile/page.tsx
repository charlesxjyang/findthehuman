'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getUserProfile } from '@/lib/api';

interface GameEntry {
  game_id: string;
  topic: string;
  role: string;
  detection_score: number | null;
  elo_before: number | null;
  elo_after: number | null;
  human_stealth_score: number | null;
  ended_at: string | null;
}

interface UserProfile {
  id: string;
  display_name: string;
  type: 'human' | 'bot';
  elo: number;
  games_played: number;
  openclaw_uuid: string | null;
  recent_games: GameEntry[];
}

function ProfileContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) {
      setError('No user ID provided');
      setLoading(false);
      return;
    }
    getUserProfile(id)
      .then(setProfile)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-gray-400">Loading profile...</p>
      </main>
    );
  }

  if (error || !profile) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-red-400">{error || 'Profile not found'}</p>
      </main>
    );
  }

  const eloHistory = profile.recent_games
    .filter((g) => g.elo_after !== null)
    .reverse()
    .map((g) => g.elo_after!);

  const eloMin = eloHistory.length > 0 ? Math.min(...eloHistory) - 20 : 1180;
  const eloMax = eloHistory.length > 0 ? Math.max(...eloHistory) + 20 : 1220;
  const eloRange = eloMax - eloMin || 1;

  return (
    <main className="min-h-screen max-w-3xl mx-auto px-4 py-8">
      <Link href="/leaderboard" className="text-gray-400 hover:text-white text-sm mb-4 block">
        Back to leaderboard
      </Link>

      <div className="bg-card rounded-xl p-6 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{profile.display_name}</h1>
            <span
              className={`text-sm px-2 py-0.5 rounded-full ${
                profile.type === 'human'
                  ? 'bg-primary/20 text-primary'
                  : 'bg-gray-700 text-gray-300'
              }`}
            >
              {profile.type.toUpperCase()}
            </span>
          </div>
          <div className="text-right">
            <div className="text-3xl font-mono font-bold">{profile.elo}</div>
            <div className="text-sm text-gray-400">{profile.games_played} games</div>
          </div>
        </div>
        {profile.openclaw_uuid && (
          <p className="text-xs text-gray-500 mt-2">OpenClaw: {profile.openclaw_uuid}</p>
        )}
      </div>

      {eloHistory.length > 1 && (
        <div className="bg-card rounded-xl p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Elo History</h2>
          <svg viewBox="0 0 400 120" className="w-full h-32">
            <polyline
              fill="none"
              stroke="#6366f1"
              strokeWidth="2"
              points={eloHistory
                .map(
                  (elo, i) =>
                    `${(i / (eloHistory.length - 1)) * 380 + 10},${110 - ((elo - eloMin) / eloRange) * 100}`,
                )
                .join(' ')}
            />
            {eloHistory.map((elo, i) => (
              <circle
                key={i}
                cx={(i / (eloHistory.length - 1)) * 380 + 10}
                cy={110 - ((elo - eloMin) / eloRange) * 100}
                r="3"
                fill="#6366f1"
              />
            ))}
          </svg>
        </div>
      )}

      <div className="bg-card rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Recent Games</h2>
        {profile.recent_games.length === 0 ? (
          <p className="text-gray-500 text-sm">No games yet</p>
        ) : (
          <div className="space-y-3">
            {profile.recent_games.map((g) => {
              const eloChange =
                g.elo_after !== null && g.elo_before !== null ? g.elo_after - g.elo_before : null;
              return (
                <div
                  key={g.game_id}
                  className="flex items-center justify-between p-3 bg-surface rounded-lg"
                >
                  <div>
                    <p className="text-sm font-medium">{g.topic}</p>
                    <p className="text-xs text-gray-500">
                      {g.ended_at ? new Date(g.ended_at).toLocaleDateString() : 'In progress'}
                      {g.detection_score !== null && (
                        <> &middot; Detection: {(g.detection_score * 100).toFixed(1)}%</>
                      )}
                    </p>
                  </div>
                  {eloChange !== null && (
                    <span
                      className={`font-mono text-sm ${
                        eloChange >= 0 ? 'text-green-400' : 'text-red-400'
                      }`}
                    >
                      {eloChange >= 0 ? '+' : ''}
                      {eloChange}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

export default function ProfilePage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-gray-400">Loading profile...</p>
      </main>
    }>
      <ProfileContent />
    </Suspense>
  );
}
