// WebSocket hook — connects to /realtime, dispatches events to React state

import { useEffect, useRef, useCallback } from "react";
import { getToken } from "./api";

export type WsEvent =
  | { type: "hello"; userId: string; serverTime: string }
  | { type: "message:new"; message: { id: string; roomId: string; authorId: string; kind: string; content: string; createdAt: string; replyToMessageId?: string | null } }
  | { type: "message:edit"; message: { id: string; roomId: string; authorId: string; kind: string; content: string; createdAt: string } }
  | { type: "message:delete"; roomId: string; messageId: string }
  | { type: "room:join"; roomId: string; member: { roomId: string; userId: string; role: string; joinedAt: string } }
  | { type: "room:leave"; roomId: string; userId: string }
  | { type: "presence:update"; presence: { userId: string; status: string; lastSeenAt: string } }
  | { type: "typing:start"; roomId: string; userId: string }
  | { type: "typing:stop"; roomId: string; userId: string }
  | { type: "reaction:add"; reaction: { messageId: string; userId: string; emoji: string; createdAt: string } }
  | { type: "reaction:remove"; messageId: string; userId: string; emoji: string }
  | { type: "error"; code: string; message: string };

interface UseRealtimeOpts {
  onEvent: (evt: WsEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export function useRealtime({ onEvent, onOpen, onClose }: UseRealtimeOpts) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEventRef = useRef(onEvent);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);

  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => { onOpenRef.current = onOpen; }, [onOpen]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const connect = useCallback(() => {
    const tok = getToken();
    if (!tok) return;
    const base = (import.meta as any).env?.VITE_API_BASE || "";
    let wsHost: string;
    if (base) {
      // backend terpisah (Vercel → tunnel/LAN)
      const u = new URL(base);
      wsHost = u.protocol === "https:" ? `wss://${u.host}` : `ws://${u.host}`;
    } else {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      wsHost = `${proto}//${location.host}`;
    }
    const ws = new WebSocket(`${wsHost}/realtime?token=${tok}`);
    wsRef.current = ws;

    ws.onopen = () => { onOpenRef.current?.(); };
    ws.onmessage = (ev) => {
      try { onEventRef.current(JSON.parse(ev.data)); } catch {}
    };
    ws.onclose = () => {
      onCloseRef.current?.();
      reconnectTimer.current = setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
      const ws = wsRef.current;
      wsRef.current = null;
      // close only if already open; a CONNECTING socket closing mid-handshake
      // triggers a noisy "closed before established" console error.
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    };
  }, [connect]);

  const send = useCallback((obj: unknown) => {
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify(obj));
  }, []);

  return { send };
}