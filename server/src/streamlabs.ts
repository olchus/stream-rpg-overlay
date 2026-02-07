import { io as ioc } from "socket.io-client";

export function connectStreamlabs(socketToken: string, onEvent: (e: any) => void) {
  const streamlabs = ioc(`https://sockets.streamlabs.com?token=${socketToken}`, {
    transports: ["websocket"]
  });

  streamlabs.on("connect", () => console.log("[streamlabs] connected"));
  streamlabs.on("disconnect", () => console.log("[streamlabs] disconnected"));

  // W praktyce Streamlabs wysyła eventy m.in. "event"
  streamlabs.on("event", (data: any) => {
    // data.type: donation / subscription / follow / etc (zależnie od konfiguracji)
    onEvent(data);
  });

  return streamlabs;
}
