// Hyperoom v2 — mIRC-style command parser + executor port.
// Parses /command args... and returns a typed Command object.
// Execution happens server-side via the ChatEnginePort.

import type { RoomRole } from "@hyperoom/domain";

export type ParsedCommand =
  | { cmd: "join";  target: string; password?: string }
  | { cmd: "part";  target: string; reason?: string }
  | { cmd: "msg";   target: string; text: string }
  | { cmd: "me";    text: string }
  | { cmd: "nick";  newNick: string }
  | { cmd: "whois"; target: string }
  | { cmd: "kick";  target: string; reason?: string }
  | { cmd: "ban";   target: string }
  | { cmd: "unban"; target: string }
  | { cmd: "mode";  target: string; mode: string; arg?: string }
  | { cmd: "topic"; text: string }
  | { cmd: "quit";  reason?: string }
  | { cmd: "help";  topic?: string }
  | { cmd: "raw";   rawLine: string }
  | { cmd: "unknown"; rawLine: string };

const HELP_TEXT: Record<string, string> = {
  join:  "/join #room [password]  — join a room",
  part:  "/part #room [reason]    — leave a room",
  msg:   "/msg target text        — send a private message or DM",
  me:    "/me action              — send an action message (/me waves)",
  nick:  "/nick newname           — change your display name",
  whois: "/whois target           — look up a user",
  kick:  "/kick #room user [reason] — kick a user (op/admin only)",
  ban:   "/ban #room user         — ban a user (op/admin only)",
  unban: "/unban #room user       — unban a user (op/admin only)",
  mode:  "/mode #room +o user     — set room mode (owner/admin only)",
  topic: "/topic new topic text   — set room topic (op/admin only)",
  quit:  "/quit [reason]          — disconnect",
  help:  "/help [command]         — show help",
};

/** Parse a raw chat input. Returns ParsedCommand if it starts with '/', otherwise undefined (plain message). */
export function parseCommand(input: string): ParsedCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const parts = trimmed.split(/\s+/);
  const cmdRaw = parts[0].toLowerCase().slice(1); // strip leading /
  const rest = parts.slice(1);

  switch (cmdRaw) {
    case "join":
    case "j": {
      const target = rest[0] || "";
      return { cmd: "join", target: target.startsWith("#") ? target : "#" + target, password: rest[1] };
    }
    case "part":
    case "leave": {
      const target = rest[0] || "";
      return { cmd: "part", target, reason: rest.slice(1).join(" ") || undefined };
    }
    case "msg":
    case "m": {
      const target = rest[0] || "";
      return { cmd: "msg", target, text: rest.slice(1).join(" ") };
    }
    case "me": {
      return { cmd: "me", text: rest.join(" ") };
    }
    case "nick": {
      return { cmd: "nick", newNick: rest[0] || "" };
    }
    case "whois": {
      return { cmd: "whois", target: rest[0] || "" };
    }
    case "kick": {
      return { cmd: "kick", target: rest[0] || "", reason: rest.slice(1).join(" ") || undefined };
    }
    case "ban": {
      return { cmd: "ban", target: rest[0] || "" };
    }
    case "unban": {
      return { cmd: "unban", target: rest[0] || "" };
    }
    case "mode": {
      return { cmd: "mode", target: rest[0] || "", mode: rest[1] || "", arg: rest[2] };
    }
    case "topic": {
      return { cmd: "topic", text: rest.join(" ") };
    }
    case "quit": {
      return { cmd: "quit", reason: rest.join(" ") || undefined };
    }
    case "help": {
      return { cmd: "help", topic: rest[0] };
    }
    default: {
      return { cmd: "unknown", rawLine: trimmed };
    }
  }
}

export function formatHelp(topic?: string): string {
  if (topic && HELP_TEXT[topic]) return `/${topic}: ${HELP_TEXT[topic]}`;
  if (topic) return `Unknown command: /${topic}. Type /help for available commands.`;
  return Object.entries(HELP_TEXT)
    .map(([k, v]) => `  ${v}`)
    .join("\n");
}

/** Check if a role can perform a privileged action. */
export function canModerate(role: RoomRole | null): boolean {
  return role === "owner" || role === "admin" || role === "operator";
}

export function canManage(role: RoomRole | null): boolean {
  return role === "owner" || role === "admin";
}

export function canSetMode(role: RoomRole | null): boolean {
  return role === "owner";
}