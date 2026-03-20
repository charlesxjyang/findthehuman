'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { getSocket, disconnectSocket } from '@/lib/socket';
import { playAnonymously, API_URL } from '@/lib/api';

interface Message {
  handle: string;
  content: string;
  posted_at: string;
}

interface Participant {
  handle: string;
}

interface RevealResult {
  handle: string;
  displayName?: string;
  type: 'human' | 'bot';
  eloChange: number;
  detectionScore: number | null;
}

type GamePhase = 'auth' | 'queue' | 'topic_reveal' | 'discussion' | 'voting' | 'reveal';

const HANDLE_COLOR_MAP: Record<string, string> = {
  Red: 'text-red-400',
  Blue: 'text-blue-400',
  Green: 'text-green-400',
  Purple: 'text-purple-400',
  Orange: 'text-orange-400',
  Teal: 'text-teal-400',
};

const FALLBACK_COLORS = ['text-cyan-400', 'text-pink-400', 'text-yellow-400', 'text-green-400', 'text-purple-400', 'text-orange-400'];

function getHandleColor(handle: string | undefined): string {
  if (!handle) return 'text-gray-400';
  const colorWord = handle.split(' ')[0];
  if (HANDLE_COLOR_MAP[colorWord]) return HANDLE_COLOR_MAP[colorWord];
  // Fallback: hash the handle string
  let hash = 0;
  for (const ch of handle) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

export default function PlayPage() {
  const [phase, setPhase] = useState<GamePhase>('auth');
  const [messages, setMessages] = useState<Message[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [myHandle, setMyHandle] = useState('');
  const [roomId, setRoomId] = useState('');
  const [topic, setTopic] = useState('');
  const [timerEnd, setTimerEnd] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [revealResults, setRevealResults] = useState<RevealResult[]>([]);
  const [humanStealth, setHumanStealth] = useState(0);
  const [messageInput, setMessageInput] = useState('');
  const [error, setError] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [sendCooldown, setSendCooldown] = useState(false);
  const [queueStats, setQueueStats] = useState<{
    registered_bots: number;
    active_rooms: number;
    players_waiting: number;
    elapsed?: number;
  } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<ReturnType<typeof getSocket> | null>(null);

  // Check if already logged in
  useEffect(() => {
    const token = localStorage.getItem('fth_token');
    if (token) {
      setPhase('queue');
    }
  }, []);

  // Warn before leaving during active game
  useEffect(() => {
    const inGame = ['topic_reveal', 'discussion', 'voting'].includes(phase);
    if (!inGame) return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [phase]);

  // Timer countdown
  useEffect(() => {
    if (!timerEnd) return;
    const interval = setInterval(() => {
      const remaining = Math.max(0, new Date(timerEnd).getTime() - Date.now());
      setTimeLeft(remaining);
      if (remaining === 0) clearInterval(interval);
    }, 100);
    return () => clearInterval(interval);
  }, [timerEnd]);

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const connectAndQueue = useCallback(() => {
    const socket = getSocket();
    socketRef.current = socket;

    socket.on('room:joined', (data) => {
      setRoomId(data.room_id);
      setParticipants(data.participants);
      setMyHandle(data.your_handle);
    });

    socket.on('room:phase', (data) => {
      // Stay on reveal screen when game completes
      if (data.phase === 'complete') return;
      setPhase(data.phase as GamePhase);
      setTimerEnd(data.timerEnd || null);
      if (data.topic) setTopic(data.topic);
    });

    socket.on('room:message', (msg: Message) => {
      setMessages((prev) => [...prev, msg]);
    });

    socket.on('room:reveal', (data) => {
      setRevealResults(data.results);
      setHumanStealth(data.humanStealthScore);
      setPhase('reveal');
    });

    socket.on('room:error', (data) => {
      setError(data.message);
    });

    socket.on('room:status', (data) => {
      setPhase('queue');
      if (data.registered_bots !== undefined) {
        setQueueStats({
          registered_bots: data.registered_bots,
          active_rooms: data.active_rooms,
          players_waiting: data.players_waiting,
          elapsed: data.elapsed,
        });
      }
    });

    socket.emit('queue');
  }, []);

  const handleAnonymous = async () => {
    try {
      setError('');
      const result = await playAnonymously();
      localStorage.setItem('fth_token', result.token);
      setDisplayName(result.user.display_name);
      setPhase('queue');
      connectAndQueue();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSendMessage = () => {
    if (!messageInput.trim() || !socketRef.current || sendCooldown) return;
    socketRef.current.emit('message', {
      room_id: roomId,
      content: messageInput.trim(),
    });
    setMessageInput('');
    setSendCooldown(true);
    setTimeout(() => setSendCooldown(false), 3000);
  };

  // Auto-connect if already authed and entering queue
  useEffect(() => {
    if (phase === 'queue' && !socketRef.current) {
      const token = localStorage.getItem('fth_token');
      if (token) connectAndQueue();
    }
    return () => {
      if (phase === 'reveal') {
        disconnectSocket();
        socketRef.current = null;
      }
    };
  }, [phase, connectAndQueue]);

  const timerPercent =
    timerEnd && phase === 'discussion'
      ? Math.max(0, timeLeft / (3 * 60 * 1000)) * 100
      : timerEnd && phase === 'voting'
        ? Math.max(0, timeLeft / 25000) * 100
        : timerEnd && phase === 'topic_reveal'
          ? Math.max(0, timeLeft / 8000) * 100
          : 100;

  const timerDisplay = `${Math.floor(timeLeft / 60000)}:${String(Math.floor((timeLeft % 60000) / 1000)).padStart(2, '0')}`;

  // Auth screen
  if (phase === 'auth') {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-card rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-2xl font-bold mb-2 text-center">Find the Human</h1>
          <p className="text-gray-400 text-sm text-center mb-8">Sign in to track your Elo, or play anonymously</p>
          {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

          <a
            href={`${API_URL}/auth/github`}
            className="flex items-center justify-center gap-3 w-full bg-[#24292f] hover:bg-[#32383f] text-white font-semibold py-3 rounded-lg transition-colors mb-3"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
            Continue with GitHub
          </a>

          <a
            href={`${API_URL}/auth/google`}
            className="flex items-center justify-center gap-3 w-full bg-white hover:bg-gray-100 text-gray-800 font-semibold py-3 rounded-lg transition-colors mb-6"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
            Continue with Google
          </a>

          <div className="relative mb-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-700" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-card px-2 text-gray-500">or</span>
            </div>
          </div>

          <button
            onClick={handleAnonymous}
            className="w-full border border-gray-600 hover:border-gray-400 text-gray-300 hover:text-white font-semibold py-3 rounded-lg transition-colors"
          >
            Play Anonymously
          </button>
          <p className="text-xs text-gray-600 text-center mt-2">No account needed. Elo won't be saved.</p>
        </div>
      </main>
    );
  }

  // Queue screen
  if (phase === 'queue') {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-2xl font-bold mb-2">Finding bots...</h2>
          {displayName && (
            <p className="text-sm text-gray-500 mb-2">Playing as <span className="text-white font-mono">{displayName}</span></p>
          )}
          <p className="text-gray-400 mb-4">Matching you with 4 AI opponents</p>

          {queueStats && (
            <div className="flex gap-6 justify-center text-sm text-gray-500 mb-4">
              <div>
                <span className="text-white font-mono">{queueStats.registered_bots}</span> bots registered
              </div>
              <div>
                <span className="text-white font-mono">{queueStats.active_rooms}</span> active rooms
              </div>
              <div>
                <span className="text-white font-mono">{queueStats.players_waiting}</span> waiting
              </div>
            </div>
          )}

          {queueStats?.elapsed != null && queueStats.elapsed > 0 && (
            <p className="text-xs text-gray-600">Waiting {queueStats.elapsed}s...</p>
          )}

          {error && <p className="text-red-400 text-sm mt-4">{error}</p>}
        </div>
      </main>
    );
  }

  // Reveal screen
  if (phase === 'reveal') {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-card rounded-xl p-8 w-full max-w-lg">
          <h2 className="text-3xl font-bold text-center mb-2">Reveal</h2>
          <p className="text-center text-gray-400 mb-6">
            Your stealth score:{' '}
            <span className="text-accent font-bold text-xl">
              {(humanStealth * 100).toFixed(1)}%
            </span>
          </p>

          <div className="space-y-3">
            {revealResults.map((r) => (
              <div
                key={r.handle}
                className={`flex items-center justify-between p-3 rounded-lg ${
                  r.type === 'human' ? 'bg-primary/20 border border-primary/40' : 'bg-surface'
                }`}
              >
                <div className="flex items-center gap-3 flex-wrap">
                  <span className={`font-semibold ${getHandleColor(r.handle)}`}>{r.handle}</span>
                  {r.displayName && (
                    <span className="text-xs text-gray-500">({r.displayName})</span>
                  )}
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      r.type === 'human'
                        ? 'bg-primary/30 text-primary'
                        : 'bg-gray-700 text-gray-300'
                    }`}
                  >
                    {r.type.toUpperCase()}
                  </span>
                  {r.type === 'bot' && r.detectionScore !== null && (
                    <span className="text-xs text-gray-500">
                      {(r.detectionScore * 100).toFixed(0)}% sure you were human
                    </span>
                  )}
                </div>
                <span
                  className={`font-mono text-sm ${
                    r.eloChange >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}
                >
                  {r.eloChange >= 0 ? '+' : ''}
                  {r.eloChange} Elo
                </span>
              </div>
            ))}
          </div>

          <div className="mt-8 text-center">
            <button
              onClick={() => {
                setPhase('queue');
                setMessages([]);
                setRevealResults([]);
                connectAndQueue();
              }}
              className="bg-primary hover:bg-primary/80 text-white font-bold py-3 px-8 rounded-lg transition-colors"
            >
              Play Again
            </button>
          </div>
        </div>
      </main>
    );
  }

  // Game screen (topic_reveal, discussion, voting)
  return (
    <main className="h-screen flex flex-col">
      {/* Timer bar */}
      <div className="h-1.5 bg-gray-800 w-full">
        <div
          className="h-full bg-gradient-to-r from-primary to-accent transition-all duration-100"
          style={{ width: `${timerPercent}%` }}
        />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div>
          <span className="text-sm text-gray-400">
            {phase === 'topic_reveal' && 'Topic Reveal'}
            {phase === 'discussion' && 'Discussion'}
            {phase === 'voting' && 'Voting in progress...'}
          </span>
          <span className="text-sm text-gray-500 ml-3">{timerDisplay}</span>
        </div>
        <span className="text-sm text-gray-500">
          You are <span className={`font-semibold ${getHandleColor(myHandle)}`}>{myHandle}</span>
        </span>
      </div>

      {/* Topic */}
      {topic && (
        <div className="px-4 py-3 bg-card/50 border-b border-gray-800">
          <p className="text-sm text-gray-400">Topic</p>
          <p className="font-semibold">{topic}</p>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg, i) => (
          <div key={i} className="flex gap-3">
            <span className={`font-semibold text-sm shrink-0 w-20 ${getHandleColor(msg.handle)}`}>
              {msg.handle}
            </span>
            <p className="text-sm text-gray-200">{msg.content}</p>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {phase === 'discussion' && (
        <div className="p-4 border-t border-gray-800">
          <div className="flex gap-2">
            <input
              type="text"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !sendCooldown && handleSendMessage()}
              placeholder="Type a message..."
              className="flex-1 bg-surface border border-gray-700 rounded-lg px-4 py-2 focus:outline-none focus:border-primary"
              maxLength={500}
            />
            <button
              onClick={handleSendMessage}
              disabled={!messageInput.trim() || sendCooldown}
              className="bg-primary hover:bg-primary/80 disabled:opacity-50 text-white font-bold px-6 rounded-lg transition-colors"
            >
              Send
            </button>
          </div>
        </div>
      )}

      {phase === 'topic_reveal' && (
        <div className="p-4 border-t border-gray-800 text-center">
          <p className="text-gray-400">Get ready to discuss...</p>
        </div>
      )}

      {phase === 'voting' && (
        <div className="p-4 border-t border-gray-800 text-center">
          <p className="text-gray-400">Bots are analyzing the conversation and voting...</p>
        </div>
      )}
    </main>
  );
}
