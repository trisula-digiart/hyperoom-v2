// API client + auth token storage

const BASE = ""; // same origin via proxy

let token: string | null = localStorage.getItem("h2_token");
let user: { id: string; username: string; displayName?: string } | null = null;

function headers(): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
}

export async function signup(username: string, password: string, displayName?: string) {
  const r = await api<{ token: string; user: { id: string; username: string; displayName?: string } }>(
    "POST", "/api/auth/signup", { username, password, displayName }
  );
  token = r.token; localStorage.setItem("h2_token", r.token); user = r.user;
  return r.user;
}

export async function login(username: string, password: string) {
  const r = await api<{ token: string; user: { id: string; username: string; displayName?: string } }>(
    "POST", "/api/auth/login", { username, password }
  );
  token = r.token; localStorage.setItem("h2_token", r.token); user = r.user;
  return r.user;
}

export function logout() { token = null; user = null; localStorage.removeItem("h2_token"); }

export function getToken() { return token; }
export function setUser(u: typeof user) { user = u; }
export function getUser() { return user; }