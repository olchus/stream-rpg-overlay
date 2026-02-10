import { normalizeUsername } from "./util.js";

export async function connectKick(channel, onMessage) {
  const mod = await import("@retconned/kick-js");

  // kick-js (>=0.5.x) eksportuje createClient
  const createClient =
    mod?.createClient ||
    mod?.default?.createClient ||
    mod?.default ||
    null;

  if (!createClient) {
    throw new Error("kick-js: createClient export not found (API mismatch)");
  }

  const client = createClient(channel, {
    readOnly: true,
    logger: true,
    plainEmote: true
  });

  const on = client?.on?.bind(client);
  if (!on) {
    throw new Error("kick-js: event emitter not found");
  }

  on("ready", () => console.log("[kick] connected:", channel));
  on("disconnect", () => console.log("[kick] disconnected"));
  on("error", (e) => console.log("[kick] error", e?.message || e));

  // kick-js emituje ChatMessage z data.content
  on("ChatMessage", (m) => {
    const user = normalizeUsername(m?.sender?.username || m?.user?.username || m?.username);
    const text = String(m?.content ?? m?.message ?? m?.text ?? "");
    onMessage({ user, text });
  });

  return client;
}
