/**
 * server.js — VLV Games Platform
 *
 * Routes:
 *   GET /              → public/index.html  (lobby)
 *   GET /games/:game/* → public/games/:game/* (static game assets)
 *   GET /public/*      → public/* (static assets)
 *   WS  /room-ws       → room presence + game start coordination
 *
 * VLV API calls (matchmaking) are made directly from the browser
 * to vlvapi.rusk.agency — no proxy needed since CORS is enabled.
 */

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".ogg":  "audio/ogg",
  ".mp3":  "audio/mpeg",
  ".wav":  "audio/wav",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
};

// ── Static file server ────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, "public");

function serveFile(filePath, res) {
  fs.readFile(filePath, function(err, data) {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(data);
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(function(req, res) {
  // Health check
  if (req.url === "/healthz") {
    res.writeHead(200); res.end("ok"); return;
  }

  // Strip query string for file lookup
  const urlPath = req.url.split("?")[0];

  // Root → lobby
  if (urlPath === "/" || urlPath === "") {
    return serveFile(path.join(PUBLIC_DIR, "index.html"), res);
  }

  // All other paths → serve from public/
  const filePath = path.join(PUBLIC_DIR, urlPath);

  // Security: prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  // If path has no extension, try .html
  if (!path.extname(urlPath)) {
    const htmlPath = filePath + ".html";
    if (fs.existsSync(htmlPath)) return serveFile(htmlPath, res);
    // Try index.html in directory
    const indexPath = path.join(filePath, "index.html");
    if (fs.existsSync(indexPath)) return serveFile(indexPath, res);
  }

  serveFile(filePath, res);
});

// ── Room WebSocket server ─────────────────────────────────────────────────────
// Rooms: { code: { players: { id: { ws, name, isHost } } } }
const rooms = {};

const wss = new WebSocketServer({ server });

wss.on("connection", function(ws, req) {
  const params  = new URLSearchParams(req.url.replace("/room-ws", "").replace("?",""));
  const code    = (params.get("code") || "").toUpperCase().slice(0,8);
  const name    = (params.get("name") || "Player").slice(0,20);
  const isHost  = params.get("host") === "1";
  const playerId = (params.get("id") || Math.random().toString(36).slice(2)).slice(0,24);

  if (!code) { ws.close(1008, "No room code"); return; }

  // Create room if needed
  if (!rooms[code]) rooms[code] = { players: {} };
  const room = rooms[code];

  // Max 2 players
  if (Object.keys(room.players).length >= 2) {
    ws.send(JSON.stringify({ type: "error", msg: "Room is full" }));
    ws.close(); return;
  }

  room.players[playerId] = { ws, name, isHost };
  ws.playerId = playerId;
  ws.roomCode = code;

  broadcastRoomState(room);
  console.log(`[room] ${code} — ${name} joined (${Object.keys(room.players).length}/2)`);

  ws.on("message", function(raw) {
    var m; try { m = JSON.parse(raw); } catch { return; }

    if (m.type === "start_game" && isHost) {
      // Host wants to start a game — send start to all players
      // Each player will connect to VLV matchmaking themselves using the game's online.html
      // We just tell everyone which game and what role to take
      var playerIds = Object.keys(room.players);
      playerIds.forEach(function(pid, idx) {
        var p = room.players[pid];
        var role = p.isHost ? "host" : "guest";
        p.ws.send(JSON.stringify({
          type: "start_game",
          game: m.game,
          role: role,
          roomCode: code
        }));
      });
      console.log(`[room] ${code} — starting game: ${m.game}`);
    }
  });

  ws.on("close", function() {
    if (!rooms[ws.roomCode]) return;
    delete rooms[ws.roomCode].players[ws.playerId];
    if (Object.keys(rooms[ws.roomCode].players).length === 0) {
      delete rooms[ws.roomCode];
      console.log(`[room] ${ws.roomCode} — closed (empty)`);
    } else {
      broadcastRoomState(rooms[ws.roomCode]);
    }
  });
});

function broadcastRoomState(room) {
  // Build serializable player list (no ws reference)
  var playerList = {};
  Object.keys(room.players).forEach(function(id) {
    var p = room.players[id];
    playerList[id] = { name: p.name, isHost: p.isHost };
  });
  var msg = JSON.stringify({ type: "room_state", players: playerList });
  Object.values(room.players).forEach(function(p) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, function() {
  console.log(`[vlv-games] listening on port ${PORT}`);
});