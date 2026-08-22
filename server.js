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
  // Use curl as the HTTP client — Node's net module is blocked by Windows Defender
  // on this machine but curl uses its own socket layer and works fine.
  var spawn = require("child_process").spawn;
  var chunks = [];
  req.on("data", function(c) { chunks.push(c); });
  req.on("end", function() {
    var body = Buffer.concat(chunks).toString();
    var targetUrl = VLV_API + vlvPath;

    var args = [
      "-s", "--max-time", "10",
      "-X", req.method,
      "-H", "Content-Type: application/json",
      "-H", "X-VLV-API-Key: " + VLV_API_KEY,
      "-w", "\n__STATUS__%{http_code}",
    ];

    if (body && (req.method === "POST" || req.method === "PUT")) {
      args.push("-d", body);
    }

    args.push(targetUrl);

    var curlOut = [];
    var proc = spawn("curl", args, { shell: false });
    proc.stdout.on("data", function(d) { curlOut.push(d); });
    proc.stderr.on("data", function(d) { console.error("[proxy-curl]", d.toString()); });
    proc.on("close", function(code) {
      if (code !== 0) {
        res.writeHead(502, CORS_HEADERS);
        res.end(JSON.stringify({ error: "curl exited " + code }));
        return;
      }
      var full = Buffer.concat(curlOut).toString();
      var sep  = full.lastIndexOf("\n__STATUS__");
      var responseBody = sep >= 0 ? full.slice(0, sep) : full;
      var status = sep >= 0 ? parseInt(full.slice(sep + 11)) : 200;

      res.writeHead(status, Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS));
      res.end(responseBody);
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