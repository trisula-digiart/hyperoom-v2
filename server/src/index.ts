import "dotenv/config";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { pools, checkZone } from "./db.js";
import { hashPassword, verifyPassword, signToken, verifyToken } from "./auth.js";
import {
  createUser, findUserByUsername, findUserById,
  createRoom, listRoomsForUser, findRoomById, findRoomByName,
  joinRoom, leaveRoom, getMemberRole, listRoomMembers, listRoomMembersDetailed, setRoomTopic, isRoomMember,
  insertMessage, listMessages, editMessage, deleteMessage, findMessage,
  setPresence, getPresence, touchUserSeen,
} from "./repository.js";
import { HyperoomRealtime } from "./realtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// JSON parse error → JSON response (no HTML stack leak)
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "JSON tidak valid" });
    return;
  }
  next(err);
});

// Simple rate limiting (per IP, sliding window) — anti brute force / flood
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(limit: number, windowMs: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    let bucket = rateBuckets.get(ip);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(ip, bucket);
    }
    bucket.count++;
    if (bucket.count > limit) {
      res.status(429).json({ error: "Terlalu banyak request, coba lagi nanti" });
      return;
    }
    next();
  };
}
// cleanup buckets periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) if (b.resetAt < now) rateBuckets.delete(ip);
}, 60000).unref();

// Apply stricter limit to auth endpoints
app.post("/api/auth/login", rateLimit(20, 60000)); // 20 login/min/IP
app.post("/api/auth/signup", rateLimit(10, 60000)); // 10 signup/min/IP

const server = http.createServer(app);
const realtime = new HyperoomRealtime(server);
const startedAt = Date.now();

// ---- auth middleware ----
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }
  (req as express.Request & { userId?: string; username?: string }).userId = payload.sub;
  (req as express.Request & { userId?: string; username?: string }).username = payload.username;
  next();
}

// ---------- AUTH ----------
app.post("/api/auth/signup", async (req, res) => {
  const { username, password, displayName, phone } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username dan password wajib" });
  if (password.length < 6) return res.status(400).json({ error: "password minimal 6 karakter" });
  if (username.length < 2) return res.status(400).json({ error: "nickname minimal 2 karakter" });
  if (username.length > 20) return res.status(400).json({ error: "nickname maksimal 20 karakter" });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: "nickname hanya huruf, angka, underscore" });
  if (phone && !/^[0-9+\-\s]{8,16}$/.test(phone)) return res.status(400).json({ error: "nomor HP tidak valid" });
  try {
    const existing = await findUserByUsername(username);
    if (existing) return res.status(409).json({ error: "nickname sudah dipakai" });
    const hash = await hashPassword(password);
    const profile = await createUser(username, hash, displayName, phone);
    const token = signToken({ id: profile.id, username: profile.username, displayName: profile.displayName ?? null, avatarUrl: profile.avatarUrl ?? null, platformRole: profile.platformRole });
    res.status(201).json({ token, user: { id: profile.id, username: profile.username, displayName: profile.displayName ?? undefined, platformRole: profile.platformRole, createdAt: profile.createdAt } });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: "nickname atau nomor HP sudah dipakai" });
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username dan password wajib" });
  const user = await findUserByUsername(username);
  if (!user) return res.status(401).json({ error: "nickname atau password salah" });
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "nickname atau password salah" });
  await pools.core.query(`UPDATE public.users SET last_seen_at = now() WHERE id = $1`, [user.id]);
  const token = signToken({ id: user.id, username: user.username, displayName: user.display_name, avatarUrl: user.avatar_url, platformRole: user.platform_role });
  res.json({ token, user: { id: user.id, username: user.username, displayName: user.display_name ?? undefined, avatarUrl: user.avatar_url ?? undefined, platformRole: user.platform_role, createdAt: user.created_at } });
});

app.get("/api/me", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const user = await findUserById(req2.userId);
  if (!user) return res.status(404).json({ error: "user tidak ditemukan" });
  res.json({ user: { id: user.id, username: user.username, displayName: user.display_name ?? undefined, avatarUrl: user.avatar_url ?? undefined, platformRole: user.platform_role, createdAt: user.created_at } });
});

app.patch("/api/me/nick", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const { displayName } = req.body || {};
  if (!displayName || !displayName.trim()) return res.status(400).json({ error: "displayName required" });
  await pools.core.query(`UPDATE public.users SET display_name = $2, updated_at = now() WHERE id = $1`, [req2.userId, displayName.trim()]);
  res.json({ ok: true });
});

// ---------- ROOMS ----------
app.get("/api/rooms", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const rooms = await listRoomsForUser(req2.userId);
  res.json({ rooms });
});

