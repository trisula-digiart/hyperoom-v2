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
  joinRoom, leaveRoom, getMemberRole, listRoomMembers,
  insertMessage, listMessages, editMessage, deleteMessage, findMessage,
  setPresence, getPresence,
} from "./repository.js";
import { HyperoomRealtime } from "./realtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

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
  if (!room) return res.status(404).json({ error: "room not found" });
  const member = await joinRoom(room.id, req2.userId);
  realtime.broadcastToRoom(room.id, { type: "room:join", roomId: room.id, member });
  // add socket subscription when WS present? handled client-side via WS join
  res.json({ room, member });
});

app.post("/api/rooms/:id/leave", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  await leaveRoom(req.params.id, req2.userId);
  realtime.broadcastToRoom(req.params.id, { type: "room:leave", roomId: req.params.id, userId: req2.userId });
  res.json({ ok: true });
});

app.get("/api/rooms/:id/members", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const room = await findRoomById(req.params.id);
  if (!room) return res.status(404).json({ error: "ruangan tidak ditemukan" });
  // Auto-join public room on view (real membership row, persistent)
  if (room.type === "public") {
    const role = await getMemberRole(room.id, req2.userId);
    if (!role) {
      const member = await joinRoom(room.id, req2.userId);
      realtime.broadcastToRoom(room.id, { type: "room:join", roomId: room.id, member });
    }
  }
  const members = await listRoomMembers(req.params.id);
  res.json({ members });
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
  const role = await getMemberRole(req.params.id, req2.userId);
  if (!role) return res.status(403).json({ error: "not a member of this room" });
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

const port = config.port;
server.listen(port, config.host, () => {
  console.log(`[hyperoom-v2] listening on http://${config.host}:${port} (${config.env})`);
  console.log(`[hyperoom-v2] realtime ws  on ws://${config.host}:${port}/realtime`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[hyperoom-v2] ${sig} — shutting down`);
    realtime.close();
    for (const p of Object.values(pools)) void p.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}