import "dotenv/config";
import express from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import multer from "multer";
import bcrypt from "bcryptjs";
import { config } from "./config.js";
import { pools, checkZone } from "./db.js";
import { hashPassword, verifyPassword, signToken, verifyToken } from "./auth.js";
import {
  createUser, findUserByUsername, findUserById,
  createRoom, listRoomsForUser, findRoomById, findRoomByName,
  joinRoom, leaveRoom, getMemberRole, listRoomMembers, listRoomMembersDetailed, setRoomTopic, isRoomMember,
  insertMessage, listMessages, editMessage, deleteMessage, findMessage,
  setPresence, getPresence, touchUserSeen,
  getRoomPasswordHash, createInvite, hasInvite, consumeInvite,
  setAvatar, getAvatarPath, findLobbyRoom, autoJoinLobby,
  setMemberRole, banUser, unbanUser, isBanned, muteUser, unmuteUser, isMuted,
  findOrCreateDmRoom, addReaction, removeReaction, listReactions, listIgnores,
} from "./repository.js";
import { HyperoomRealtime } from "./realtime.js";
import { parseCommandLine, executeCommand } from "./commands.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- avatar upload ---
const AVATAR_DIR = path.join("H:", "HYPEROOM-SERVER", "storage", "public", "avatars");
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATAR_DIR),
    filename: (req, file, cb) => {
      const ext = (file.originalname.match(/\.(\w+)$/) || [])[1] || "jpg";
      const uid = (req as express.Request & { userId?: string }).userId || "anon";
      cb(null, `${uid}-${Date.now()}.${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("file harus gambar"));
  },
});

const app = express();
app.use(express.json());

// CORS — izinkan frontend Vercel/domain + semua origin dev
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

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
    // Cek nickname dulu (sebelum INSERT)
    const existing = await findUserByUsername(username);
    if (existing) return res.status(409).json({ error: `nickname "${username}" sudah dipakai` });

    // Cek HP dulu kalau diisi (sebelum INSERT, biar pesan spesifik)
    if (phone) {
      const dup = await pools.core.query(`SELECT 1 FROM public.users WHERE phone = $1`, [phone.trim()]);
      if ((dup.rowCount ?? 0) > 0) return res.status(409).json({ error: `nomor HP "${phone}" sudah didaftarkan sebelumnya` });
    }

    const hash = await hashPassword(password);
    const profile = await createUser(username, hash, displayName, phone);
    // auto-join lobby room untuk user baru
    const lobby = await autoJoinLobby(profile.id);
    if (lobby) {
      const nick = profile.displayName || profile.username || "someone";
      const sysMsg = await insertMessage(lobby.id, profile.id, `*** ${nick} has joined ${lobby.name}`, "system");
      realtime.broadcastToRoom(lobby.id, { type: "room:join", roomId: lobby.id, member: { roomId: lobby.id, userId: profile.id, role: "member", joinedAt: new Date().toISOString() } });
      realtime.broadcastToRoom(lobby.id, { type: "message:new", message: sysMsg });
    }
    const token = signToken({ id: profile.id, username: profile.username, displayName: profile.displayName ?? null, avatarUrl: profile.avatarUrl ?? null, platformRole: profile.platformRole });
    res.status(201).json({ token, user: { id: profile.id, username: profile.username, displayName: profile.displayName ?? undefined, platformRole: profile.platformRole, createdAt: profile.createdAt } });
  } catch (err) {
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
  // auto-join lobby (semua user yang login selalu di room utama)
  await autoJoinLobby(user.id);
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

// ignore list user (untuk filter UI)
app.get("/api/me/ignores", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const ids = await listIgnores(req2.userId);
  res.json({ ignoredUserIds: ids });
});

// ---------- ROOMS ----------
app.get("/api/rooms", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const rooms = await listRoomsForUser(req2.userId);
  res.json({ rooms });
});

app.post("/api/rooms", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const { name, type, topic, password } = req.body || {};
  if (!name || !type) return res.status(400).json({ error: "name dan type wajib" });
  const normalized = name.startsWith("#") ? name : "#" + name;
  let passwordHash: string | null = null;
  if (type === "private" || (password && password.length > 0)) {
    passwordHash = await hashPassword(password || "private");
  }
  try {
    const room = await createRoom(normalized, type, req2.userId, topic, passwordHash);
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
  const { password } = req.body || {};

  // banned user tidak bisa join (enforcement nyata)
  const banned = await isBanned(room.id, req2.userId);
  if (banned) return res.status(403).json({ error: "kamu di-ban dari room ini" });

  // sudah member? langsung boleh
  const existingRole = await getMemberRole(room.id, req2.userId);
  if (existingRole) {
    const member = { roomId: room.id, userId: req2.userId, role: existingRole, joinedAt: new Date().toISOString() };
    res.json({ room, member, alreadyMember: true });
    return;
  }

  // private room: butuh password ATAU invite
  if (room.type === "private") {
    const pwHash = await getRoomPasswordHash(room.id);
    if (pwHash) {
      const pwOk = password ? await verifyPassword(String(password), pwHash) : false;
      if (!pwOk) {
        // fallback: invite?
        const invited = await hasInvite(room.id, req2.userId);
        if (!invited) return res.status(403).json({ error: "password room salah, atau kamu belum diundang" });
        await consumeInvite(room.id, req2.userId);
      }
    }
  }
  if (room.isLocked) {
    const invited = await hasInvite(room.id, req2.userId);
    if (!invited) return res.status(403).json({ error: "ruangan terkunci, undangan diperlukan" });
    await consumeInvite(room.id, req2.userId);
  }

  const member = await joinRoom(room.id, req2.userId);
  // real join event: system message (mIRC style) + broadcast
  const user = await findUserById(req2.userId);
  const nick = user?.display_name || user?.username || "someone";
  const sysMsg = await insertMessage(room.id, req2.userId, `*** ${nick} has joined ${room.name}`, "system");
  realtime.broadcastToRoom(room.id, { type: "room:join", roomId: room.id, member });
  realtime.broadcastToRoom(room.id, { type: "message:new", message: sysMsg });
  res.json({ room, member });
});

app.post("/api/rooms/:id/leave", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const room = await findRoomById(req.params.id);
  if (room) {
    const user = await findUserById(req2.userId);
    const nick = user?.display_name || user?.username || "someone";
    const sysMsg = await insertMessage(room.id, req2.userId, `*** ${nick} has left ${room.name}`, "system");
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

// ---------- USERS ONLINE (global directory for invite) ----------
app.get("/api/users/online", requireAuth, async (req, res) => {
  const users = await pools.core.query(
    `SELECT u.id, u.username, u.display_name, u.platform_role, u.status,
            (u.last_seen_at > now() - interval '5 minutes') AS online_now
     FROM public.users u ORDER BY u.username`
  );
  const rooms = await pools.core.query(`SELECT id, name FROM public.rooms`);
  const memberships = await pools.core.query(
    `SELECT m.user_id, r.name, m.role FROM room_members m JOIN rooms r ON r.id = m.room_id`
  );
  const roomNameById = new Map(rooms.rows.map((r) => [r.id, r.name]));
  const membershipByUser = new Map<string, { name: string; role: string }[]>();
  for (const m of memberships.rows) {
    if (!membershipByUser.has(m.user_id)) membershipByUser.set(m.user_id, []);
    membershipByUser.get(m.user_id)!.push({ name: roomNameById.get(m.room_id) || "?", role: m.role });
  }
  const avatars = await pools.storage.query(`SELECT user_id, storage_path FROM public.avatars`);
  const avatarMap = new Map(avatars.rows.map((a: any) => [a.user_id, a.storage_path]));
  res.json({
    users: users.rows.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      platformRole: u.platform_role,
      onlineNow: u.online_now,
      avatarUrl: avatarMap.get(u.id) ? `/avatars/${path.basename(avatarMap.get(u.id))}` : null,
      rooms: membershipByUser.get(u.id) || [],
    })),
  });
});

// ---------- INVITES ----------
app.post("/api/rooms/:id/invite", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: "username wajib" });
  const room = await findRoomById(req.params.id);
  if (!room) return res.status(404).json({ error: "ruangan tidak ditemukan" });
  const role = await getMemberRole(room.id, req2.userId);
  if (role !== "owner" && role !== "admin") return res.status(403).json({ error: "hanya owner/admin yang bisa mengundang" });
  const target = await findUserByUsername(username);
  if (!target) return res.status(404).json({ error: `user "${username}" tidak ditemukan` });
  await createInvite(room.id, target.id, req2.userId);
  res.json({ ok: true, message: `${target.display_name || target.username} diundang ke ${room.name}` });
});

// ---------- PROFILES ----------
app.get("/api/users/:id", requireAuth, async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "user tidak ditemukan" });
  const avatarPath = await getAvatarPath(user.id);
  const memberOf = await pools.core.query(
    `SELECT r.name, m.role FROM room_members m JOIN rooms r ON r.id=m.room_id WHERE m.user_id = $1`,
    [user.id]
  );
  res.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      bio: user.bio,
      status: user.status,
      avatarUrl: avatarPath ? `/avatars/${path.basename(avatarPath)}` : null,
      createdAt: user.created_at,
      lastSeenAt: user.last_seen_at,
      platformRole: user.platform_role,
      rooms: memberOf.rows.map((r) => ({ name: r.name, role: r.role })),
    },
  });
});

app.patch("/api/users/me", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const { displayName, bio, status } = req.body || {};
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (typeof displayName === "string") { sets.push("display_name = $n"); vals.push(displayName.trim() || null); }
  if (typeof bio === "string") { sets.push("bio = $n"); vals.push(bio.trim() || null); }
  if (typeof status === "string") { sets.push("status = $n"); vals.push(status.trim() || null); }
  if (sets.length === 0) return res.status(400).json({ error: "tidak ada field diubah" });
  const query = `UPDATE public.users SET ${sets.map(s => s.replace("$n", `$${sets.indexOf(s) + 1}`)).join(", ")}, updated_at = now() WHERE id = $${sets.length + 1}`;
  await pools.core.query(query, [...vals, req2.userId]);
  res.json({ ok: true });
});

// avatar upload (multipart image)
app.post("/api/users/me/avatar", requireAuth, upload.single("avatar"), async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  if (!req.file) return res.status(400).json({ error: "avatar file wajib" });
  const relPath = path.join(AVATAR_DIR, req.file.filename);
  await setAvatar(req2.userId, relPath, req.file.mimetype, req.file.size);
  res.json({ ok: true, avatarUrl: `/avatars/${req.file.filename}` });
});

// serve avatars statis
app.use("/avatars", express.static(AVATAR_DIR, { setHeaders: (res) => res.setHeader("Cache-Control", "no-store") }));

// ---------- MODERATION (Phase 4) ----------
app.post("/api/rooms/:id/mod/:action", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const { username, reason } = req.body || {};
  const action = req.params.action;
  if (!username) return res.status(400).json({ error: "username wajib" });
  const room = await findRoomById(req.params.id);
  if (!room) return res.status(404).json({ error: "ruangan tidak ditemukan" });
  const myRole = await getMemberRole(room.id, req2.userId);
  const canModerate = myRole === "owner" || myRole === "admin";
  const canBan = myRole === "owner" || myRole === "admin" || myRole === "operator";
  const canOp = myRole === "owner";
  if (!canModerate && !(action === "ban" || action === "kick" || action === "mute" ? canBan : false)) {
    return res.status(403).json({ error: "tidak punya wewenang" });
  }
  const target = await findUserByUsername(username);
  if (!target) return res.status(404).json({ error: `user "${username}" tidak ditemukan` });
  if (target.id === req2.userId) return res.status(400).json({ error: "ga bisa aksi ke diri sendiri" });

  const targetRole = await getMemberRole(room.id, target.id);
  const targetUser = await findUserById(target.id);
  const nick = targetUser?.display_name || targetUser?.username || username;

  switch (action) {
    case "kick": {
      if (!targetRole) return res.status(400).json({ error: `${nick} bukan member room ini` });
      await leaveRoom(room.id, target.id);
      const sys = await insertMessage(room.id, target.id, `*** ${nick} has been kicked from ${room.name}`, "system");
      realtime.broadcastToRoom(room.id, { type: "message:new", message: sys });
      realtime.broadcastToRoom(room.id, { type: "room:leave", roomId: room.id, userId: target.id });
      res.json({ ok: true, message: `${nick} di-kick dari ${room.name}` });
      return;
    }
    case "ban": {
      if (!canBan) return res.status(403).json({ error: "cuma owner/admin/operator yang bisa ban" });
      await banUser(room.id, target.id, req2.userId, reason);
      const sys = await insertMessage(room.id, target.id, `*** ${nick} has been banned from ${room.name}${reason ? ` (${reason})` : ""}`, "system");
      realtime.broadcastToRoom(room.id, { type: "message:new", message: sys });
      realtime.broadcastToRoom(room.id, { type: "room:leave", roomId: room.id, userId: target.id });
      res.json({ ok: true, message: `${nick} di-ban dari ${room.name}` });
      return;
    }
    case "unban": {
      await unbanUser(room.id, target.id);
      res.json({ ok: true, message: `${nick} di-unban` });
      return;
    }
    case "mute": {
      await muteUser(room.id, target.id, req2.userId, reason);
      const sys = await insertMessage(room.id, target.id, `*** ${nick} has been muted in ${room.name}`, "system");
      realtime.broadcastToRoom(room.id, { type: "message:new", message: sys });
      res.json({ ok: true, message: `${nick} di-mute` });
      return;
    }
    case "unmute": {
      await unmuteUser(room.id, target.id);
      res.json({ ok: true, message: `${nick} di-unmute` });
      return;
    }
    case "op": case "admin": {
      if (!canOp) return res.status(403).json({ error: "cuma owner yang bisa promote" });
      if (!targetRole) return res.status(400).json({ error: `${nick} bukan member` });
      await setMemberRole(room.id, target.id, "admin");
      res.json({ ok: true, message: `${nick} di-promote jadi admin` });
      return;
    }
    case "deop": case "deadmin": {
      if (!canOp) return res.status(403).json({ error: "cuma owner yang bisa demote" });
      await setMemberRole(room.id, target.id, "member");
      res.json({ ok: true, message: `${nick} di-demote jadi member` });
      return;
    }
    case "voice": {
      if (!canOp) return res.status(403).json({ error: "cuma owner yang bisa voice" });
      if (!targetRole) return res.status(400).json({ error: `${nick} bukan member` });
      await setMemberRole(room.id, target.id, "voice");
      res.json({ ok: true, message: `${nick} di-set voice` });
      return;
    }
    case "devoice": {
      if (!canOp) return res.status(403).json({ error: "cuma owner yang bisa devoice" });
      await setMemberRole(room.id, target.id, "member");
      res.json({ ok: true, message: `${nick} di-unvoice` });
      return;
    }
    default:
      res.status(400).json({ error: `action ${action} tidak dikenal` });
  }
});

// ---------- DM (Phase 5) ----------
app.post("/api/dm", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: "username wajib" });
  const target = await findUserByUsername(username);
  if (!target) return res.status(404).json({ error: `user "${username}" tidak ditemukan` });
  const room = await findOrCreateDmRoom(req2.userId, target.id);
  res.json({ room });
});

// ---------- REACTIONS (Phase 5) ----------
app.post("/api/messages/:id/reactions", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const { emoji } = req.body || {};
  if (!emoji) return res.status(400).json({ error: "emoji wajib" });
  const msg = await findMessage(req.params.id);
  if (!msg) return res.status(404).json({ error: "pesan tidak ditemukan" });
  await addReaction(msg.id, req2.userId, emoji);
  const reactions = await listReactions(msg.id);
  realtime.broadcastToRoom(msg.room_id, { type: "reaction:add", reaction: { messageId: msg.id, userId: req2.userId, emoji, createdAt: new Date().toISOString() } });
  res.json({ reactions });
});

app.delete("/api/messages/:id/reactions", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const { emoji } = req.body || {};
  if (!emoji) return res.status(400).json({ error: "emoji wajib" });
  const msg = await findMessage(req.params.id);
  if (!msg) return res.status(404).json({ error: "pesan tidak ditemukan" });
  await removeReaction(msg.id, req2.userId, emoji);
  const reactions = await listReactions(msg.id);
  realtime.broadcastToRoom(msg.room_id, { type: "reaction:remove", messageId: msg.id, emoji, userId: req2.userId });
  res.json({ reactions });
});

// ---------- COMMANDS (IRC engine) ----------
app.post("/api/commands", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const { input } = req.body || {};
  if (!input || typeof input !== "string") return res.status(400).json({ error: "input required" });
  const cmd = parseCommandLine(input);
  if (!cmd) return res.status(400).json({ error: "bukan command (tanpa /)" });
  const result = await executeCommand({ userId: req2.userId, realtime, currentRoomId: req.body.roomId || null }, cmd);
  res.json(result);
});

// ---------- MESSAGES ----------
app.get("/api/rooms/:id/messages", requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || "100"), 10), 500);
  const messages = await listMessages(req.params.id, limit);
  // resolve author nicknames (core users) — so UI shows names not UUIDs
  const ids = [...new Set(messages.map((m) => m.authorId))];
  const users = await pools.core.query(
    `SELECT id, username, display_name FROM public.users WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  const nameMap = new Map(users.rows.map((u) => [u.id, u.display_name || u.username]));
  const enriched = messages.map((m) => {
    const mentionMatch = m.content.match(/@([a-zA-Z0-9_]{2,20})/g) || [];
    return {
      ...m,
      authorName: nameMap.get(m.authorId) || m.authorId.slice(0, 8),
      mentions: mentionMatch.map((x: string) => x.slice(1)).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i),
    };
  });
  res.json({ messages: enriched });
});

