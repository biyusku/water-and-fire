const http    = require("http");
const fs      = require("fs");
const path    = require("path");
const url     = require("url");
const { createProxyMiddleware } = require("http-proxy-middleware");

const PORT        = process.env.PORT || 3000;
const VLV_API     = process.env.VLV_API    || "http://213.146.184.56:9090";
const VLV_SIGNAL  = process.env.VLV_SIGNAL || "ws://213.146.184.56:8080";
const VLV_LOBBY   = process.env.VLV_LOBBY  || "ws://213.146.184.56:8081";
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
  var axios  = require("axios");
  var chunks = [];
  req.on("data", function(c) { chunks.push(c); });
  req.on("end",  function() {
    var body = Buffer.concat(chunks).toString();
    axios({
      method: req.method.toLowerCase(),
      url:    VLV_API + vlvPath,
      headers: { "Content-Type": "application/json", "X-VLV-API-Key": VLV_API_KEY },
      data:   body || undefined,
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

// ── WS proxies ────────────────────────────────────────────────────────────
// http-proxy-middleware handles WS upgrade + framing + keepalive correctly
var signalProxy = createProxyMiddleware({
  target:      VLV_SIGNAL.replace("ws://", "http://").replace("wss://", "https://"),
  changeOrigin: true,
  ws:          true,
  pathRewrite: { "^/ws-signal": "/ws" },
  on: {
    error: function(err, req, res) { console.error("[signal-proxy]", err.message); },
  },
});

var lobbyProxy = createProxyMiddleware({
  target:      VLV_LOBBY.replace("ws://", "http://").replace("wss://", "https://"),
  changeOrigin: true,
  ws:          true,
  pathRewrite: { "^/ws-lobby": "/lobby" },
  on: {
    error: function(err, req, res) { console.error("[lobby-proxy]", err.message); },
  },
});

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

  // WS proxy HTTP fallback (non-upgrade requests to proxy paths)
  if (urlPath.startsWith("/ws-signal")) {
    signalProxy(req, res);
    return;
  }
  if (urlPath.startsWith("/ws-lobby")) {
    lobbyProxy(req, res);
    return;
  }

  // Static files
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
server.on("upgrade", function(req, socket, head) {
  var urlPath = url.parse(req.url).pathname;
  if (urlPath.startsWith("/ws-signal")) {
    signalProxy.upgrade(req, socket, head);
  } else if (urlPath.startsWith("/ws-lobby")) {
    lobbyProxy.upgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, function() {
  console.log("Server on http://localhost:" + PORT);
  console.log("REST proxy:      /vlv/*      → " + VLV_API);
  console.log("Signaling proxy: /ws-signal  → " + VLV_SIGNAL + "/ws");
  console.log("Lobby proxy:     /ws-lobby   → " + VLV_LOBBY + "/lobby");
});