app.post("/api/rooms", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const { name, type, topic } = req.body || {};
  if (!name || !type) return res.status(400).json({ error: "name and type required" });
  const normalized = name.startsWith("#") ? name : "#" + name;
  try {
    const room = await createRoom(normalized, type, req2.userId, topic);
    realtime.broadcastToRoom(room.id, { type: "room:join", roomId: room.id, member: { roomId: room.id, userId: req2.userId, role: "owner", joinedAt: new Date().toISOString() } });
    res.status(201).json({ room });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return res.status(409).json({ error: "room name taken" });
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/rooms/:id/join", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const room = await findRoomById(req.params.id);
  if (!room) return res.status(404).json({ error: "ruangan tidak ditemukan" });
  if (room.isLocked) {
    const role = await getMemberRole(room.id, req2.userId);
    if (!role) return res.status(403).json({ error: "ruangan terkunci, undangan diperlukan" });
  }
  const member = await joinRoom(room.id, req2.userId);
  // real join event: system message + broadcast
  const user = await findUserById(req2.userId);
  const nick = user?.display_name || user?.username || "seseorang";
  const sysMsg = await insertMessage(room.id, req2.userId, `*** ${nick} gabung ke ${room.name}`, "system");
  realtime.broadcastToRoom(room.id, { type: "room:join", roomId: room.id, member });
  realtime.broadcastToRoom(room.id, { type: "message:new", message: sysMsg });
  res.json({ room, member });
});

app.post("/api/rooms/:id/leave", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const room = await findRoomById(req.params.id);
  if (room) {
    const user = await findUserById(req2.userId);
    const nick = user?.display_name || user?.username || "seseorang";
    const sysMsg = await insertMessage(room.id, req2.userId, `*** ${nick} keluar dari ${room.name}`, "system");
    realtime.broadcastToRoom(room.id, { type: "message:new", message: sysMsg });
  }
  await leaveRoom(req.params.id, req2.userId);
  realtime.broadcastToRoom(req.params.id, { type: "room:leave", roomId: req.params.id, userId: req2.userId });
  res.json({ ok: true });
});

app.get("/api/rooms/:id/members", requireAuth, async (req, res) => {
  const members = await listRoomMembersDetailed(req.params.id);
  res.json({ members });
});

// PATCH /api/rooms/:id — topic, lock (owner/operator)
app.patch("/api/rooms/:id", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const room = await findRoomById(req.params.id);
  if (!room) return res.status(404).json({ error: "ruangan tidak ditemukan" });
  const role = await getMemberRole(room.id, req2.userId);
  const isOwner = role === "owner" || role === "admin";
  if (!isOwner) return res.status(403).json({ error: "hanya pemilik yang bisa ubah ini" });

  const { topic, isLocked } = req.body || {};
  if (typeof topic === "string") {
    await setRoomTopic(room.id, topic.trim() || null);
  }
  if (typeof isLocked === "boolean") {
    await pools.core.query(`UPDATE public.rooms SET is_locked = $2, updated_at = now() WHERE id = $1`, [room.id, isLocked]);
  }
  const updated = await findRoomById(room.id);
  // system message broadcast (real event)
  const sysMsg = await insertMessage(room.id, req2.userId, `Topik ruangan: ${room.topic ?? "(kosong)"}`, "system");
  realtime.broadcastToRoom(room.id, { type: "message:new", message: sysMsg });
  res.json({ room: updated });
});

// ---------- MESSAGES ----------
app.get("/api/rooms/:id/messages", requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || "100"), 10), 500);
  const messages = await listMessages(req.params.id, limit);
  res.json({ messages });
});

app.post("/api/rooms/:id/messages", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const { content, kind, replyToMessageId } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: "content required" });
  const room = await findRoomById(req.params.id);
  if (!room) return res.status(404).json({ error: "ruangan tidak ditemukan" });
  let role = await getMemberRole(req.params.id, req2.userId);
  if (!role) {
    // Auto-join public room when posting (real membership, like viewing)
    if (room.type === "public" && !room.isLocked) {
      await joinRoom(req.params.id, req2.userId);
      role = "member";
      const user = await findUserById(req2.userId);
      const nick = user?.display_name || user?.username || "seseorang";
      const sysMsg = await insertMessage(req.params.id, req2.userId, `*** ${nick} gabung ke ${room.name}`, "system");
      realtime.broadcastToRoom(req.params.id, { type: "room:join", roomId: req.params.id, member: { roomId: req.params.id, userId: req2.userId, role: "member", joinedAt: new Date().toISOString() } });
      realtime.broadcastToRoom(req.params.id, { type: "message:new", message: sysMsg });
    } else {
      return res.status(403).json({ error: "not a member of this room" });
    }
  }
  const message = await insertMessage(req.params.id, req2.userId, content.trim(), kind || "text", replyToMessageId);
  realtime.broadcastToRoom(message.roomId, { type: "message:new", message });
  res.status(201).json({ message });
});

