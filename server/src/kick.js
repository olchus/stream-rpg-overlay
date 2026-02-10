import { normalizeUsername } from "./util.js";

export async function connectKick(channel, onMessage) {
  const mod = await import("@retconned/kick-js");

  // biblioteka bywa exportowana różnie w zależności od wersji (ESM/CJS)
  const KickChat =
    mod?.KickChat ||
    mod?.default?.KickChat ||
    mod?.default ||
    mod?.kickChat ||
    null;

  if (!KickChat) {
    throw new Error("kick-js: KickChat export not found (API mismatch)");
  }

  const chat = new KickChat({ channel });

  // różne nazwy eventów w zależności od wersji
  const on = chat.on?.bind(chat) || chat.addListener?.bind(chat);
  if (!on) {
    throw new Error("kick-js: event emitter not found");
  }

  on("ready", () => console.log("[kick] connected:", channel));
  on("error", (e) => console.log("[kick] error", e?.message || e));

  on("message", (m) => {
    const user = normalizeUsername(m?.sender?.username || m?.user?.username || m?.username);
    const text = String(m?.content ?? m?.message ?? m?.text ?? "");
    onMessage({ user, text });
  });

  // connect/ start
  if (typeof chat.connect === "function") await chat.connect();
  else if (typeof chat.start === "function") await chat.start();
  else throw new Error("kick-js: connect/start method not found");

  return chat;
}
