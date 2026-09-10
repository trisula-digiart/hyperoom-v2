import { useState, useEffect, useRef, useCallback } from "react";
import { api, signup, login, logout, getToken, getUser, setUser } from "./api";
import { useRealtime, type WsEvent } from "./useRealtime";
import "./App.css";

// --- Types ---
interface Profile { id: string; username: string; displayName?: string; createdAt: string }
interface Room { id: string; name: string; type: string; topic?: string; isLocked: boolean; ownerId: string; createdAt: string }
interface Member { roomId: string; userId: string; role: string; joinedAt: string }
interface Message { id: string; roomId: string; authorId: string; kind: string; content: string; createdAt: string; replyToMessageId?: string | null }
interface Presence { userId: string; status: string }

// mIRC nick colors
const NICK_COLORS = ["#e74c3c","#2980b9","#27ae60","#8e44ad","#e67e22","#16a085","#d35400","#2c3e50","#c0392b","#1abc9c","#9b59b6","#f39c12","#3498db","#e91e63","#00bcd4","#ff5722"];

function nickColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return NICK_COLORS[Math.abs(h) % NICK_COLORS.length];
}

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

function shortId(id: string) { return id.slice(0, 8); }

// --- Boot loader (classic connection splash, modern polish) ---
const BOOT_LINES = [
  "hyperoom v2",
  "connecting to home server...",
  "verifying session...",
  "loading workspace...",
  "online.",
];

function BootLoader() {
  const [lineCount, setLineCount] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (lineCount >= BOOT_LINES.length) {
      const t = setTimeout(() => setDone(true), 600);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setLineCount(c => c + 1), 240);
    return () => clearTimeout(t);
  }, [lineCount]);

  return (
    <div className="boot-wrap">
      <div className={`boot-card ${done ? "boot-done" : ""}`}>
        <div className="boot-title">HYPEROOM <span>v2</span></div>
        <div className="boot-screen">
          {BOOT_LINES.slice(0, lineCount).map((line, i) => (
            <div key={i} className={`boot-line ${i === 0 ? "boot-brand" : ""}`}>
              {line}
            </div>
          ))}
          <span className="boot-cursor">▊</span>
        </div>
        <div className="boot-bar"><div className="boot-bar-fill" /></div>
      </div>
      <div className="boot-note">home server · self-hosted · no cloud</div>
    </div>
  );
}
function AuthScreen({ onAuthed }: { onAuthed: (u: Profile) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [u, setU] = useState(""); const [p, setP] = useState(""); const [d, setD] = useState("");
  const [err, setErr] = useState(""); const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const tok = getToken();
    if (!tok) { setChecking(false); return; }
    api<{ user: Profile }>("GET", "/api/me").then((r) => {
      setUser(r.user); onAuthed(r.user);
    }).catch(() => { setChecking(false); });
  }, []);

  if (checking) return <BootLoader />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(""); setLoading(true);
    try {
      const user = mode === "signup" ? await signup(u, p, d || u) : await login(u, p);
      onAuthed(user);
    } catch (err) { setErr(String((err as Error).message)); setLoading(false); }
  };

  return (
    <div className="auth-bg">
      <div className="auth-card">
        <div className="auth-logo">Hyper<em>oom</em></div>
        <div className="auth-sub">v2 — home server</div>
        <form onSubmit={submit} className="auth-form">
          {mode === "signup" && (
            <label>Display Name
              <input value={d} onChange={e => setD(e.target.value)} placeholder="optional" autoFocus />
            </label>
          )}
          <label>Username
            <input value={u} onChange={e => setU(e.target.value)} required autoFocus={mode === "login"} />
          </label>
          <label>Password
            <input type="password" value={p} onChange={e => setP(e.target.value)} required minLength={6} />
          </label>
          {err && <div className="auth-error">{err}</div>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? "…" : mode === "login" ? "Log In" : "Create Account"}
          </button>
        </form>
        <div className="auth-switch">
          {mode === "login"
            ? <>No account? <button onClick={() => setMode("signup")}>Sign up</button></>
            : <>Have an account? <button onClick={() => setMode("login")}>Log in</button></>
          }
        </div>
      </div>
    </div>
  );
}

