import type { Message, Presence, Profile, Room, RoomMember, RoomRole } from "@hyperoom/domain";
import { pools } from "./db.js";

export interface DbUser {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  avatar_url: string | null;
  platform_role: string;
  phone: string | null;
  last_seen_at: string | null;
  bio: string | null;
  status: string | null;
  created_at: string;
}

function rowToProfile(r: DbUser): Profile {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name ?? undefined,
    avatarUrl: r.avatar_url ?? undefined,
    createdAt: r.created_at,
  };
}

// ---------- AUTH / USERS (core) ----------

export async function createUser(username: string, passwordHash: string, displayName?: string, phone?: string): Promise<Profile & { platformRole: string }> {
  const r = await pools.core.query<DbUser>(
    `INSERT INTO public.users (username, password_hash, display_name, phone, platform_role)
     VALUES ($1, $2, $3, $4, (SELECT CASE WHEN count(*) = 0 THEN 'platform_owner' ELSE 'member' END FROM public.users))
     RETURNING *`,
    [username, passwordHash, displayName ?? null, phone ?? null]
  );
  return { ...rowToProfile(r.rows[0]), platformRole: r.rows[0].platform_role };
}

export async function findUserByUsername(username: string): Promise<DbUser | null> {
  const r = await pools.core.query<DbUser>(
    `SELECT * FROM public.users WHERE username = $1`,
    [username]
  );
  return r.rows[0] ?? null;
}

export async function findUserByNickname(nick: string): Promise<DbUser | null> {
  const r = await pools.core.query<DbUser>(
    `SELECT * FROM public.users WHERE username = $1 OR display_name = $1`,
    [nick]
  );
  return r.rows[0] ?? null;
}

// ---------- IGNORE (core) ----------

export async function setDisplayName(userId: string, displayName: string): Promise<void> {
  await pools.core.query(`UPDATE public.users SET display_name = $2, updated_at = now() WHERE id = $1`, [userId, displayName]);
}

