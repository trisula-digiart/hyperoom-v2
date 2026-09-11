// HYPEROOM v2 — IRC command engine (Phase 3)
// Parse + execute mIRC-style commands against real backend state.
// Semua hasil = operasi DB/runtime nyata + realtime event. Bukan fake UI.

import type { RealtimeEvent } from "@hyperoom/domain";
import {
  findUserByNickname, findUserById, findRoomByName, findRoomById,
  joinRoom, leaveRoom, getMemberRole, setRoomTopic, insertMessage,
  addIgnore, removeIgnore, listIgnores, setDisplayName,
} from "./repository.js";
import type { HyperoomRealtime } from "./realtime.js";

export interface CommandContext {
  userId: string;
  realtime: HyperoomRealtime;
  currentRoomId?: string | null;
}

export interface CommandResult {
  ok: boolean;
  reply?: string;        // system message / reply ke sender
  roomId?: string;       // kalau command afect room
  event?: RealtimeEvent; // optional realtime event
}

// ---------- PARSER ----------

export interface ParsedCommand {
  name: string;          // 'join', 'part', ...
  raw: string;           // full input
  args: string[];        // space-split args
  rest: string;          // remaining join after command
}

export function parseCommandLine(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const [nameRaw, ...restArr] = trimmed.split(/\s+/);
  const name = nameRaw.slice(1).toLowerCase();
  return {
    name,
    raw: trimmed,
    args: restArr,
    rest: restArr.join(" "),
  };
}

// ---------- HELP ----------

const HELP: Record<string, string> = {
  join: "/join #room — gabung/auto-join ruangan",
  part: "/part #room — keluar dari ruangan",
  nick: "/nick nama — ganti nama tampilan",
  me: "/me aksi — kirim pesan aksi (italic)",
  topic: "/topic teks — set topik ruangan (owner/admin)",
  whois: "/whois user — lihat info user",
  ignore: "/ignore user — sembunyikan pesan user",
  unignore: "/unignore user — tampilkan pesan user lagi",
  help: "/help [command] — bantuan",
  clear: "/clear — bersihkan layar chat (local)",
};

export function commandHelp(topic?: string): string {
  if (topic && HELP[topic]) return HELP[topic];
  if (topic) return `Command /${topic} tidak ada. /help buat daftar.`;
  return Object.values(HELP).join("\n");
}

// ---------- EXECUTORS ----------

async function runJoin(ctx: CommandContext, cmd: ParsedCommand): Promise<CommandResult> {
  const target = cmd.args[0] || "";
  const roomName = target.startsWith("#") ? target : "#" + target;
  const room = await findRoomByName(roomName);
  if (!room) return { ok: false, reply: `Room ${roomName} tidak ditemukan` };
  const existing = await getMemberRole(room.id, ctx.userId);
  if (existing) return { ok: true, roomId: room.id, reply: `Kamu sudah di ${room.name}` };
  await joinRoom(room.id, ctx.userId);
  const user = await findUserById(ctx.userId);
  const nick = user?.display_name || user?.username || "someone";
  const sysMsg = await insertMessage(room.id, ctx.userId, `*** ${nick} has joined ${room.name}`, "system");
  ctx.realtime.broadcastToRoom(room.id, { type: "message:new", message: sysMsg });
  ctx.realtime.broadcastToRoom(room.id, {
    type: "room:join", roomId: room.id,
    member: { roomId: room.id, userId: ctx.userId, role: "member", joinedAt: new Date().toISOString() },
  });
  return { ok: true, roomId: room.id, reply: `Joined ${room.name}` };
}

async function runPart(ctx: CommandContext, cmd: ParsedCommand): Promise<CommandResult> {
  const target = cmd.args[0] || "";
  const roomName = target.startsWith("#") ? target : "#" + target;
  const room = await findRoomByName(roomName);
  if (!room) return { ok: false, reply: `Room ${roomName} tidak ditemukan` };
  const member = await getMemberRole(room.id, ctx.userId);
  if (!member) return { ok: true, roomId: room.id, reply: `Kamu tidak di ${room.name}` };
  const user = await findUserById(ctx.userId);
  const nick = user?.display_name || user?.username || "someone";
  const sysMsg = await insertMessage(room.id, ctx.userId, `*** ${nick} has left ${room.name}`, "system");
  ctx.realtime.broadcastToRoom(room.id, { type: "message:new", message: sysMsg });
  await leaveRoom(room.id, ctx.userId);
  ctx.realtime.broadcastToRoom(room.id, { type: "room:leave", roomId: room.id, userId: ctx.userId });
  return { ok: true, roomId: room.id, reply: `Left ${room.name}` };
}