// --- Main Chat App ---
export default function App() {
  const [user, setSUser] = useState<Profile | null>(getUser());
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeRoom, setActiveRoom] = useState<Room | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [presenceMap, setPresenceMap] = useState<Map<string, Presence>>(new Map());
  const [input, setInput] = useState("");
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [wsConnected, setWsConnected] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // fetch rooms once logged in
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api<{ rooms: Room[] }>("GET", "/api/rooms").then(r => {
      if (cancelled) return;
      setRooms(r.rooms);
      setActiveRoom(prev => prev ?? r.rooms[0] ?? null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [user]);

  // fetch messages + members when room changes
  useEffect(() => {
    if (!activeRoom) return;
    api<{ messages: Message[] }>("GET", `/api/rooms/${activeRoom.id}/messages`).then(r => setMessages(r.messages)).catch(() => setMessages([]));
    api<{ members: Member[] }>("GET", `/api/rooms/${activeRoom.id}/members`).then(r => setMembers(r.members)).catch(() => setMembers([]));
    inputRef.current?.focus();
  }, [activeRoom]);

  // scroll to bottom on new message
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // handle ws events
  const handleWsEvent = useCallback((evt: WsEvent) => {
    switch (evt.type) {
      case "message:new":
        setMessages(prev => [...prev, evt.message]);
        break;
      case "message:edit":
        setMessages(prev => prev.map(m => m.id === evt.message.id ? { ...m, content: evt.message.content } : m));
        break;
      case "message:delete":
        setMessages(prev => prev.filter(m => m.id !== evt.messageId));
        break;
      case "room:join":
        setMembers(prev => [...prev, evt.member]);
        break;
      case "room:leave":
        setMembers(prev => prev.filter(m => m.userId !== evt.userId));
        break;
      case "presence:update":
        setPresenceMap(prev => {
          const next = new Map(prev);
          next.set(evt.presence.userId, evt.presence);
          return next;
        });
        break;
    }
  }, []);

  const { send: wsSend } = useRealtime({
    onEvent: handleWsEvent,
    onOpen: () => setWsConnected(true),
    onClose: () => setWsConnected(false),
  });

  // join room via WS when active room changes
  useEffect(() => {
    if (activeRoom && wsConnected) {
      wsSend({ type: "room:join", roomId: activeRoom.id });
    }
  }, [activeRoom, wsConnected]);

  // send message (handles /commands)
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !activeRoom) return;
    const raw = input.trim();
    setInput("");

    // handle local commands
    if (raw.startsWith("/")) {
      const parts = raw.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const rest = parts.slice(1).join(" ");

      if (cmd === "/help") {
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(), roomId: activeRoom.id, authorId: "system",
          kind: "system", content: [
            "/join #room — join a room",
            "/part #room — leave a room",
            "/me action — send an action (/me waves)",
            "/nick name — change your display name",
            "/whois user — look up a user",
            "/topic text — set room topic",
            "/quit — disconnect",
          ].join(" │ "),
          createdAt: new Date().toISOString()
        }]);
        return;
      }
      if (cmd === "/nick" && rest) {
        try { await api("PATCH", "/api/me/nick", { displayName: rest }); }
        catch {}
        return;
      }
      if (cmd === "/me") {
        try {
          const r = await api<{ message: Message }>("POST", `/api/rooms/${activeRoom.id}/messages`, { content: raw, kind: "action" });
          // optimistic
        } catch {}
        return;
      }
      if (cmd === "/topic" && activeRoom.ownerId === user?.id) {
        try { await api("PATCH", `/api/rooms/${activeRoom.id}`, { topic: rest }); setActiveRoom(r2 => r2 && { ...r2, topic: rest }); }
        catch {}
        return;
      }
      // /help fallback
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), roomId: activeRoom.id, authorId: "system",
        kind: "system", content: `Unknown command: ${cmd}. Type /help for available commands.`,
        createdAt: new Date().toISOString()
      }]);
      return;
    }

    // normal message
    try {
      await api("POST", `/api/rooms/${activeRoom.id}/messages`, { content: raw });
    } catch (err) {
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), roomId: activeRoom.id, authorId: "system",
        kind: "system", content: `Error: ${(err as Error).message}`,
        createdAt: new Date().toISOString()
      }]);
    }
  };

  const createRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoomName.trim()) return;
    try {
      const r = await api<{ room: Room }>("POST", "/api/rooms", { name: newRoomName, type: "public" });
      setRooms(prev => [...prev, r.room]);
      setActiveRoom(r.room);
      setShowCreateRoom(false); setNewRoomName("");
    } catch (err) { alert((err as Error).message); }
  };

  const handleLogout = () => { logout(); setSUser(null); };

  if (!user) return <AuthScreen onAuthed={setSUser} />;

  return (
    <div className="app">
      {/* ---- LEFT SIDEBAR ---- */}
      <aside className="sidebar-left">
        <div className="sidebar-logo">
          <span className="logo-h">H</span>yper<em>oom</em>
          <span className="ws-dot" data-on={wsConnected} title={wsConnected ? "connected" : "disconnected"} />
        </div>

        <div className="sidebar-section">
          <div className="sidebar-heading">
            Channels
            <button className="icon-btn" onClick={() => setShowCreateRoom(!showCreateRoom)} title="Create room">＋</button>
          </div>
          {showCreateRoom && (
            <form className="create-room" onSubmit={createRoom}>
              <input value={newRoomName} onChange={e => setNewRoomName(e.target.value)} placeholder="#new-room" autoFocus />
              <button type="submit" className="btn-sm">Create</button>
            </form>
          )}
          <div className="room-list">
            {rooms.map(r => (
              <div key={r.id}
                className={`room-item ${activeRoom?.id === r.id ? "active" : ""}`}
                onClick={() => setActiveRoom(r)}>
                <span className="room-hash">#</span>{r.name.slice(1)}
              </div>
            ))}
            {rooms.length === 0 && <div className="sidebar-empty">no rooms yet</div>}
          </div>
        </div>

        <div className="sidebar-bottom">
          <div className="user-badge">
            <div className="user-avatar" style={{ background: nickColor(user.id) }}>{user.username[0].toUpperCase()}</div>
            <div className="user-info">
              <div className="user-name">{user.displayName || user.username}</div>
              <div className="user-id">@{user.username}</div>
            </div>
            <button className="icon-btn logout" onClick={handleLogout} title="logout">⏻</button>
          </div>
        </div>
      </aside>

      {/* ---- CENTER ---- */}
      <main className="main-panel">
        <div className="main-header">
          <div className="main-header-left">
            <span className="header-hash">#</span>
            <span className="header-room">{activeRoom?.name?.slice(1) || "select a room"}</span>
            {activeRoom?.topic && <span className="header-topic">{activeRoom.topic}</span>}
          </div>
          <div className="main-header-right">
            <span className="member-count">{members.length} member{members.length !== 1 ? "s" : ""}</span>
          </div>
        </div>

        <div className="messages">
          {messages.length === 0 && (
            <div className="messages-empty">
              <div className="empty-icon">💬</div>
              <div>No messages yet</div>
              <div className="empty-sub">Send the first message in #{activeRoom?.name?.slice(1) || "…"}</div>
            </div>
          )}
          {messages.map(msg => {
            const isAction = msg.kind === "action";
            const isSystem = msg.kind === "system";
            if (isSystem) {
              return <div key={msg.id} className="msg msg-system"><span className="msg-system-text">{msg.content}</span></div>;
            }
            return (
              <div key={msg.id} className={`msg ${isAction ? "msg-action" : ""}`}>
                <span className="msg-time">{fmtTime(msg.createdAt)}</span>
                <span className="msg-nick" style={{ color: nickColor(msg.authorId) }}>
                  {shortId(msg.authorId)}
                </span>
                <span className="msg-body">
                  {isAction ? ` ${msg.content}` : msg.content}
                </span>
              </div>
            );
          })}
          <div ref={messagesEnd} />
        </div>

        <form className="input-bar" onSubmit={handleSend}>
          <span className="input-prefix">{activeRoom ? `#${activeRoom.name.slice(1)}` : ""}</span>
          <input
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={activeRoom ? `Type a message or /help for commands…` : "Select a room first"}
            disabled={!activeRoom}
            autoFocus
          />
          <button type="submit" className="btn-send" disabled={!input.trim() || !activeRoom}>▸</button>
        </form>
      </main>

      {/* ---- RIGHT SIDEBAR ---- */}
      <aside className="sidebar-right">
        <div className="sidebar-heading">Members ({members.length})</div>
        <div className="member-list">
          {(["owner", "admin", "operator", "voice", "member"] as const).map(role => {
            const group = members.filter(m => m.role === role);
            if (group.length === 0) return null;
            return (
              <div key={role} className="member-group">
                <div className="member-group-label">{role}s ({group.length})</div>
                {group.map(m => {
                  const pres = presenceMap.get(m.userId);
                  const isOnline = pres?.status === "online";
                  return (
                    <div key={m.userId} className="member-item">
                      <div className="member-avatar" style={{ background: nickColor(m.userId) }}>
                        <span>{shortId(m.userId)[0].toUpperCase()}</span>
                        <span className={`member-dot ${isOnline ? "online" : ""}`} />
                      </div>
                      <div className="member-name" style={{ color: nickColor(m.userId) }}>
                        {shortId(m.userId)}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {members.length === 0 && <div className="sidebar-empty">no members</div>}
        </div>
      </aside>
    </div>
  );
}