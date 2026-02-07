export async function connectKick(channel: string, onMessage: (msg: {user: string; text: string}) => void) {
  // Minimalnie: użyj gotowego wrappera kick-js
  // npm i @retconned/kick-js
  const { KickChat } = await import("@retconned/kick-js");

  const chat = new KickChat({ channel });

  chat.on("message", (m: any) => {
    onMessage({ user: m.sender?.username ?? "unknown", text: m.content ?? "" });
  });

  chat.on("ready", () => console.log("[kick] connected"));
  chat.on("error", (e: any) => console.log("[kick] error", e));

  await chat.connect();
  return chat;
}