app.post("/api/rooms/:id/messages", requireAuth, async (req, res) => {
  const req2 = req as express.Request & { userId: string };
  const { content, kind, replyToMessageId } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: "content required" });
  const room = await findRoomById(req.params.id);
  if (!room) return res.status(404).json({ error: "ruangan tidak ditemukan" });
  // moderation enforcement: banned / muted tidak bisa kirim
  const banned = await isBanned(req.params.id, req2.userId);
  if (banned) return res.status(403).json({ error: "kamu di-ban dari room ini" });
  const muted = await isMuted(req.params.id, req2.userId);
  if (muted) return res.status(403).json({ error: "kamu di-mute di room ini" });
  let role = await getMemberRole(req.params.id, req2.userId);
  if (!role) {
    // Auto-join public room when posting (real membership) — idempotent
    if (room.type === "public" && !room.isLocked) {
      await joinRoom(req.params.id, req2.userId);
      role = "member";
      const user = await findUserById(req2.userId);
      const nick = user?.display_name || user?.username || "someone";
      const sysMsg = await insertMessage(req.params.id, req2.userId, `*** ${nick} has joined ${room.name}`, "system");
      realtime.broadcastToRoom(req.params.id, { type: "room:join", roomId: req.params.id, member: { roomId: req.params.id, userId: req2.userId, role: "member", joinedAt: new Date().toISOString() } });
      realtime.broadcastToRoom(req.params.id, { type: "message:new", message: sysMsg });
    } else {
      return res.status(403).json({ error: "not a member of this room" });
    }
  }
  const message = await insertMessage(req.params.id, req2.userId, content.trim(), kind || "text", replyToMessageId);
  const author = await findUserById(req2.userId);
  // detect mentions @username di content (real)
  const mentionMatch = content.match(/@([a-zA-Z0-9_]{2,20})/g) || [];
  const mentions = mentionMatch.map((m: string) => m.slice(1)).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
  const msgWithName = { ...message, authorName: author?.display_name || author?.username || message.authorId.slice(0, 8), mentions };
  realtime.broadcastToRoom(message.roomId, { type: "message:new", message: msgWithName });
  res.status(201).json({ message: msgWithName });
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

// ---------- STATIC (PWA app + dashboard) ----------
// PWA app di / (dari build apps/pwa/dist)
const PWA_DIST = path.join("H:", "TRISULA_DIGIART", "hyperoom-v2", "apps", "pwa", "dist");
app.use(express.static(PWA_DIST, {
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0"),
}));
app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.sendFile(path.join(PWA_DIST, "index.html"));
});
// dashboard monitor di /dashboard
app.use("/dashboard", express.static(path.join(__dirname, "..", "public"), {
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0"),
}));
app.get("/dashboard", (req, res) => {
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