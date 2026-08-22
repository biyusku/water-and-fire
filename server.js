const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;
const VLV_API = process.env.VLV_API || "http://213.146.184.56:9090";
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
  ".woff2":"font/woff2",
  ".woff": "font/woff",
  ".ogg":  "audio/ogg",
  ".mp3":  "audio/mpeg",
  ".wav":  "audio/wav",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-VLV-API-Key",
};

// ── VLV API proxy ─────────────────────────────────────────────────────────
// Forwards /vlv/* → VLV_API/* with API key injected server-side.
// This avoids CORS issues and keeps the API key out of the browser.

function vlvProxy(req, res, vlvPath) {
  var axios = require("axios");
  var chunks = [];
  req.on("data", function(c) { chunks.push(c); });
  req.on("end", function() {
    var body = Buffer.concat(chunks).toString();
    var targetUrl = VLV_API + vlvPath;

    axios({
      method: req.method.toLowerCase(),
      url: targetUrl,
      headers: {
        "Content-Type":  "application/json",
        "X-VLV-API-Key": VLV_API_KEY,
      },
      data: body || undefined,
      timeout: 10000,
      validateStatus: function() { return true; },
    }).then(function(proxyRes) {
      res.writeHead(proxyRes.status, Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS));
      res.end(typeof proxyRes.data === "string" ? proxyRes.data : JSON.stringify(proxyRes.data));
    }).catch(function(e) {
      console.error("[proxy] error:", e.message);
      res.writeHead(502, CORS_HEADERS);
      res.end(JSON.stringify({ error: "VLV unreachable: " + e.message }));
    });
  });
}

// ── Static file server ────────────────────────────────────────────────────

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type":  contentType,
    "Cache-Control": "public, max-age=3600",
    ...CORS_HEADERS,
  });
  fs.createReadStream(filePath).pipe(res);
}

function tryPaths(paths, res, urlPath) {
  if (paths.length === 0) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found: " + urlPath);
    return;
  }
  const current = paths[0];
  const rest = paths.slice(1);
  fs.stat(current, function(err, stat) {
    if (!err && stat.isFile()) {
      serveFile(res, current);
    } else {
      tryPaths(rest, res, urlPath);
    }
  });
}

// ── Main handler ──────────────────────────────────────────────────────────

http.createServer(function(req, res) {
  var urlPath = req.url.split("?")[0];

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // VLV API proxy: /vlv/v1/... → VLV_API/v1/...
  if (urlPath.startsWith("/vlv/")) {
    const vlvPath = urlPath.slice(4); // strip /vlv → /v1/...
    vlvProxy(req, res, vlvPath);
    return;
  }

  // Static files
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";

  var base = __dirname;
  var candidates = [
    path.join(base, urlPath),
    path.join(base, urlPath + ".html"),
    path.join(base, "public", "game", urlPath),
    path.join(base, "public", "game", urlPath + ".html"),
  ];

  tryPaths(candidates, res, urlPath);

}).listen(PORT, function() {
  console.log("Server running on http://localhost:" + PORT);
  console.log("VLV API proxy: /vlv/* → " + VLV_API);
});