export async function addIgnore(userId: string, ignoredUserId: string): Promise<void> {
  await pools.core.query(
    `INSERT INTO public.user_ignores (user_id, ignored_user_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, ignoredUserId]
  );
}

export async function removeIgnore(userId: string, ignoredUserId: string): Promise<void> {
  await pools.core.query(
    `DELETE FROM public.user_ignores WHERE user_id = $1 AND ignored_user_id = $2`,
    [userId, ignoredUserId]
  );
}

export async function listIgnores(userId: string): Promise<string[]> {
  const r = await pools.core.query<{ ignored_user_id: string }>(
    `SELECT ignored_user_id FROM public.user_ignores WHERE user_id = $1`,
    [userId]
  );
  return r.rows.map((x) => x.ignored_user_id);
}

export async function findUserById(id: string): Promise<DbUser | null> {
  const r = await pools.core.query<DbUser>(`SELECT * FROM public.users WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function touchUserSeen(userId: string): Promise<void> {
  await pools.core.query(`UPDATE public.users SET last_seen_at = now() WHERE id = $1`, [userId]);
}

// ---------- ROOMS (core) ----------

interface RoomRow {
  id: string;
  name: string;
  type: string;
  topic: string | null;
  is_locked: boolean;
  owner_id: string;
  password_hash: string | null;
  is_lobby: boolean;
  created_at: string;
}

function rowToRoom(r: RoomRow): Room {
  return {
    id: r.id,
    name: r.name,
    type: r.type as Room["type"],
    topic: r.topic ?? undefined,
    isLocked: r.is_locked,
    ownerId: r.owner_id,
    isLobby: r.is_lobby,
    createdAt: r.created_at,
  };
}

export async function createRoom(name: string, type: string, ownerId: string, topic?: string, passwordHash?: string | null, description?: string | null): Promise<Room> {
  const client = await pools.core.connect();
  try {
    await client.query("BEGIN");
    const room = await client.query<RoomRow>(
      `INSERT INTO public.rooms (name, type, topic, owner_id, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, type, topic ?? null, ownerId, passwordHash ?? null]
    );
    await client.query(
      `INSERT INTO public.room_members (room_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [room.rows[0].id, ownerId]
    );
    await client.query("COMMIT");
    return rowToRoom(room.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listRoomsForUser(userId: string): Promise<Room[]> {
  const r = await pools.core.query<RoomRow>(
    `SELECT r.* FROM public.rooms r
     LEFT JOIN public.room_members m ON m.room_id = r.id AND m.user_id = $1
     WHERE r.type = 'public' OR r.type = 'private' OR m.user_id IS NOT NULL
     ORDER BY r.is_lobby DESC, r.name`,
    [userId]
  );
  return r.rows.map(rowToRoom);
}

export async function findRoomById(id: string): Promise<Room | null> {
  const r = await pools.core.query<RoomRow>(`SELECT * FROM public.rooms WHERE id = $1`, [id]);
  return r.rows[0] ? rowToRoom(r.rows[0]) : null;
}

export async function findRoomByName(name: string): Promise<Room | null> {
  const r = await pools.core.query<RoomRow>(`SELECT * FROM public.rooms WHERE name = $1`, [name]);
  return r.rows[0] ? rowToRoom(r.rows[0]) : null;
}

export async function findLobbyRoom(): Promise<Room | null> {
  const r = await pools.core.query<RoomRow>(`SELECT * FROM public.rooms WHERE is_lobby = true LIMIT 1`);
  return r.rows[0] ? rowToRoom(r.rows[0]) : null;
}

export async function autoJoinLobby(userId: string): Promise<Room | null> {
  const lobby = await findLobbyRoom();
  if (!lobby) return null;
  await joinRoom(lobby.id, userId);
  return lobby;
}

export async function joinRoom(roomId: string, userId: string): Promise<RoomMember> {
  const r = await pools.core.query<{ room_id: string; user_id: string; role: string; joined_at: string }>(
    `INSERT INTO public.room_members (room_id, user_id, role)
     VALUES ($1, $2, 'member')
     ON CONFLICT (room_id, user_id) DO UPDATE SET role = room_members.role
     RETURNING room_id, user_id, role, joined_at`,
    [roomId, userId]
  );
  return { roomId: r.rows[0].room_id, userId: r.rows[0].user_id, role: r.rows[0].role as RoomRole, joinedAt: r.rows[0].joined_at };
}

export async function leaveRoom(roomId: string, userId: string): Promise<void> {
  await pools.core.query(`DELETE FROM public.room_members WHERE room_id = $1 AND user_id = $2`, [roomId, userId]);
}

export async function getMemberRole(roomId: string, userId: string): Promise<RoomRole | null> {
  const r = await pools.core.query<{ role: string }>(
    `SELECT role FROM public.room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, userId]
  );
  return r.rows[0] ? (r.rows[0].role as RoomRole) : null;
}

export async function setRoomTopic(roomId: string, topic: string | null): Promise<void> {
  await pools.core.query(`UPDATE public.rooms SET topic = $2, updated_at = now() WHERE id = $1`, [roomId, topic]);
}

export async function isRoomMember(roomId: string, userId: string): Promise<boolean> {
  const r = await pools.core.query(`SELECT 1 FROM public.room_members WHERE room_id = $1 AND user_id = $2`, [roomId, userId]);
  return (r.rowCount ?? 0) > 0;
}

export async function getRoomPasswordHash(roomId: string): Promise<string | null> {
  const r = await pools.core.query<{ password_hash: string | null }>(`SELECT password_hash FROM public.rooms WHERE id = $1`, [roomId]);
  return r.rows[0]?.password_hash ?? null;
}

// ---------- INVITES (core) ----------

export async function createInvite(roomId: string, userId: string, invitedBy: string): Promise<void> {
  await pools.core.query(
    `INSERT INTO public.room_invites (room_id, user_id, invited_by) VALUES ($1, $2, $3)
     ON CONFLICT (room_id, user_id) DO NOTHING`,
    [roomId, userId, invitedBy]
  );
}

export async function hasInvite(roomId: string, userId: string): Promise<boolean> {
  const r = await pools.core.query(`SELECT 1 FROM public.room_invites WHERE room_id = $1 AND user_id = $2`, [roomId, userId]);
  return (r.rowCount ?? 0) > 0;
}

export async function consumeInvite(roomId: string, userId: string): Promise<void> {
  await pools.core.query(`DELETE FROM public.room_invites WHERE room_id = $1 AND user_id = $2`, [roomId, userId]);
}

// ---------- AVATARS (storage) ----------

export async function setAvatar(userId: string, storagePath: string, mimeType: string, sizeBytes: number): Promise<void> {
  await pools.storage.query(
    `INSERT INTO public.avatars (user_id, storage_path, mime_type, size_bytes) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET storage_path = $2, mime_type = $3, size_bytes = $4, created_at = now()`,
    [userId, storagePath, mimeType, sizeBytes]
  );
}

export async function getAvatarPath(userId: string): Promise<string | null> {
  const r = await pools.storage.query<{ storage_path: string }>(`SELECT storage_path FROM public.avatars WHERE user_id = $1`, [userId]);
  return r.rows[0]?.storage_path ?? null;
}

async function listRoomMembersDetailed(roomId: string): Promise<(RoomMember & { username: string; displayName: string | null })[]> {
  const r = await pools.core.query(
    `SELECT m.room_id, m.user_id, m.role, m.joined_at, u.username, u.display_name
     FROM public.room_members m
     JOIN public.users u ON u.id = m.user_id
     WHERE m.room_id = $1 ORDER BY m.joined_at`,
    [roomId]
  );
  return r.rows.map((x) => ({
    roomId: x.room_id,
    userId: x.user_id,
    role: x.role as RoomRole,
    joinedAt: x.joined_at,
    username: x.username,
    displayName: x.display_name,
  }));
}

export async function listRoomMembers(roomId: string): Promise<RoomMember[]> {
  const r = await pools.core.query<{ room_id: string; user_id: string; role: string; joined_at: string }>(
    `SELECT room_id, user_id, role, joined_at FROM public.room_members WHERE room_id = $1 ORDER BY joined_at`,
    [roomId]
  );
  return r.rows.map((x) => ({ roomId: x.room_id, userId: x.user_id, role: x.role as RoomRole, joinedAt: x.joined_at }));
}

export { listRoomMembersDetailed };

// ---------- MESSAGES (chat) ----------

interface MessageRow {
  id: string;
  room_id: string;
  author_id: string;
  kind: string;
  content: string;
  reply_to_message_id: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    roomId: r.room_id,
    authorId: r.author_id,
    kind: r.kind as Message["kind"],
    content: r.content,
    replyToMessageId: r.reply_to_message_id,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
  };
}

export async function insertMessage(roomId: string, authorId: string, content: string, kind: string, replyTo?: string | null): Promise<Message> {
  const r = await pools.chat.query<MessageRow>(
    `INSERT INTO public.messages (room_id, author_id, kind, content, reply_to_message_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [roomId, authorId, kind, content, replyTo ?? null]
  );
  return rowToMessage(r.rows[0]);
}

export async function listMessages(roomId: string, limit = 100): Promise<Message[]> {
  const r = await pools.chat.query<MessageRow>(
    `SELECT * FROM public.messages WHERE room_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT $2`,
    [roomId, limit]
  );
  return r.rows.map(rowToMessage);
}

export async function editMessage(messageId: string, content: string): Promise<Message> {
  const r = await pools.chat.query<MessageRow>(
    `UPDATE public.messages SET content = $2, edited_at = now() WHERE id = $1 RETURNING *`,
    [messageId, content]
  );
  return rowToMessage(r.rows[0]);
}

export async function deleteMessage(messageId: string): Promise<void> {
  await pools.chat.query(`UPDATE public.messages SET deleted_at = now() WHERE id = $1`, [messageId]);
}

export async function findMessage(messageId: string): Promise<MessageRow | null> {
  const r = await pools.chat.query<MessageRow>(`SELECT * FROM public.messages WHERE id = $1`, [messageId]);
  return r.rows[0] ?? null;
}

// ---------- PRESENCE (chat) ----------

export async function setPresence(userId: string, status: string): Promise<Presence> {
  const r = await pools.chat.query<{ user_id: string; status: string; last_seen_at: string }>(
    `INSERT INTO public.presence (user_id, status, last_seen_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET status = $2, last_seen_at = now()
     RETURNING user_id, status, last_seen_at`,
    [userId, status]
  );
  return { userId: r.rows[0].user_id, status: r.rows[0].status as Presence["status"], lastSeenAt: r.rows[0].last_seen_at };
}

export async function getPresence(userId: string): Promise<Presence | null> {
  const r = await pools.chat.query<{ user_id: string; status: string; last_seen_at: string }>(
    `SELECT user_id, status, last_seen_at FROM public.presence WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] ? { userId: r.rows[0].user_id, status: r.rows[0].status as Presence["status"], lastSeenAt: r.rows[0].last_seen_at } : null;
}