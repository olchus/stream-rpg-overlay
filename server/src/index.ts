import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

import { connectStreamlabs } from "./streamlabs.js";
import { connectKick } from "./kick.js";
import { createGame, applyHit } from "./game.js";

const PORT = Number(process.env.PORT || 3000);
const STREAMLABS_SOCKET_TOKEN = process.env.STREAMLABS_SOCKET_TOKEN || "";
const KICK_CHANNEL = process.env.KICK_CHANNEL || "";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const game = createGame();

// overlay statics
app.use("/overlay", express.static(path.join(__dirname, "../../overlay")));

io.on("connection", (socket) => {
  socket.emit("state", game);
});

function broadcast() {
  io.emit("state", game);
}

function parseKickCommand(user: string, text: string) {
  if (text.trim() === "!attack") {
    applyHit(game, user, 5, "kick_chat");
    broadcast();
  }
}

function parseStreamlabsEvent(data: any) {
  // Przykładowo:
  // data.type = "donation" | "subscription" | "follow"
  // data.message[0].from, data.message[0].amount itp. (format zależy od eventu)
  const type = data?.type;

  if (type === "donation") {
    const who = data?.message?.[0]?.from ?? "donator";
    const amount = Number(data?.message?.[0]?.amount ?? 0);
    // 1 PLN = 10 dmg (przykład)
    applyHit(game, who, Math.max(10, Math.floor(amount * 10)), "streamlabs_donation");
    broadcast();
  }

  if (type === "subscription") {
    const who = data?.message?.[0]?.name ?? "sub";
    applyHit(game, who, 150, "streamlabs_sub");
    broadcast();
  }

  if (type === "follow") {
    const who = data?.message?.[0]?.name ?? "follow";
    applyHit(game, who, 20, "streamlabs_follow");
    broadcast();
  }
}

async function main() {
  if (STREAMLABS_SOCKET_TOKEN) {
    connectStreamlabs(STREAMLABS_SOCKET_TOKEN, parseStreamlabsEvent);
  } else {
    console.log("Missing STREAMLABS_SOCKET_TOKEN");
  }

  if (KICK_CHANNEL) {
    await connectKick(KICK_CHANNEL, (m) => parseKickCommand(m.user, m.text));
  } else {
    console.log("Missing KICK_CHANNEL");
  }

  httpServer.listen(PORT, () => console.log(`Listening on :${PORT}`));
}

main().catch(console.error);
