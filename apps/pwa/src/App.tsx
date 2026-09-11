import { useState, useEffect, useRef, useCallback } from "react";
import { api, signup, login, logout, getToken, getUser, setUser, resolveUrl } from "./api";
import { useRealtime, type WsEvent } from "./useRealtime";
import "./App.css";

// --- Types ---
interface Profile { id: string; username: string; displayName?: string; createdAt?: string }
interface Room { id: string; name: string; type: string; topic?: string; isLocked: boolean; ownerId: string; createdAt: string; isLobby?: boolean }
interface Member { roomId: string; userId: string; role: string; joinedAt: string; username?: string; displayName?: string | null; avatarUrl?: string | null }
interface Message { id: string; roomId: string; authorId: string; kind: string; content: string; createdAt: string; replyToMessageId?: string | null; authorName?: string }
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
  "nyambung ke server rumah...",
  "cek sesi...",
  "muat workspace...",
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
        <div className="boot-logo-wrap">
          <img src="/logo.png" alt="Hyperoom" className="boot-logo-img" />
        </div>
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
      <div className="boot-note">server rumah · self-hosted · tanpa cloud</div>
    </div>
  );
}
function AuthScreen({ onAuthed }: { onAuthed: (u: Profile) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [u, setU] = useState(""); const [p, setP] = useState(""); const [d, setD] = useState(""); const [ph, setPh] = useState("");
  const [err, setErr] = useState(""); const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [step, setStep] = useState(0); // wizard: 0=hook, 1=fitur, 2=form

  useEffect(() => {
    const tok = getToken();
    if (!tok) { setChecking(false); return; }
    api<{ user: Profile }>("GET", "/api/me").then((r) => {
      setUser(r.user); onAuthed(r.user);
    }).catch(() => { setChecking(false); });
  }, []);

  // auto-advance wizard (non-intrusif, berhenti di form)
  useEffect(() => {
    if (checking || step >= 2) return;
    const t = setTimeout(() => setStep(s => Math.min(s + 1, 2)), 6000);
    return () => clearTimeout(t);
  }, [step, checking]);

  if (checking) return <BootLoader />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(""); setLoading(true);
    try {
      const user = mode === "signup" ? await signup(u, p, d || u, ph || undefined) : await login(u, p);
      onAuthed(user);
    } catch (err) { setErr(String((err as Error).message)); setLoading(false); }
  };

  return (
    <div className="auth-bg wizard-bg">
      <div className="wizard-logo"><img src="/logo.png" alt="Hyperoom" /></div>

      {/* SLIDE 0 — hook */}
      {step === 0 && (
        <div className="wizard-slide wizard-slide-hook">
          <div className="wizard-title">Ngumpul Bareng.<br />Tanpa Ribet.</div>
          <div className="wizard-sub">Tempat kumpul buat lo yang mau ngobrol santai,<br />dapet ilmu, dapet temen baru.</div>
          <div className="wizard-cta">
            <button className="btn-primary btn-big" onClick={() => setStep(1)}>Lanjut ➜</button>
            <button className="wizard-skip" onClick={() => setStep(2)}>Lewati, langsung daftar</button>
          </div>
        </div>
      )}

      {/* SLIDE 1 — fitur + pilihan */}
      {step === 1 && (
        <div className="wizard-slide wizard-slide-features">
          <div className="wizard-title">Bikin Ruangan Sendiri,<br />Atur Aturannya.</div>
          <div className="wizard-features">
            <div className="wizard-feature">
              <div className="wf-icon">⚡</div>
              <div className="wf-title">Realtime Chat</div>
              <div className="wf-desc">Pesan masuk instan, langsung kebales.</div>
            </div>
            <div className="wizard-feature">
              <div className="wf-icon">🔒</div>
              <div className="wf-title">Room Privat</div>
              <div className="wf-desc">Password + undang temen yang lo mau.</div>
            </div>
            <div className="wizard-feature">
              <div className="wf-icon">🎮</div>
              <div className="wf-title">Command Klasik</div>
              <div className="wf-desc">/join /me /kick — ngerasa kaya mIRC.</div>
            </div>
            <div className="wizard-feature">
              <div className="wf-icon">👑</div>
              <div className="wf-title">Role Lengkap</div>
              <div className="wf-desc">Owner, Admin, Operator, Voice.</div>
            </div>
          </div>
          <div className="wizard-choice">
            <div className="wizard-choice-title">Udah punya akun atau baru gabung?</div>
            <div className="wizard-choice-btns">
              <button className="btn-secondary btn-big" onClick={() => { setMode("login"); setStep(2); }}>
                🔑 Sudah Punya Akun<br /><span className="choice-sub">Langsung masuk</span>
              </button>
              <button className="btn-primary btn-big" onClick={() => { setMode("signup"); setStep(2); }}>
                ✨ Belum Punya Akun<br /><span className="choice-sub">Daftar 1 menit</span>
              </button>
            </div>
            <button className="wizard-back" onClick={() => setStep(0)}>⬅ Kembali</button>
          </div>
        </div>
      )}

      {/* SLIDE 2 — form login/daftar (fungsi SAMA kayak sebelumnya) */}
      {step === 2 && (
        <div className="auth-card wizard-form">
          <button className="wizard-back wizard-back-top" onClick={() => setStep(1)}>⬅ Kembali</button>
          <div className="wizard-form-title">{mode === "login" ? "Selamat Datang Kembali! 👋" : "Daftarnya 1 Menit.<br />Ngobrolnya Seharian."}</div>
          <form onSubmit={submit} className="auth-form">
            {mode === "signup" && (
              <>
                <label>Nama Tampilan
                  <input value={d} onChange={e => setD(e.target.value)} placeholder="Contoh: Budi Santoso" />
                  <span className="field-hint">Opsional — biar gampang dikenalin temen</span>
                </label>
                <label>Nomor HP
                  <input value={ph} onChange={e => setPh(e.target.value)} placeholder="08xxxxxxxxxx" inputMode="tel" />
                  <span className="field-hint">Opsional — cuma buat keamanan akun, ga ditampilkan ke user lain</span>
                </label>
              </>
            )}
            <label>Username
              <input value={u} onChange={e => setU(e.target.value)} required autoFocus={mode === "login"} placeholder={mode === "login" ? "Nama yang lo daftarin dulu" : "Contoh: budi_ganteng"} />
              <span className="field-hint">{mode === "login" ? "Pake nama yang lo daftarin waktu pertama gabung" : "Nama panggilan lo — 2–20 huruf/angka, ga bisa dipake orang lain"}</span>
            </label>
            <label>Password
              <input type="password" value={p} onChange={e => setP(e.target.value)} required minLength={6} placeholder="••••••••" />
              <span className="field-hint">Minimal 6 karakter — rahasia, jangan kasih siapa-siapa ya</span>
            </label>
            {err && <div className="auth-error">{err}</div>}
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? "…" : mode === "login" ? "Masuk" : "Buat Akun"}
            </button>
          </form>
          <div className="auth-switch">
            {mode === "login"
              ? <>Belum punya akun? <button onClick={() => setMode("signup")}>Daftar di sini</button></>
              : <>Udah punya akun? <button onClick={() => setMode("login")}>Masuk di sini</button></>
            }
          </div>
          <div className="wizard-reassure">Bebas. Ga ada iklan. Ga ada tracking.</div>
        </div>
      )}

      {/* dots navigasi */}
      <div className="wizard-dots">
        <button className={`wizard-dot ${step === 0 ? "active" : ""}`} onClick={() => setStep(0)} aria-label="Slide 1" />
        <button className={`wizard-dot ${step === 1 ? "active" : ""}`} onClick={() => setStep(1)} aria-label="Slide 2" />
        <button className={`wizard-dot ${step === 2 ? "active" : ""}`} onClick={() => setStep(2)} aria-label="Slide 3" />
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
  const [newRoomType, setNewRoomType] = useState<"public" | "private">("public");
  const [newRoomTopic, setNewRoomTopic] = useState("");
  const [newRoomDesc, setNewRoomDesc] = useState("");
  const [newRoomPass, setNewRoomPass] = useState("");
  const [wsConnected, setWsConnected] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [joinPrompt, setJoinPrompt] = useState<Room | null>(null);
  const [joinPassword, setJoinPassword] = useState("");
  const [joinError, setJoinError] = useState("");
  const [profileUser, setProfileUser] = useState<any>(null);
  const [inviteModal, setInviteModal] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState<any[]>([]);
  const [inviteMsg, setInviteMsg] = useState("");
  const [expandGlobal, setExpandGlobal] = useState(true);
  const [expandRoom, setExpandRoom] = useState(true);
  const [reactionsMap, setReactionsMap] = useState<Record<string, any[]>>({});
  const [typingUsers, setTypingUsers] = useState<Record<string, string[]>>({}); // roomId -> userIds
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [ignoreList, setIgnoreList] = useState<string[]>([]); // user IDs di-ignore
  const [msgMenu, setMsgMenu] = useState<string | null>(null); // edit/delete menu pesan
  const [editProfile, setEditProfile] = useState(false);
  const [editBio, setEditBio] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [editName, setEditName] = useState("");
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const activeRoomRef = useRef<string | null>(null);
  useEffect(() => { activeRoomRef.current = activeRoom?.id || null; }, [activeRoom]);
  const userRef = useRef(user);
  useEffect(() => { userRef.current = user; }, [user]);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // fetch rooms once logged in
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api<{ rooms: Room[] }>("GET", "/api/rooms").then(r => {
      if (cancelled) return;
      setRooms(r.rooms);
      setActiveRoom(prev => prev ?? r.rooms.find(x => x.isLobby) ?? r.rooms[0] ?? null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [user]);

  // fetch messages + members + reactions when room changes
  const prevRoomRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeRoom) return;
    // unsubscribe dari room sebelumnya di WS
    if (prevRoomRef.current && prevRoomRef.current !== activeRoom.id) {
      wsSend({ type: "room:leave", roomId: prevRoomRef.current });
    }
    prevRoomRef.current = activeRoom.id;
    api("POST", `/api/rooms/${activeRoom.id}/join`).catch(() => {});
    // clear unread for this room
    setUnread(prev => { if (!(prev[activeRoom.id] > 0)) return prev; const n = { ...prev }; delete n[activeRoom.id]; return n; });
    api<{ messages: Message[] }>("GET", `/api/rooms/${activeRoom.id}/messages`).then(r => {
      setMessages(r.messages);
      const ids = r.messages.map(m => m.id);
      Promise.all(ids.map(id => api<{ reactions: any[] }>(`GET`, `/api/messages/${id}/reactions`).catch(() => ({ reactions: [] }))))
        .then(results => {
          const map: Record<string, any[]> = {};
          results.forEach((res: any, i) => { if (res.reactions?.length) map[ids[i]] = res.reactions; });
          setReactionsMap(map);
        });
    }).catch(() => setMessages([]));
    api<{ members: Member[] }>("GET", `/api/rooms/${activeRoom.id}/members`).then(r => setMembers(r.members)).catch(() => setMembers([]));
    inputRef.current?.focus();
  }, [activeRoom]);

  // scroll to bottom on new message
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // fetch online users (global directory) every 10s
    useEffect(() => {
      if (!user) return;
      fetchOnlineUsers();
      const iv = setInterval(fetchOnlineUsers, 10000);
      return () => clearInterval(iv);
    }, [user, activeRoom]);

    // fetch ignore list saat login
    useEffect(() => {
      if (!user) return;
      api<{ ignoredUserIds: string[] }>("GET", "/api/me/ignores").then(r => setIgnoreList(r.ignoredUserIds)).catch(() => {});
    }, [user]);

    // edit/delete message
    const editMessage = async (msgId: string) => {
      const newContent = prompt("Edit pesan:");
      if (!newContent || !newContent.trim()) { setMsgMenu(null); return; }
      try {
        await api("PATCH", `/api/messages/${msgId}`, { content: newContent.trim() });
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, content: newContent.trim() } : m));
      } catch (err) { alert((err as Error).message); }
      setMsgMenu(null);
    };
    const deleteMessage = async (msgId: string) => {
      if (!confirm("Hapus pesan ini?")) { setMsgMenu(null); return; }
      try {
        await api("DELETE", `/api/messages/${msgId}`);
        setMessages(prev => prev.filter(m => m.id !== msgId));
      } catch (err) { alert((err as Error).message); }
      setMsgMenu(null);
    };

    // edit profile
    const openEditProfile = () => {
      setEditBio(profileUser?.bio || "");
      setEditStatus(profileUser?.status || "");
      setEditName(profileUser?.displayName || profileUser?.username || "");
      setEditProfile(true);
    };
    const saveProfile = async () => {
      try {
        await api("PATCH", "/api/users/me", { displayName: editName, bio: editBio, status: editStatus });
        setProfileUser({ ...profileUser, displayName: editName, bio: editBio, status: editStatus });
        setEditProfile(false);
        setUser({ ...user!, displayName: editName });
        api<{ user: any }>("GET", "/api/me").then(r => setUser(r.user)).catch(() => {});
      } catch (err) { alert((err as Error).message); }
    };
    const uploadAvatar = async (file: File) => {
      if (!file) return;
      const fd = new FormData();
      fd.append("avatar", file);
      try {
        const tok = getToken();
        const r = await fetch("/api/users/me/avatar", {
          method: "POST",
          headers: { "Authorization": `Bearer ${tok}` },
          body: fd,
        }).then(r => r.json());
        if (!r.ok && r.error) throw new Error(r.error);
        if (r.ok === false) throw new Error(r.error);
        setProfileUser({ ...profileUser, avatarUrl: r.avatarUrl });
      } catch (err) { alert((err as Error).message); }
    };

  // real browser notification (mention/PM/room lain) + sound
  const notifyReal = (msg: any) => {
    const myName = userRef.current?.username || "";
    const isMention = msg.content?.includes(`@${myName}`) || msg.content?.includes(`@${userRef.current?.displayName}`);
    const isDm = msg.roomId !== activeRoomRef.current && (msg.roomId || "").includes("dm-");
    const isOtherRoom = msg.roomId !== activeRoomRef.current;
    if (!isMention && !isDm && !isOtherRoom) return;
    if (msg.authorId === userRef.current?.id) return; // pesan sendiri ga notif

    // sound (Web Audio API — beep singkat)
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880; gain.gain.value = 0.15;
      osc.start(); osc.stop(ctx.currentTime + 0.15);
    } catch {}

    // browser notification
    try {
      if (!("Notification" in window)) return;
      if (Notification.permission === "default") Notification.requestPermission();
      if (Notification.permission !== "granted") return;
      const tag = isMention ? "mention" : isDm ? "dm" : "room";
      new Notification(`💬 ${msg.authorName || msg.authorId.slice(0, 6)}`, {
        body: isMention ? `Mention lo: ${msg.content}` : isDm ? `DM: ${msg.content}` : msg.content,
        tag,
      });
    } catch {}
  };

  // handle ws events
  const handleWsEvent = useCallback((evt: WsEvent) => {
    switch (evt.type) {
      case "message:new":
        setMessages(prev => [...prev, evt.message]);
        setUnread(prev => {
          if (evt.message.roomId === activeRoomRef.current) return prev;
          return { ...prev, [evt.message.roomId]: (prev[evt.message.roomId] || 0) + 1 };
        });
        // real browser notification: mention / DM / pesan room lain
        notifyReal(evt.message);
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
      case "typing:start":
        setTypingUsers(prev => {
          const cur = prev[evt.roomId] || [];
          return cur.includes(evt.userId) ? prev : { ...prev, [evt.roomId]: [...cur, evt.userId] };
        });
        setTimeout(() => {
          setTypingUsers(prev => ({ ...prev, [evt.roomId]: (prev[evt.roomId] || []).filter(u => u !== evt.userId) }));
        }, 4000);
        break;
      case "typing:stop":
        setTypingUsers(prev => ({ ...prev, [evt.roomId]: (prev[evt.roomId] || []).filter(u => u !== evt.userId) }));
        break;
      case "reaction:add":
        setReactionsMap(prev => {
          const cur = prev[(evt as any).reaction.messageId] || [];
          if (cur.find(r => r.userId === (evt as any).reaction.userId && r.emoji === (evt as any).reaction.emoji)) return prev;
          return { ...prev, [(evt as any).reaction.messageId]: [...cur, { emoji: (evt as any).reaction.emoji, userId: (evt as any).reaction.userId }] };
        });
        break;
      case "reaction:remove":
        setReactionsMap(prev => ({
          ...prev,
          [(evt as any).messageId]: (prev[(evt as any).messageId] || []).filter(r => !(r.userId === (evt as any).userId && r.emoji === (evt as any).emoji)),
        }));
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

    // handle commands via backend engine (real execution)
    if (raw.startsWith("/")) {
      try {
        const res = await api<{ ok: boolean; reply?: string; roomId?: string }>("POST", "/api/commands", { input: raw, roomId: activeRoom.id });
        if (res.reply) {
          setMessages(prev => [...prev, {
            id: crypto.randomUUID(), roomId: activeRoom.id, authorId: "system",
            kind: "system", content: res.reply ?? "",
            createdAt: new Date().toISOString()
          }]);
        }
        // refresh rooms if join/part happened
        api<{ rooms: Room[] }>("GET", "/api/rooms").then(r => { setRooms(r.rooms); }).catch(() => {});
      } catch (err) {
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(), roomId: activeRoom.id, authorId: "system",
          kind: "system", content: `Gagal: ${(err as Error).message}`,
          createdAt: new Date().toISOString()
        }]);
      }
      return;
    }

    // normal message
    try {
      await api("POST", `/api/rooms/${activeRoom.id}/messages`, { content: raw });
    } catch (err) {
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(), roomId: activeRoom.id, authorId: "system",
        kind: "system", content: `Gagal: ${(err as Error).message}`,
        createdAt: new Date().toISOString()
      }]);
    }
  };

  const createRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoomName.trim()) return;
    try {
      const r = await api<{ room: Room }>("POST", "/api/rooms", {
        name: newRoomName, type: newRoomType,
        topic: newRoomTopic || undefined,
        password: newRoomType === "private" ? newRoomPass : undefined,
      });
      setRooms(prev => [...prev, r.room]);
      setActiveRoom(r.room);
      setShowCreateRoom(false); setNewRoomName(""); setNewRoomType("public"); setNewRoomTopic(""); setNewRoomDesc(""); setNewRoomPass("");
    } catch (err) { alert((err as Error).message); }
  };

  // click room: if private & not member → password prompt; else open
  const openRoom = async (room: Room) => {
    // check membership via members endpoint attempt — if fails, prompt
    try {
      await api("POST", `/api/rooms/${room.id}/join`, {});
      setActiveRoom(room);
    } catch (err) {
      if (room.type === "private" || room.isLocked) {
        setJoinPrompt(room); setJoinPassword(""); setJoinError("");
      } else {
        setActiveRoom(room);
      }
    }
  };
  const submitJoinPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinPrompt) return;
    try {
      await api("POST", `/api/rooms/${joinPrompt.id}/join`, { password: joinPassword });
      setJoinPrompt(null);
      setActiveRoom(joinPrompt);
      api<{ rooms: Room[] }>("GET", "/api/rooms").then(r => setRooms(r.rooms)).catch(() => {});
    } catch (err) { setJoinError((err as Error).message); }
  };

  const handleLogout = () => { logout(); setSUser(null); };

  // topic modal state
  const [topicOpen, setTopicOpen] = useState(false);
  const [topicVal, setTopicVal] = useState("");
  const openTopicModal = () => { setTopicVal(activeRoom?.topic || ""); setTopicOpen(true); };
  const saveTopic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeRoom) return;
    try { await api("PATCH", `/api/rooms/${activeRoom.id}`, { topic: topicVal }); setActiveRoom({ ...activeRoom, topic: topicVal }); setTopicOpen(false); }
    catch (err) { alert((err as Error).message); }
  };
  const handleLeaveRoom = async () => {
    if (!activeRoom) return;
    try {
      await api("POST", `/api/rooms/${activeRoom.id}/leave`);
      // pindah ke lobby (landasan) bukan null
      const roomsAfter = await api<{ rooms: Room[] }>("GET", "/api/rooms");
      setRooms(roomsAfter.rooms);
      setActiveRoom(roomsAfter.rooms.find(x => x.isLobby) ?? roomsAfter.rooms[0] ?? null);
      setMessages([]);
      setMembers([]);
    } catch (err) { alert((err as Error).message); }
  };

  const fetchProfile = async (userId: string) => {
    try {
      const r = await api<{ user: any }>("GET", `/api/users/${userId}`);
      setProfileUser(r.user);
    } catch (err) { setProfileUser(null); alert((err as Error).message); }
  };

  const fetchOnlineUsers = async () => {
    try {
      const r = await api<{ users: any[] }>("GET", "/api/users/online");
      setOnlineUsers(r.users);
    } catch {}
  };
  const openInvite = async () => {
    await fetchOnlineUsers();
    setInviteModal(true); setInviteMsg("");
  };
  const sendInvite = async (username: string) => {
    if (!activeRoom) return;
    try {
      const r = await api<{ message: string }>("POST", `/api/rooms/${activeRoom.id}/invite`, { username });
      setInviteMsg(`✅ ${r.message}`);
      await fetchOnlineUsers();
    } catch (err) { setInviteMsg(`❌ ${(err as Error).message}`); }
  };

  const doMod = async (action: string, username: string) => {
    if (!activeRoom) return;
    try {
      const r = await api<{ message: string }>("POST", `/api/rooms/${activeRoom.id}/mod/${action}`, { username });
      api<{ members: Member[] }>("GET", `/api/rooms/${activeRoom.id}/members`).then(x => setMembers(x.members)).catch(() => {});
      alert(r.message);
    } catch (err) { alert((err as Error).message); }
  };

  const toggleReaction = async (msgId: string, emoji: string) => {
    const cur = reactionsMap[msgId] || [];
    const mine = cur.find(r => r.userId === user?.id && r.emoji === emoji);
    try {
      const r = mine
        ? await api<{ reactions: any[] }>("DELETE", `/api/messages/${msgId}/reactions`, { emoji })
        : await api<{ reactions: any[] }>("POST", `/api/messages/${msgId}/reactions`, { emoji });
      setReactionsMap(prev => ({ ...prev, [msgId]: r.reactions }));
    } catch {}
  };

  const openDm = async (username: string) => {
    try {
      const r = await api<{ room: Room }>("POST", "/api/dm", { username });
      setRooms(prev => prev.find(x => x.id === r.room.id) ? prev : [...prev, r.room]);
      setActiveRoom(r.room);
      setProfileUser(null);
    } catch (err) { alert((err as Error).message); }
  };

  let typingTimer: any = null;
  const notifyTyping = () => {
    if (!activeRoom) return;
    if (typingTimer) return;
    wsSend({ type: "typing:start", roomId: activeRoom.id });
    typingTimer = setTimeout(() => {
      wsSend({ type: "typing:stop", roomId: activeRoom.id });
      typingTimer = null;
    }, 3000);
  };

  const rolePrefix = (role: string) => {
    switch (role) {
      case "owner": return "@";
      case "admin": return "@";
      case "operator": return "@";
      case "voice": return "+";
      default: return "";
    }
  };

  // autocomplete commands
  const ALL_COMMANDS = ["join", "part", "nick", "me", "topic", "whois", "ignore", "unignore", "help", "clear", "query", "msg"];
  const handleInputChange = (v: string) => {
    setInput(v);
    if (v.startsWith("/")) {
      const typed = v.slice(1).toLowerCase();
      const matches = typed ? ALL_COMMANDS.filter(c => c.startsWith(typed)) : [];
      setSuggestions(matches.slice(0, 5));
    } else {
      setSuggestions([]);
    }
  };
  const applySuggestion = (c: string) => {
    setInput(`/${c} `);
    setSuggestions([]);
    inputRef.current?.focus();
  };

  const isProfileSelf = profileUser && user && profileUser.id === user?.id;

  if (!user) return <AuthScreen onAuthed={setSUser} />;

  return (
    <div className="app">
      {/* ---- LEFT SIDEBAR ---- */}
      <aside className="sidebar-left">
        <div className="sidebar-logo">
          <img src="/logo.png" alt="Hyperoom" className="sidebar-logo-img" />
          <span className="ws-dot" data-on={wsConnected} title={wsConnected ? "connected" : "disconnected"} />
        </div>

        <div className="sidebar-section">
          <div className="sidebar-heading">
          Saluran
          <button className="icon-btn" onClick={() => setShowCreateRoom(!showCreateRoom)} title="Buat ruangan">＋</button>
        </div>
          {showCreateRoom && (
            <form className="create-room" onSubmit={createRoom}>
              <input value={newRoomName} onChange={e => setNewRoomName(e.target.value)} placeholder="#nama-ruangan" autoFocus required />
              <input value={newRoomTopic} onChange={e => setNewRoomTopic(e.target.value)} placeholder="Topik (opsional)" />
              <input value={newRoomDesc} onChange={e => setNewRoomDesc(e.target.value)} placeholder="Deskripsi (opsional)" />
              <div className="room-type-row">
                <label className={`type-opt ${newRoomType === "public" ? "sel" : ""}`}>
                  <input type="radio" name="rtype" checked={newRoomType === "public"} onChange={() => setNewRoomType("public")} /> Public
                </label>
                <label className={`type-opt ${newRoomType === "private" ? "sel" : ""}`}>
                  <input type="radio" name="rtype" checked={newRoomType === "private"} onChange={() => setNewRoomType("private")} /> Private 🔒
                </label>
              </div>
              {newRoomType === "private" && (
                <input type="password" value={newRoomPass} onChange={e => setNewRoomPass(e.target.value)} placeholder="Password room" required />
              )}
              <button type="submit" className="btn-sm">Buat Room</button>
            </form>
          )}
          <div className="room-list">
            {rooms.map(r => (
              <div key={r.id}
                className={`room-item ${activeRoom?.id === r.id ? "active" : ""} ${r.isLobby ? "room-lobby" : ""}`}
                onClick={() => openRoom(r)}>
                <span className="room-hash">{r.isLobby ? "🏠" : "#"}</span>{r.name.slice(1)}
                {(r.type === "private" || r.isLocked) && <span className="room-lock-icon">🔒</span>}
                {unread[r.id] > 0 && <span className="unread-badge">{unread[r.id]}</span>}
              </div>
            ))}
            {rooms.length === 0 && <div className="sidebar-empty">belum ada ruangan</div>}
          </div>
        </div>

        <div className="sidebar-bottom">
          <div className="user-badge">
            <div className="user-avatar" style={{ background: nickColor(user.id) }}>{user.username[0].toUpperCase()}</div>
            <div className="user-info">
              <div className="user-name">{user.displayName || user.username}</div>
              <div className="user-id">@{user.username}</div>
            </div>
            <button className="icon-btn logout" onClick={handleLogout} title="Keluar">⏻</button>
          </div>
        </div>
      </aside>

      {/* ---- CENTER ---- */}
      <main className="main-panel">
        <div className="main-header">
          <div className="main-header-left">
            <span className="header-hash">#</span>
            <span className={`header-room ${activeRoom?.isLobby ? "header-lobby" : ""}`}>{activeRoom?.name?.slice(1) || "pilih ruangan"}</span>
            {activeRoom?.isLobby && <span className="lobby-badge">🏠 LOBY</span>}
            {activeRoom?.topic && <span className="header-topic">{activeRoom.topic}</span>}
            {activeRoom?.isLocked && <span className="lock-badge">🔒</span>}
          </div>
          <div className="main-header-right">
            <span className="member-count">{members.length} anggota</span>
            {(user?.id === activeRoom?.ownerId || members.find(m => m.userId === user?.id)?.role === "admin") && (
              <button className="btn-link invite-btn" onClick={openInvite}>✉️ Undang</button>
            )}
            {user?.id === activeRoom?.ownerId && (
              <button className="btn-link" onClick={openTopicModal} title="Ubah topik">✎ topik</button>
            )}
            {activeRoom && user?.id !== activeRoom.ownerId && (
              <button className="btn-link leave-btn" onClick={handleLeaveRoom}>keluar</button>
            )}
          </div>
        </div>

        <div className="messages">
          {activeRoom?.isLobby && (
            <div className="lobby-welcome">
              <div className="lobby-icon">🏠</div>
              <h2>Selamat datang di {activeRoom.name.replace("#","")}!</h2>
              <p>Ayo ngobrol seru, ilmu dapet, temen dapet, gebetan dapet ❤️</p>
              <div className="lobby-tutorial">
                <div className="tut-title">📖 CARA PAKAI APLIKASI (singkat)</div>
                <div className="lobby-guide">
                  <div className="guide-item"><span>1️⃣</span><div><b>Gabung room</b> — klik room di kiri. Room <b>🔒 privat</b> minta password / harus diundang owner</div></div>
                  <div className="guide-item"><span>2️⃣</span><div><b>Buat room sendiri</b> — klik <b>＋</b> di samping SALURAN → isi nama, pilih Public/Private (private = password)</div></div>
                  <div className="guide-item"><span>3️⃣</span><div><b>Undang teman</b> — buka room privat kamu → klik <b>✉️ Undang</b> → pilih user online → teman langsung bisa masuk tanpa password</div></div>
                  <div className="guide-item"><span>4️⃣</span><div><b>Command /chat</b> — ketik <code>/help</code> liat semua: <code>/join</code> <code>/nick</code> <code>/me</code> <code>/topic</code> <code>/whois</code> <code>/ignore</code> <code>/msg</code></div></div>
                  <div className="guide-item"><span>5️⃣</span><div><b>Profil & avatar</b> — klik user di daftar ANGGOTA → lihat profil, kirim DM, foto avatar dari galeri HP/PC</div></div>
                  <div className="guide-item"><span>6️⃣</span><div><b>Reaksi & notif</b> — 👍❤️😂 di pesan, badge unread di saluran, notifikasi browser kalau di-mention/PM</div></div>
                </div>
              </div>
              <div className="lobby-tip">💡 Kirim pesan pertama di sini buat nyapa semua orang!</div>
            </div>
          )}
          {messages.length === 0 && !activeRoom?.isLobby && (
            <div className="messages-empty">
              <div className="empty-icon">💬</div>
              <div>Belum ada pesan</div>
              <div className="empty-sub">Kirim pesan pertama di #{activeRoom?.name?.slice(1) || "…"}</div>
            </div>
          )}
          {messages.filter(m => !ignoreList.includes(m.authorId)).map(msg => {
            const isAction = msg.kind === "action";
            const isSystem = msg.kind === "system";
            const isMine = msg.authorId === user?.id;
            if (isSystem) {
              return <div key={msg.id} className="msg msg-system"><span className="msg-system-text">{msg.content}</span></div>;
            }
            const msgReactions = reactionsMap[msg.id] || [];
            // group reactions by emoji
            const grouped: Record<string, { emoji: string; count: number; mine: boolean }> = {};
            for (const r of msgReactions) {
              if (!grouped[r.emoji]) grouped[r.emoji] = { emoji: r.emoji, count: 0, mine: false };
              grouped[r.emoji].count++;
              if (r.userId === user?.id) grouped[r.emoji].mine = true;
            }
            // mention highlight: @username jadi span
            const renderContent = (text: string) => {
              const parts = text.split(/(@[a-zA-Z0-9_]{2,20})/g);
              return parts.map((p, i) => p.startsWith("@") && p.length > 2
                ? <span key={i} className="mention">{p}</span>
                : <span key={i}>{p}</span>);
            };
            return (
              <div key={msg.id} className={`msg ${isAction ? "msg-action" : ""} ${isMine ? "msg-mine" : "msg-theirs"}`} onClick={() => isMine && setMsgMenu(msgMenu === msg.id ? null : msg.id)}>
                <span className="msg-time">{fmtTime(msg.createdAt)}</span>
                <span className="msg-nick" style={{ color: nickColor(msg.authorId) }}>
                  {msg.authorName || shortId(msg.authorId)}
                </span>
                <span className="msg-body">{isAction ? <span> {renderContent(msg.content)}</span> : renderContent(msg.content)}</span>
                {msgMenu === msg.id && isMine && (
                  <div className="msg-menu">
                    <button className="msg-menu-item" onClick={(e) => { e.stopPropagation(); editMessage(msg.id); }}>✏️ Edit</button>
                    <button className="msg-menu-item danger" onClick={(e) => { e.stopPropagation(); deleteMessage(msg.id); }}>🗑 Hapus</button>
                  </div>
                )}
                <div className="msg-reactions">
                  {Object.values(grouped).map(g => (
                    <button key={g.emoji}
                      className={`reaction-btn ${g.mine ? "reaction-mine" : ""}`}
                      onClick={(e) => { e.stopPropagation(); toggleReaction(msg.id, g.emoji); }}
                    >{g.emoji} {g.count > 1 ? g.count : ""}</button>
                  ))}
                  <button className="reaction-add" onClick={(e) => { e.stopPropagation(); toggleReaction(msg.id, "👍"); }}>👍</button>
                  <button className="reaction-add" onClick={(e) => { e.stopPropagation(); toggleReaction(msg.id, "❤️"); }}>❤️</button>
                  <button className="reaction-add" onClick={(e) => { e.stopPropagation(); toggleReaction(msg.id, "😂"); }}>😂</button>
                  <button className="reaction-add" onClick={(e) => { e.stopPropagation(); toggleReaction(msg.id, "😮"); }}>😮</button>
                  <button className="reaction-add" onClick={(e) => { e.stopPropagation(); toggleReaction(msg.id, "😢"); }}>😢</button>
                  <button className="reaction-add" onClick={(e) => { e.stopPropagation(); toggleReaction(msg.id, "😡"); }}>😡</button>
                </div>
              </div>
            );
          })}
          <div ref={messagesEnd} />
        </div>

        {(typingUsers[activeRoom?.id || ""] || []).length > 0 && (
          <div className="typing-indicator">
            <div className="typing-dots"><span className="dot1" /><span className="dot2" /><span className="dot3" /></div>
            {typingUsers[activeRoom?.id || ""].map(u => (members.find(m => m.userId === u)?.displayName || u.slice(0, 6))).join(", ")} sedang mengetik…
          </div>
        )}

        <form className="input-bar" onSubmit={handleSend}>
          <span className="input-prefix">{activeRoom ? `#${activeRoom.name.slice(1)}` : ""}</span>
          <div className="input-wrap">
            {suggestions.length > 0 && (
              <div className="autocomplete">
                {suggestions.map(c => (
                  <div key={c} className="ac-item" onClick={() => applySuggestion(c)}>/{c}</div>
                ))}
              </div>
            )}
            <input
              ref={inputRef}
              value={input}
              onChange={e => { handleInputChange(e.target.value); notifyTyping(); }}
              placeholder={activeRoom ? `Ketik pesan atau / bikin command…` : "Pilih ruangan dulu"}
              disabled={!activeRoom}
              autoFocus
            />
          </div>
          <button type="submit" className="btn-send" disabled={!input.trim() || !activeRoom}>▸</button>
        </form>
      </main>

      {/* ---- RIGHT SIDEBAR ---- */}
      <aside className="sidebar-right">
        <div className="member-list">
          {/* Anggota Hyperoom — semua user online (global) */}
          <div className="member-group">
            <div className="member-group-label clickable" onClick={() => setExpandGlobal(!expandGlobal)}>
              👥 Anggota Hyperoom <span className="group-count">({onlineUsers.filter(u => u.onlineNow).length} online)</span>
              <span className="caret">{expandGlobal ? "▾" : "▸"}</span>
            </div>
            {expandGlobal && (
              <div className="group-body">
                {onlineUsers.filter(u => u.onlineNow).map(u => (
                  <div key={u.id} className="member-item" onClick={() => fetchProfile(u.id)}>
                    <div className="member-avatar" style={{ background: nickColor(u.id) }}>
                      {u.avatarUrl ? <img src={resolveUrl(u.avatarUrl)} alt="" className="member-avatar-img" /> : <span>{(u.displayName || u.username)[0].toUpperCase()}</span>}
                      <span className="member-dot online" />
                    </div>
                    <div className="member-name" style={{ color: nickColor(u.id) }}>
                      {u.displayName || u.username}
                    </div>
                    {activeRoom && (activeRoom.type === "private" || activeRoom.isLocked) && !members.find(m => m.userId === u.id) && (
                      <button className="btn-invite-sm" onClick={(e) => { e.stopPropagation(); sendInvite(u.username); }}>Undang</button>
                    )}
                  </div>
                ))}
                {onlineUsers.filter(u => u.onlineNow).length === 0 && <div className="sidebar-empty">ga ada yang online</div>}
              </div>
            )}
          </div>

          {/* Anggota Room — anggota online di room ini */}
          <div className="member-group">
            <div className="member-group-label clickable" onClick={() => setExpandRoom(!expandRoom)}>
              🏠 Anggota Room <span className="group-count">({members.length})</span>
              <span className="caret">{expandRoom ? "▾" : "▸"}</span>
            </div>
            {expandRoom && (
              <div className="group-body">
                {(["owner", "admin", "operator", "voice", "member"] as const).map(role => {
                  const group = members.filter(m => m.role === role);
                  if (group.length === 0) return null;
                  const roleLabel: Record<string, string> = { owner: "Pemilik", admin: "Admin", operator: "Operator", voice: "Voice", member: "Anggota" };
                  return (
                    <div key={role}>
                      <div className="sub-role-label">{roleLabel[role]} ({group.length})</div>
                      {group.map(m => {
                        const pres = presenceMap.get(m.userId);
                        const isOnline = pres?.status === "online";
                        const nick = m.displayName || m.username || shortId(m.userId);
                        const prefix = m.role !== "member" ? rolePrefix(m.role) : "";
                        return (
                          <div key={m.userId} className="member-item" onClick={() => fetchProfile(m.userId)} style={{position: "relative"}}>
                            <div className="member-avatar" style={{ background: nickColor(m.userId) }}>
                              {m.avatarUrl ? <img src={resolveUrl(m.avatarUrl)} alt="" className="member-avatar-img" /> : <span>{nick[0].toUpperCase()}</span>}
                              <span className={`member-dot ${isOnline ? "online" : ""}`} />
                            </div>
                            <div className="member-name" style={{ color: nickColor(m.userId) }}>
                              <span className={`role-prefix ${m.role}`}>{prefix}</span>{nick}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {members.length === 0 && <div className="sidebar-empty">belum ada anggota</div>}
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Topic modal */}
      {topicOpen && (
        <div className="modal-overlay" onClick={() => setTopicOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Ubah topik #{activeRoom?.name?.slice(1)}</h3>
            <form onSubmit={saveTopic}>
              <input value={topicVal} onChange={e => setTopicVal(e.target.value)} placeholder="Topik ruangan…" autoFocus />
              <div className="modal-actions">
                <button type="button" className="btn-ghost" onClick={() => setTopicOpen(false)}>Batal</button>
                <button type="submit" className="btn-primary">Simpan</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Join private room password modal */}
      {joinPrompt && (
        <div className="modal-overlay" onClick={() => setJoinPrompt(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>🔒 Room privat #{joinPrompt.name.slice(1)}</h3>
            <p className="modal-sub">Masukkan password room atau tunggu undangan owner</p>
            <form onSubmit={submitJoinPassword}>
              <input type="password" value={joinPassword} onChange={e => setJoinPassword(e.target.value)} placeholder="Password room" autoFocus />
              {joinError && <div className="auth-error">{joinError}</div>}
              <div className="modal-actions">
                <button type="button" className="btn-ghost" onClick={() => setJoinPrompt(null)}>Batal</button>
                <button type="submit" className="btn-primary">Masuk</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Invite modal */}
      {inviteModal && (
        <div className="modal-overlay" onClick={() => setInviteModal(false)}>
          <div className="modal invite-modal" onClick={e => e.stopPropagation()}>
            <h3>✉️ Undang ke #{activeRoom?.name.slice(1)}</h3>
            {inviteMsg && <div className="invite-msg">{inviteMsg}</div>}
            <div className="invite-list">
              {onlineUsers.filter(u => u.id !== user?.id).map(u => {
                const inRoom = members.find(m => m.userId === u.id);
                return (
                  <div key={u.id} className="invite-item">
                    <div className="member-avatar" style={{ background: nickColor(u.id) }}>
                      <span>{(u.displayName || u.username)[0].toUpperCase()}</span>
                      <span className={`member-dot ${u.onlineNow ? "online" : ""}`} />
                    </div>
                    <div className="invite-name">
                      <div>{u.displayName || u.username}</div>
                      <div className="invite-sub">{u.onlineNow ? "online" : "offline"} • {u.rooms?.length || 0} room</div>
                    </div>
                    {inRoom ? (
                      <span className="invite-state">di room</span>
                    ) : (
                      <button className="btn-invite-sm" onClick={() => sendInvite(u.username)}>Undang</button>
                    )}
                  </div>
                );
              })}
              {onlineUsers.filter(u => u.id !== user?.id).length === 0 && <div className="empty">belum ada user</div>}
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setInviteModal(false)}>Tutup</button>
            </div>
          </div>
        </div>
      )}

      {/* Profile modal */}
      {profileUser && (
        <div className="modal-overlay" onClick={() => setProfileUser(null)}>
          <div className="modal profile-modal" onClick={e => e.stopPropagation()}>
            <div className="profile-head">
                {profileUser.avatarUrl
                  ? <img src={resolveUrl(profileUser.avatarUrl)} alt="avatar" className="profile-avatar" />
                  : <div className="profile-avatar profile-avatar-ph" style={{ background: nickColor(profileUser.id) }}>{profileUser.username[0].toUpperCase()}</div>
                }
                <div className="profile-head-info">
                  <h3>{profileUser.displayName || profileUser.username}</h3>
                  <div className="profile-username">@{profileUser.username}</div>
                  {profileUser.platformRole && <span className="profile-role">{profileUser.platformRole}</span>}
                  {isProfileSelf && editProfile && <button className="avatar-upload-btn" onClick={() => avatarInputRef.current?.click()}>📷 Ganti Avatar</button>}
                  <input ref={avatarInputRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={e => { if (e.target.files?.[0]) uploadAvatar(e.target.files[0]); }} />
                </div>
              </div>
              {editProfile ? (
                <div className="profile-edit">
                  <label>Nama Tampilan<input value={editName} onChange={e => setEditName(e.target.value)} /></label>
                  <label>Bio<input value={editBio} onChange={e => setEditBio(e.target.value)} placeholder="Cerita dikit tentang lo…" /></label>
                  <label>Status<input value={editStatus} onChange={e => setEditStatus(e.target.value)} placeholder="Lagi apa?" /></label>
                  <div className="modal-actions">
                    <button className="btn-ghost" onClick={() => setEditProfile(false)}>Batal</button>
                    <button className="btn-primary" onClick={saveProfile}>Simpan</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="profile-body">
                    <div className="profile-row"><span>Bio</span><span>{profileUser.bio || "—"}</span></div>
                    <div className="profile-row"><span>Status</span><span>{profileUser.status || "—"}</span></div>
                    <div className="profile-row"><span>Gabung</span><span>{fmtTime(profileUser.createdAt)}</span></div>
                    {profileUser.rooms && profileUser.rooms.length > 0 && (
                      <div className="profile-row">
                        <span>Room</span>
                        <span className="profile-rooms">
                          {profileUser.rooms.map((r: any) => (
                            <span key={r.name} className="profile-room-tag">#{r.name.slice(1)} ({r.role})</span>
                          ))}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="profile-actions">
                    {!isProfileSelf && (
                      <>
                        <button className="btn-primary btn-dm" onClick={() => { openDm(profileUser.username); setProfileUser(null); }}>💬 Pesan</button>
                        {user?.id === activeRoom?.ownerId && (
                          <>
                            <button className="btn-primary btn-promote" onClick={() => { doMod("op", profileUser.username); setProfileUser(null); }}>⬆️ Promote</button>
                            <button className="btn-danger" onClick={() => { doMod("kick", profileUser.username); setProfileUser(null); }}>❌ Kick</button>
                            <button className="btn-danger" onClick={() => { doMod("mute", profileUser.username); setProfileUser(null); }}>🔇 Mute</button>
                          </>
                        )}
                      </>
                    )}
                    {isProfileSelf && (
                      <>
                        <button className="btn-primary" onClick={openEditProfile}>✏️ Edit Profil</button>
                        <button className="btn-ghost" onClick={() => setProfileUser(null)}>Tutup</button>
                      </>
                    )}
                  </div>
                  {!isProfileSelf && <div className="modal-actions"><button className="btn-ghost" onClick={() => setProfileUser(null)}>Tutup</button></div>}
                </>
              )}
          </div>
        </div>
      )}
    </div>
  );
}