import { normalizeUsername } from "./util.js";

export async function connectKick(channel, onMessage) {
  const { KickChat } = await import("@retconned/kick-js");

  const chat = new KickChat({ channel });

  chat.on("ready", () => console.log("[kick] connected:", channel));
  chat.on("error", (e) => console.log("[kick] error", e?.message || e));

  chat.on("message", (m) => {
    const user = normalizeUsername(m?.sender?.username);
    const text = String(m?.content || "");
    onMessage({ user, text });
  });

  await chat.connect();
  return chat;
}
