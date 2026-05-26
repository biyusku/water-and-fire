const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

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
};

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=3600",
    "Access-Control-Allow-Origin": "*",
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

http.createServer(function(req, res) {
  var urlPath = req.url.split("?")[0];
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";

  var base = __dirname;

  // Deneme sirasi:
  // 1. Direkt dosya (ornegin /game.html, /public/game/res/js/main.js)
  // 2. .html uzantisi ekle (ornegin /game -> /game.html)
  // 3. public/game/ altinda ara (iframe icinden gelen /res/ istekleri icin)
  // 4. public/game/ altinda .html ile ara
  var candidates = [
    path.join(base, urlPath),
    path.join(base, urlPath + ".html"),
    path.join(base, "public", "game", urlPath),
    path.join(base, "public", "game", urlPath + ".html"),
  ];

  tryPaths(candidates, res, urlPath);

}).listen(PORT, function() {
  console.log("Server running on port " + PORT);
});