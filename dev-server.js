const http = require("http");
const fs = require("fs");
const path = require("path");
const { lookupSongs } = require("./netlify/functions/youtube-lookup");

const root = __dirname;
const port = Number(process.env.PORT || 8765);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === "/.netlify/functions/search-youtube") {
    handleSearch(req, res);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }
  let filePath = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (url.pathname.endsWith("/")) filePath = path.join(filePath, "index.html");
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) filePath = path.join(filePath, "index.html");
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream" });
      if (req.method === "HEAD") res.end();
      else res.end(data);
    });
  });
});

function handleSearch(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors());
    res.end();
    return;
  }
  if (req.method !== "POST") {
    send(res, 405, { error: "Method not allowed" });
    return;
  }
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 100000) req.destroy();
  });
  req.on("end", async () => {
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch (err) {
      send(res, 400, { error: "Invalid JSON" });
      return;
    }
    const songs = Array.isArray(body.songs) ? body.songs.slice(0, 25) : [];
    if (!songs.length) {
      send(res, 400, { error: "No songs provided" });
      return;
    }
    try {
      const found = await lookupSongs(songs);
      if (!found.length) {
        send(res, 404, { error: "No playable videos were found for those songs." });
        return;
      }
      send(res, 200, { success: true, songs: found, skipped: songs.length - found.length });
    } catch (err) {
      send(res, 502, { error: "Could not look up those songs. Try again in a little while." });
    }
  });
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function send(res, status, body) {
  res.writeHead(status, cors());
  res.end(JSON.stringify(body));
}

server.listen(port, "127.0.0.1", () => {
  console.log(`Music Player at http://127.0.0.1:${port}`);
});