app.patch("/api/messages/:id", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: "content required" });
  const msg = await findMessage(req.params.id);
  if (!msg) return res.status(404).json({ error: "message not found" });
  if (msg.author_id !== req2.userId) return res.status(403).json({ error: "not your message" });
  const updated = await editMessage(msg.id, content.trim());
  realtime.broadcastToRoom(updated.roomId, { type: "message:edit", message: updated });
  res.json({ message: updated });
});

app.delete("/api/messages/:id", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const msg = await findMessage(req.params.id);
  if (!msg) return res.status(404).json({ error: "message not found" });
  const role = await getMemberRole(msg.room_id, req2.userId);
  const isAuthor = msg.author_id === req2.userId;
  const canModerate = role === "owner" || role === "admin" || role === "operator";
  if (!isAuthor && !canModerate) return res.status(403).json({ error: "not allowed" });
  await deleteMessage(msg.id);
  realtime.broadcastToRoom(msg.room_id, { type: "message:delete", roomId: msg.room_id, messageId: msg.id });
  res.json({ ok: true });
});

// ---------- PRESENCE ----------
app.post("/api/presence", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const { status } = req.body || {};
  const normalized = status === "idle" ? "idle" : status === "offline" ? "offline" : "online";
  const presence = await setPresence(req2.userId, normalized);
  realtime.broadcast({ type: "presence:update", presence });
  res.json({ presence });
});

// ---------- HEALTH / MONITOR ----------
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "hyperoom-server", uptime: Math.round((Date.now() - startedAt) / 1000), ts: new Date().toISOString() });
});

app.get("/health/db", async (req, res) => {
  const [core, chat, storage] = await Promise.all([checkZone("core"), checkZone("chat"), checkZone("storage")]);
  res.json({ core: core.status.toLowerCase(), chat: chat.status.toLowerCase(), storage: storage.status.toLowerCase() });
});

app.get("/monitor", async (req, res) => {
  res.json({
    uptime: Math.round((Date.now() - startedAt) / 1000),
    realtime: realtime.stats,
    memory: process.memoryUsage(),
    db: await Promise.all([checkZone("core"), checkZone("chat"), checkZone("storage")]),
  });
});

// ---------- ADMIN OVERVIEW (dashboard, public read-only) ----------
// Public dashboard: non-sensitive aggregate + room info. No phone, no tokens.
app.get("/api/admin/overview", async (req, res) => {
  try {
    const users = await pools.core.query(
      `SELECT id, username, display_name, platform_role,
              (last_seen_at > now() - interval '5 minutes') AS online_now
       FROM public.users ORDER BY created_at`
    );
    const rooms = await pools.core.query(
      `SELECT r.id, r.name, r.type, r.topic, r.is_locked, r.created_at,
              u.username AS owner_username,
              (SELECT count(*) FROM public.room_members m WHERE m.room_id = r.id) AS member_count
       FROM public.rooms r
       LEFT JOIN public.users u ON u.id = r.owner_id
       ORDER BY r.name`
    );
    const msgs = await pools.chat.query(
      `SELECT id, room_id, author_id, kind, content, created_at
       FROM public.messages ORDER BY created_at DESC LIMIT 20`
    );
    const userMap = new Map(users.rows.map((u) => [u.id, u.display_name || u.username]));
    const recentMessages = msgs.rows.map((m) => ({
      id: m.id,
      roomId: m.room_id,
      kind: m.kind,
      content: m.content,
      createdAt: m.created_at,
      author: userMap.get(m.author_id) || m.author_id.slice(0, 8),
    }));
    res.json({
      counts: {
        users: users.rows.length,
        onlineNow: users.rows.filter((u) => u.online_now).length,
        rooms: rooms.rows.length,
        messages: (await pools.chat.query(`SELECT count(*)::int AS c FROM public.messages`)).rows[0].c,
      },
      users: users.rows.slice(0, 50),
      rooms: rooms.rows,
      recentMessages,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Dashboard static (premium, bright — consistent with app)
app.use(express.static(path.join(__dirname, "..", "public"), {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  },
}));
app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

const port = config.port;
server.listen(port, config.host, () => {
  console.log(`[hyperoom-v2] listening on http://${config.host}:${port} (${config.env})`);
  console.log(`[hyperoom-v2] realtime ws  on ws://${config.host}:${port}/realtime`);
});

// Retry DB connection at startup (postgres may still be booting)
async function waitForDb() {
  for (let i = 1; i <= 15; i++) {
    try {
      await pools.core.query("SELECT 1");
      await pools.chat.query("SELECT 1");
      await pools.storage.query("SELECT 1");
      console.log("[hyperoom-v2] database ready");
      return;
    } catch (err) {
      console.log(`[hyperoom-v2] waiting for database... (${i}/15) ${(err as Error).message.slice(0, 60)}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.log("[hyperoom-v2] WARNING: database not ready after 30s — server masih jalan, DB retry dilanjut");
}
void waitForDb();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[hyperoom-v2] ${sig} — shutting down`);
    realtime.close();
    for (const p of Object.values(pools)) void p.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}