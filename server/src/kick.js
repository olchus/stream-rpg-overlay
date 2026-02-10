import { normalizeUsername } from "./util.js";

async function patchPuppeteerNoSandbox() {
  try {
    const mod = await import("puppeteer-extra");
    const puppeteer = mod?.default || mod;
    if (!puppeteer || puppeteer.__patchedNoSandbox) return;

    const origLaunch = puppeteer.launch.bind(puppeteer);
    puppeteer.launch = (opts = {}) => {
      const args = Array.isArray(opts.args) ? [...opts.args] : [];
      const add = (flag) => {
        if (!args.includes(flag)) args.push(flag);
      };
      add("--no-sandbox");
      add("--disable-setuid-sandbox");
      add("--disable-dev-shm-usage");
      return origLaunch({ ...opts, args });
    };

    puppeteer.__patchedNoSandbox = true;
  } catch (e) {
    console.log("[kick] puppeteer patch failed:", e?.message || e);
  }
}

export async function connectKick(channel, onMessage) {
  const noSandbox = (process.env.KICK_PUPPETEER_NO_SANDBOX || "true").toLowerCase() === "true";
  if (noSandbox) {
    await patchPuppeteerNoSandbox();
  }

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
