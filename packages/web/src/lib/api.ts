const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

async function fetchApi(path: string, options: RequestInit = {}) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('fth_token') : null;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

export async function requestCode(email: string, displayName: string) {
  return fetchApi('/auth/request-code', {
    method: 'POST',
    body: JSON.stringify({ email, display_name: displayName }),
  });
}

export async function verifyCode(email: string, code: string, displayName: string) {
  return fetchApi('/auth/verify-code', {
    method: 'POST',
    body: JSON.stringify({ email, code, display_name: displayName }),
  });
}

export async function getMe() {
  return fetchApi('/auth/me');
}

export async function getLeaderboard(type: 'human' | 'bot', page: number = 1) {
  return fetchApi(`/leaderboard?type=${type}&page=${page}`);
}

export async function getUserProfile(id: string) {
  return fetchApi(`/leaderboard/user/${id}`);
}

export { API_URL };
