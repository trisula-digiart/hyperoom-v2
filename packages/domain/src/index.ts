// Hyperoom v2 domain model — mIRC-inspired but native.

export type RoomType = "public" | "private" | "dm" | "group";

export type RoomRole = "owner" | "admin" | "operator" | "voice" | "member";

export type MessageKind = "text" | "action" | "system";

export interface Profile {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  bio?: string;
  status?: string;
  lastSeenAt?: string;
  createdAt: string;
}

export interface Room {
  id: string;
  name: string; // #general
  type: RoomType;
  ownerId: string;
  topic?: string;
  isLocked: boolean;
  createdAt: string;
}

export interface RoomMember {
  roomId: string;
  userId: string;
  role: RoomRole;
  joinedAt: string;
}

export interface Message {
  id: string;
  roomId: string;
  authorId: string;
  kind: MessageKind;
  content: string;
  replyToMessageId?: string | null;
  editedAt?: string | null;
  deletedAt?: string | null;
  createdAt: string;
}

export interface Reaction {
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: string;
}

export interface Presence {
  userId: string;
  status: "online" | "idle" | "offline";
  lastSeenAt: string;
}

// --- Realtime events (WebSocket wire format) ---
export type RealtimeEvent =
  | { type: "hello"; userId: string; serverTime: string }
  | { type: "message:new"; message: Message }
  | { type: "message:edit"; message: Message }
  | { type: "message:delete"; roomId: string; messageId: string }
  | { type: "reaction:add"; reaction: Reaction }
  | { type: "reaction:remove"; messageId: string; userId: string; emoji: string }
  | { type: "room:join"; roomId: string; member: RoomMember }
  | { type: "room:leave"; roomId: string; userId: string }
  | { type: "room:join:ack"; roomId: string; ok: true }
  | { type: "room:leave:ack"; roomId: string; ok: true }
  | { type: "presence:update"; presence: Presence }
  | { type: "typing:start"; roomId: string; userId: string }
  | { type: "typing:stop"; roomId: string; userId: string }
  | { type: "error"; code: string; message: string };