import WebSocket from "ws";
import { normalizeUsername, safeInt } from "./util.js";

const WS_BASE = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function buildWsUrl() {
  const url = new URL(WS_BASE);
  url.searchParams.set("protocol", "7");
  url.searchParams.set("client", "js");
  url.searchParams.set("version", "8.4.0");
  url.searchParams.set("flash", "false");
  return url.toString();
}

function tryParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractChatroomId(info) {
  if (!info) return 0;
  return (
    info?.chatroom?.id ||
    info?.chatroom_id ||
    info?.chatroomId ||
    info?.chatroom?.chatroom_id ||
    info?.chatroom?.chatroomId ||
    0
  );
}

async function fetchChannelData(channel) {
  const url = `https://kick.com/api/v2/channels/${channel}`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        Accept: "application/json"
      }
    });
    if (!resp.ok) {
      console.log("[kick] channel api status:", resp.status);
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.log("[kick] channel api error:", e?.message || e);
    return null;
  }
}

export async function connectKick(channel, onMessage) {
  const envChatroomId = safeInt(process.env.KICK_CHATROOM_ID, 0);
  let chatroomId = envChatroomId;

  if (!chatroomId) {
    console.log("[kick] fetching channel data:", channel);
    const info = await fetchChannelData(channel);
    chatroomId = extractChatroomId(info);

    if (!chatroomId) {
      const keys = info ? Object.keys(info) : [];
      console.log("[kick] missing chatroom id, keys:", keys.join(","));
      console.log("[kick] set KICK_CHATROOM_ID env to bypass");
      return null;
    }
  }

  const ws = new WebSocket(buildWsUrl());

  ws.on("open", () => {
    const payload = JSON.stringify({
      event: "pusher:subscribe",
      data: { auth: "", channel: `chatrooms.${chatroomId}.v2` }
    });
    ws.send(payload);
    console.log("[kick] connected:", channel, `(chatroom ${chatroomId})`);
  });

  ws.on("message", (data) => {
    const msg = tryParseJson(data.toString());
    if (!msg) return;

    if (msg.event === "App\\Events\\ChatMessageEvent") {
      const payload = tryParseJson(msg.data);
      if (!payload) return;
      const user = normalizeUsername(payload?.sender?.username || payload?.sender?.slug || payload?.username);
      const text = String(payload?.content ?? "");
      onMessage({ user, text, raw: payload, type: "chat" });
    }
  });

  ws.on("close", () => console.log("[kick] disconnected"));
  ws.on("error", (e) => console.log("[kick] error", e?.message || e));

  return ws;
}