async function runNick(ctx: CommandContext, cmd: ParsedCommand): Promise<CommandResult> {
  const nick = cmd.args[0] || "";
  if (!nick) return { ok: false, reply: "Gunakan: /nick nama" };
  if (nick.length > 20) return { ok: false, reply: "Nickname maksimal 20 karakter" };
  const existing = await findUserByNickname(nick);
  if (existing && existing.id !== ctx.userId) return { ok: false, reply: `Nickname "${nick}" sudah dipakai` };
  await setDisplayName(ctx.userId, nick);
  return { ok: true, reply: `Nickname diganti jadi ${nick}` };
}

async function runMe(ctx: CommandContext, cmd: ParsedCommand): Promise<CommandResult> {
  if (!ctx.currentRoomId) return { ok: false, reply: "Pilih room dulu" };
  const text = cmd.rest;
  if (!text) return { ok: false, reply: "Gunakan: /me aksi" };
  const room = await findRoomById(ctx.currentRoomId);
  if (!room) return { ok: false, reply: "Room tidak ditemukan" };
  const member = await getMemberRole(room.id, ctx.userId);
  if (!member) return { ok: false, reply: "Kamu bukan member room ini" };
  const message = await insertMessage(room.id, ctx.userId, text, "action");
  const author = await findUserById(ctx.userId);
  const msgWithName = { ...message, authorName: author?.display_name || author?.username || message.authorId.slice(0, 8) };
  ctx.realtime.broadcastToRoom(room.id, { type: "message:new", message: msgWithName });
  return { ok: true, roomId: room.id };
}

async function runTopic(ctx: CommandContext, cmd: ParsedCommand): Promise<CommandResult> {
  if (!ctx.currentRoomId) return { ok: false, reply: "Pilih room dulu" };
  const text = cmd.rest;
  if (!text) return { ok: false, reply: "Gunakan: /topic teks" };
  const room = await findRoomById(ctx.currentRoomId);
  if (!room) return { ok: false, reply: "Room tidak ditemukan" };
  const role = await getMemberRole(room.id, ctx.userId);
  if (role !== "owner" && role !== "admin") return { ok: false, reply: "Cuma owner/admin yang bisa set topic" };
  await setRoomTopic(room.id, text.trim());
  const sysMsg = await insertMessage(room.id, ctx.userId, `Topic of ${room.name}: ${text.trim()}`, "system");
  ctx.realtime.broadcastToRoom(room.id, { type: "message:new", message: sysMsg });
  return { ok: true, roomId: room.id, reply: `Topic diubah: ${text.trim()}` };
}

async function runWhois(ctx: CommandContext, cmd: ParsedCommand): Promise<CommandResult> {
  const target = cmd.args[0] || "";
  if (!target) return { ok: false, reply: "Gunakan: /whois user" };
  const user = await findUserByNickname(target);
  if (!user) return { ok: false, reply: `User "${target}" tidak ditemukan` };
  return {
    ok: true,
    reply: `${user.display_name || user.username} (${user.username}) • bergabung ${new Date(user.created_at).toLocaleDateString()} • role platform: ${user.platform_role}`,
  };
}

async function runIgnore(ctx: CommandContext, cmd: ParsedCommand): Promise<CommandResult> {
  const target = cmd.args[0] || "";
  if (!target) return { ok: false, reply: "Gunakan: /ignore user" };
  const user = await findUserByNickname(target);
  if (!user) return { ok: false, reply: `User "${target}" tidak ditemukan` };
  if (user.id === ctx.userId) return { ok: false, reply: "Tidak bisa ignore diri sendiri" };
  await addIgnore(ctx.userId, user.id);
  return { ok: true, reply: `${user.display_name || user.username} di-ignore` };
}

async function runUnignore(ctx: CommandContext, cmd: ParsedCommand): Promise<CommandResult> {
  const target = cmd.args[0] || "";
  if (!target) return { ok: false, reply: "Gunakan: /unignore user" };
  const user = await findUserByNickname(target);
  if (!user) return { ok: false, reply: `User "${target}" tidak ditemukan` };
  await removeIgnore(ctx.userId, user.id);
  return { ok: true, reply: `${user.display_name || user.username} di-unignore` };
}

// ---------- REGISTRY ----------

const registry: Record<string, (ctx: CommandContext, cmd: ParsedCommand) => Promise<CommandResult>> = {
  join: runJoin,
  part: runPart,
  leave: runPart,
  nick: runNick,
  me: runMe,
  topic: runTopic,
  whois: runWhois,
  ignore: runIgnore,
  unignore: runUnignore,
};

export async function executeCommand(ctx: CommandContext, cmd: ParsedCommand): Promise<CommandResult> {
  if (cmd.name === "help") return { ok: true, reply: commandHelp(cmd.args[0]) };
  const fn = registry[cmd.name];
  if (!fn) return { ok: false, reply: `Command /${cmd.name} tidak dikenal. /help buat daftar.` };
  try {
    return await fn(ctx, cmd);
  } catch (err) {
    return { ok: false, reply: `Error: ${(err as Error).message}` };
  }
}

export { listIgnores };