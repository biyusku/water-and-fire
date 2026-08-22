const http = require("http");
const fs   = require("fs");
const path = require("path");
const url  = require("url");

const PORT       = process.env.PORT || 3000;
const VLV_API    = process.env.VLV_API    || "http://213.146.184.56:9090";
const VLV_SIGNAL = process.env.VLV_SIGNAL || "ws://213.146.184.56:8080";
const VLV_LOBBY  = process.env.VLV_LOBBY  || "ws://213.146.184.56:8081";
const VLV_API_KEY = process.env.VLV_API_KEY || "254db297e6a785d586e237f5366dc722";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".ogg":  "audio/ogg",
  ".mp3":  "audio/mpeg",
  ".wav":  "audio/wav",
};

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-VLV-API-Key",
};

// ── REST proxy: /vlv/* → VLV API ──────────────────────────────────────────

function vlvProxy(req, res, vlvPath) {
  var axios = require("axios");
  var chunks = [];
  req.on("data", function(c) { chunks.push(c); });
  req.on("end", function() {
    var body = Buffer.concat(chunks).toString();
    axios({
      method: req.method.toLowerCase(),
      url: VLV_API + vlvPath,
      headers: { "Content-Type": "application/json", "X-VLV-API-Key": VLV_API_KEY },
      data: body || undefined,
      timeout: 10000,
      validateStatus: function() { return true; },
    }).then(function(r) {
      res.writeHead(r.status, Object.assign({ "Content-Type": "application/json" }, CORS));
      res.end(typeof r.data === "string" ? r.data : JSON.stringify(r.data));
    }).catch(function(e) {
      console.error("[vlv-proxy]", e.message);
      res.writeHead(502, CORS);
      res.end(JSON.stringify({ error: "VLV unreachable: " + e.message }));
    });
  });
}

// ── WebSocket proxy ───────────────────────────────────────────────────────

var net = require("net");

/**
 * Proxy an incoming WS upgrade to a target WS server.
 * target: "ws://host:port"
 * reqPath: the path+query to forward (e.g. "/ws?token=xxx")
 */
function wsProxy(req, socket, head, target, reqPath) {
  var parsed = url.parse(target);
  var host   = parsed.hostname;
  var port   = parseInt(parsed.port) || 80;

  var upstream = net.connect(port, host, function() {
    // Forward the HTTP upgrade request verbatim
    var headers = [
      "GET " + reqPath + " HTTP/1.1",
      "Host: " + host + ":" + port,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: " + (req.headers["sec-websocket-key"] || "dGhlIHNhbXBsZSBub25jZQ=="),
      "Sec-WebSocket-Version: " + (req.headers["sec-websocket-version"] || "13"),
    ];

    // Forward token/ticket from original request headers if present
    var origin = req.headers["origin"];
    if (origin) headers.push("Origin: " + origin);

    upstream.write(headers.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);

    // Pipe bidirectionally
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on("error", function(e) {
    console.error("[ws-proxy]", e.message);
    socket.destroy();
  });
  socket.on("error", function() { upstream.destroy(); });
  socket.on("close", function() { upstream.destroy(); });
  upstream.on("close", function() { socket.destroy(); });
}

// ── Static file server ────────────────────────────────────────────────────

function serveFile(res, filePath) {
  var ext = path.extname(filePath).toLowerCase();
  var ct  = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": ct, "Cache-Control": "public,max-age=3600" });
  fs.createReadStream(filePath).pipe(res);
}

function tryPaths(paths, res, urlPath) {
  if (!paths.length) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found: " + urlPath);
    return;
  }
  fs.stat(paths[0], function(err, stat) {
    if (!err && stat.isFile()) serveFile(res, paths[0]);
    else tryPaths(paths.slice(1), res, urlPath);
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────

var server = http.createServer(function(req, res) {
  var parsed  = url.parse(req.url);
  var urlPath = parsed.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // REST proxy
  if (urlPath.startsWith("/vlv/")) {
    vlvProxy(req, res, urlPath.slice(4) + (parsed.search || ""));
    return;
  }

  // Static
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
  var base = __dirname;
  tryPaths([
    path.join(base, urlPath),
    path.join(base, urlPath + ".html"),
    path.join(base, "public", "game", urlPath),
    path.join(base, "public", "game", urlPath + ".html"),
  ], res, urlPath);
});

// ── WebSocket upgrade proxy ───────────────────────────────────────────────
// /ws-signal?token=xxx  → VLV_SIGNAL/ws?token=xxx
// /ws-lobby?ticket=xxx  → VLV_LOBBY/lobby?ticket=xxx

server.on("upgrade", function(req, socket, head) {
  var parsed  = url.parse(req.url);
  var urlPath = parsed.pathname;
  var qs      = parsed.search || "";

  if (urlPath === "/ws-signal") {
    wsProxy(req, socket, head, VLV_SIGNAL, "/ws" + qs);
  } else if (urlPath === "/ws-lobby") {
    wsProxy(req, socket, head, VLV_LOBBY, "/lobby" + qs);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, function() {
  console.log("Server running on http://localhost:" + PORT);
  console.log("VLV API proxy:    /vlv/*      → " + VLV_API);
  console.log("Signaling proxy:  /ws-signal  → " + VLV_SIGNAL + "/ws");
  console.log("Lobby proxy:      /ws-lobby   → " + VLV_LOBBY + "/lobby");
});