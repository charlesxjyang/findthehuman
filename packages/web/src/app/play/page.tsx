'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { getSocket, disconnectSocket } from '@/lib/socket';
import { requestCode, verifyCode } from '@/lib/api';

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
  type: 'human' | 'bot';
  eloChange: number;
  detectionScore: number | null;
}

type GamePhase = 'auth' | 'queue' | 'topic_reveal' | 'discussion' | 'voting' | 'reveal';

const HANDLE_COLORS = [
  'text-cyan-400',
  'text-pink-400',
  'text-yellow-400',
  'text-green-400',
  'text-purple-400',
  'text-orange-400',
];

function getHandleColor(handle: string): string {
  const num = parseInt(handle.replace(/\D/g, ''), 10) || 0;
  return HANDLE_COLORS[num % HANDLE_COLORS.length];
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

  // Auth state
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [awaitingCode, setAwaitingCode] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<ReturnType<typeof getSocket> | null>(null);

  // Check if already logged in
  useEffect(() => {
    const token = localStorage.getItem('fth_token');
    if (token) {
      setPhase('queue');
    }
  }, []);

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

    socket.on('room:status', () => {
      setPhase('queue');
    });

    socket.emit('queue');
  }, []);

  // Auth handlers
  const handleRequestCode = async () => {
    try {
      setError('');
      const result = await requestCode(email, displayName);
      setAwaitingCode(true);
      // In dev mode, auto-fill the code
      if (result.code) setAuthCode(result.code);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleVerifyCode = async () => {
    try {
      setError('');
      const result = await verifyCode(email, authCode, displayName);
      localStorage.setItem('fth_token', result.token);
      setPhase('queue');
      connectAndQueue();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSendMessage = () => {
    if (!messageInput.trim() || !socketRef.current) return;
    socketRef.current.emit('message', {
      room_id: roomId,
      content: messageInput.trim(),
    });
    setMessageInput('');
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
      ? Math.max(0, timeLeft / (5 * 60 * 1000)) * 100
      : timerEnd && phase === 'voting'
        ? Math.max(0, timeLeft / 60000) * 100
        : timerEnd && phase === 'topic_reveal'
          ? Math.max(0, timeLeft / 10000) * 100
          : 100;

  const timerDisplay = `${Math.floor(timeLeft / 60000)}:${String(Math.floor((timeLeft % 60000) / 1000)).padStart(2, '0')}`;

  // Auth screen
  if (phase === 'auth') {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-card rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-2xl font-bold mb-6 text-center">Sign In to Play</h1>
          {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

          {!awaitingCode ? (
            <>
              <input
                type="text"
                placeholder="Display name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full bg-surface border border-gray-700 rounded-lg px-4 py-2 mb-3 focus:outline-none focus:border-primary"
              />
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-surface border border-gray-700 rounded-lg px-4 py-2 mb-4 focus:outline-none focus:border-primary"
              />
              <button
                onClick={handleRequestCode}
                disabled={!email || !displayName}
                className="w-full bg-primary hover:bg-primary/80 disabled:opacity-50 text-white font-bold py-2 rounded-lg transition-colors"
              >
                Get Code
              </button>
            </>
          ) : (
            <>
              <p className="text-gray-400 text-sm mb-3">Enter the code sent to {email}</p>
              <input
                type="text"
                placeholder="6-digit code"
                value={authCode}
                onChange={(e) => setAuthCode(e.target.value)}
                className="w-full bg-surface border border-gray-700 rounded-lg px-4 py-2 mb-4 focus:outline-none focus:border-primary text-center text-2xl tracking-widest"
                maxLength={6}
              />
              <button
                onClick={handleVerifyCode}
                disabled={authCode.length !== 6}
                className="w-full bg-primary hover:bg-primary/80 disabled:opacity-50 text-white font-bold py-2 rounded-lg transition-colors"
              >
                Verify & Play
              </button>
            </>
          )}
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
          <p className="text-gray-400">Matching you with 5 AI opponents</p>
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
            {revealResults.map((r, i) => (
              <div
                key={r.handle}
                className={`flex items-center justify-between p-3 rounded-lg ${
                  r.type === 'human' ? 'bg-primary/20 border border-primary/40' : 'bg-surface'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className={`font-semibold ${getHandleColor(r.handle)}`}>{r.handle}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      r.type === 'human'
                        ? 'bg-primary/30 text-primary'
                        : 'bg-gray-700 text-gray-300'
                    }`}
                  >
                    {r.type.toUpperCase()}
                  </span>
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
              onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
              placeholder="Type a message..."
              className="flex-1 bg-surface border border-gray-700 rounded-lg px-4 py-2 focus:outline-none focus:border-primary"
              maxLength={2000}
            />
            <button
              onClick={handleSendMessage}
              disabled={!messageInput.trim()}
              className="bg-primary hover:bg-primary/80 disabled:opacity-50 text-white font-bold px-6 rounded-lg transition-colors"
            >
              Send
            </button>
          </div>
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
