import { io as ioc } from "socket.io-client";

export function connectStreamlabs(socketToken, onEvent) {
  if (!socketToken) {
    console.log("[streamlabs] token missing - disabled");
    return null;
  }

  const client = ioc(`https://sockets.streamlabs.com?token=${socketToken}`, {
    transports: ["websocket"]
  });

  client.on("connect", () => console.log("[streamlabs] connected"));
  client.on("disconnect", () => console.log("[streamlabs] disconnected"));

  client.on("event", (data) => {
    try {
      onEvent(data);
    } catch (e) {
      console.log("[streamlabs] event handler error:", e?.message || e);
    }
  });

  return client;
}
