import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { RealtimeEvent } from "@hyperoom/domain";
import { verifyToken } from "./auth.js";
import { setPresence, touchUserSeen } from "./repository.js";

interface SocketSession {
  userId: string;
  username: string;
}

type LiveSocket = WebSocket & { isAlive?: boolean; _wildcard?: boolean };

export class HyperoomRealtime {
  private wss: WebSocketServer;
  private sessions = new Map<LiveSocket, SocketSession>();
  private channels = new Map<string, Set<LiveSocket>>();
  private heartbeat: NodeJS.Timeout;

  constructor(server: import("node:http").Server) {
    this.wss = new WebSocketServer({ server, path: "/realtime" });
    this.wss.on("connection", (socket, req) => this.onConnection(socket, req));
    this.heartbeat = setInterval(() => this.heartbeatCheck(), 30000);
  }

  private onConnection(socket: LiveSocket, req: IncomingMessage) {
    socket.isAlive = true;
    socket.on("pong", () => { socket.isAlive = true; });

    const url = new URL(req.url || "/", "http://localhost");
    const token = url.searchParams.get("token");
    const payload = token ? verifyToken(token) : null;

    if (!payload) {
      socket.send(JSON.stringify({ type: "error", code: "AUTH_REQUIRED", message: "Missing or invalid token" } satisfies RealtimeEvent));
      socket.close(1008, "AUTH_REQUIRED");
      return;
    }

    this.sessions.set(socket, { userId: payload.sub, username: payload.username });
    socket.send(JSON.stringify({
      type: "hello",
      userId: payload.sub,
      serverTime: new Date().toISOString(),
    } satisfies RealtimeEvent));

    // Presence online
    void setPresence(payload.sub, "online").then((p) => {
      this.broadcast({ type: "presence:update", presence: p } satisfies RealtimeEvent);
    });
    // touch last_seen in users (core)
    void touchUserSeen(payload.sub);

    socket.on("message", (data) => this.onMessage(socket, data.toString()));
    socket.on("close", () => this.onClose(socket));
    socket.on("error", () => {});
  }

  private onMessage(socket: LiveSocket, raw: string) {
    let msg: { type: string; [k: string]: unknown };
    try { msg = JSON.parse(raw); } catch {
      socket.send(JSON.stringify({ type: "error", code: "BAD_JSON", message: "Payload must be valid JSON" } satisfies RealtimeEvent));
      return;
    }
    const session = this.sessions.get(socket);
    if (!session) return;

    switch (msg.type) {
      case "ping":
        socket.send(JSON.stringify({ type: "hello", userId: session.userId, serverTime: new Date().toISOString() }));
        break;
      case "room:join":
        if (typeof msg.roomId === "string") {
          if (msg.roomId === "*") {
            // wildcard: subscribe to ALL rooms (dashboard/monitor)
            (socket as LiveSocket & { _wildcard?: boolean })._wildcard = true;
            socket.send(JSON.stringify({ type: "room:join:ack", roomId: "*", ok: true } satisfies RealtimeEvent));
            this.log(`user=${session.userId} subscribed ALL (wildcard)`);
            break;
          }
          this.subscribe(socket, msg.roomId);
          socket.send(JSON.stringify({ type: "room:join:ack", roomId: msg.roomId, ok: true } satisfies RealtimeEvent));
          this.log(`user=${session.userId} subscribed room=${msg.roomId.slice(0, 8)}`);
        }
        break;
      case "room:leave":
        if (typeof msg.roomId === "string") {
          this.unsubscribe(socket, msg.roomId);
          socket.send(JSON.stringify({ type: "room:leave:ack", roomId: msg.roomId, ok: true } satisfies RealtimeEvent));
        }
        break;
      case "typing:start":
        this.broadcastToRoom(String(msg.roomId), { type: "typing:start", roomId: String(msg.roomId), userId: session.userId } satisfies RealtimeEvent);
        break;
      case "typing:stop":
        this.broadcastToRoom(String(msg.roomId), { type: "typing:stop", roomId: String(msg.roomId), userId: session.userId } satisfies RealtimeEvent);
        break;
      default:
        // pass-through unknown to channel subscribers — REST drives the rest
        break;
    }
  }

  private onClose(socket: LiveSocket) {
    const session = this.sessions.get(socket);
    if (!session) return;
    this.sessions.delete(socket);
    for (const [roomId, set] of this.channels) {
      if (set.delete(socket) && set.size === 0) this.channels.delete(roomId);
    }
    delete (socket as LiveSocket & { _wildcard?: boolean })._wildcard;
    void setPresence(session.userId, "offline").then((p) => {
      this.broadcast({ type: "presence:update", presence: p } satisfies RealtimeEvent);
    });
    this.log(`disconnected user=${session.userId}`);
  }

  /** Subscribe a socket to a room's broadcast list */
  subscribe(socket: LiveSocket, roomId: string) {
    if (!this.channels.has(roomId)) this.channels.set(roomId, new Set());
    this.channels.get(roomId)!.add(socket);
  }

  unsubscribe(socket: LiveSocket, roomId: string) {
    const set = this.channels.get(roomId);
    if (set) { set.delete(socket); if (set.size === 0) this.channels.delete(roomId); }
  }

  /** Emit event to everyone subscribed to a room (incl. wildcard/dashboard) */
  broadcastToRoom(roomId: string, evt: RealtimeEvent) {
    const raw = JSON.stringify(evt);
    const set = this.channels.get(roomId);
    if (set) for (const s of set) if (s.readyState === 1) s.send(raw);
    // wildcard subscribers (dashboard) receive all room events
    for (const s of this.sessions.keys()) {
      if (s.readyState === 1 && (s as LiveSocket)._wildcard) s.send(raw);
    }
  }

  /** Emit event to all connected sockets */
  broadcast(evt: RealtimeEvent) {
    const raw = JSON.stringify(evt);
    for (const s of this.sessions.keys()) if (s.readyState === 1) s.send(raw);
  }

  /** Fallback: all connected = wildcard (dashboard style) */
  subscribeAll(socket: LiveSocket) {
    (socket as LiveSocket)._wildcard = true;
  }

  get stats() {
    return { connections: this.sessions.size, rooms: this.channels.size };
  }

  private heartbeatCheck() {
    for (const s of this.sessions.keys()) {
      if (!s.isAlive) { s.terminate(); continue; }
      s.isAlive = false;
      s.ping();
    }
  }

  private log(msg: string) {
    console.log(`[realtime] ${msg}`);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const s of this.sessions.keys()) s.close(1001, "server shutdown");
  }
}