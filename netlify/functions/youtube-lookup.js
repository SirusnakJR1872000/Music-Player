const https = require("https");

function postJSON(url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Origin: "https://www.youtube.com",
          Referer: "https://www.youtube.com/",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error("Search failed"));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(12000, () => {
      req.destroy(new Error("Search timed out"));
    });
    req.write(data);
    req.end();
  });
}

function parseClock(text) {
  const parts = String(text || "")
    .trim()
    .split(":")
    .map((part) => Number(part));
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function collectVideos(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectVideos(item, out));
    return;
  }
  const video = node.videoRenderer;
  if (video && video.videoId) {
    const runs = video.title && video.title.runs;
    out.push({
      videoId: video.videoId,
      title: (runs && runs[0] && runs[0].text) || "",
      duration: parseClock(video.lengthText && video.lengthText.simpleText),
    });
    return;
  }
  Object.keys(node).forEach((key) => collectVideos(node[key], out));
}

function scoreVideo(video, title, artist) {
  const name = String(video.title || "").toLowerCase();
  const song = String(title || "").toLowerCase();
  const who = String(artist || "").toLowerCase();
  let score = 0;
  if (song && name.includes(song)) score += 6;
  const first = who.split(/[\s,&/]+/).find((part) => part.length > 2);
  if (first && name.includes(first)) score += 3;
  if (name.includes("official")) score += 2;
  if (/lyric|karaoke|cover|reaction|nightcore|slowed|reverb|\b8d\b|\blive\b/.test(name)) score -= 4;
  if (video.duration >= 90 && video.duration <= 480) score += 2;
  if (video.duration > 900) score -= 3;
  return score;
}

async function searchOnce(query) {
  const data = await postJSON("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20250925.01.00",
        hl: "en",
        gl: "US",
      },
    },
    query,
  });
  const videos = [];
  collectVideos(data, videos);
  return videos;
}

async function searchSong(title, artist) {
  const queries = [`${title} ${artist}`, `${title} ${artist} song`];
  let best = null;
  let bestScore = -Infinity;
  for (const query of queries) {
    let videos = [];
    try {
      videos = await searchOnce(query);
    } catch (err) {
      continue;
    }
    videos.slice(0, 8).forEach((video) => {
      const score = scoreVideo(video, title, artist);
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    });
    if (best && bestScore >= 6) break;
  }
  if (!best) return null;
  return {
    title,
    artist,
    videoId: best.videoId,
    thumbnail: `https://i.ytimg.com/vi/${best.videoId}/mqdefault.jpg`,
    ytTitle: best.title,
    duration: best.duration,
  };
}

async function lookupSongs(songs) {
  const results = [];
  const list = (Array.isArray(songs) ? songs : []).slice(0, 25);
  for (let i = 0; i < list.length; i += 4) {
    const batch = list.slice(i, i + 4);
    const found = await Promise.all(
      batch.map((song) => {
        const title = String((song && song.title) || "").trim();
        const artist = String((song && song.artist) || "").trim();
        if (!title) return null;
        return searchSong(title, artist).catch(() => null);
      })
    );
    results.push(...found);
  }
  return results.filter(Boolean);
}

module.exports = { lookupSongs };
