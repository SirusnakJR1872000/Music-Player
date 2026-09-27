const https = require("https");

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error("Bad JSON"));
          }
        });
      })
      .on("error", reject);
  });
}

function parseDuration(iso) {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

async function searchSong(title, artist, apiKey) {
  const query = encodeURIComponent(`${title} ${artist} official audio`);
  const searchUrl =
    "https://www.googleapis.com/youtube/v3/search" +
    `?part=snippet&type=video&maxResults=4&videoCategoryId=10&q=${query}&key=${apiKey}`;
  const searchData = await getJSON(searchUrl);
  const ids = (searchData.items || []).map((item) => item.id && item.id.videoId).filter(Boolean);
  if (!ids.length) return null;

  const detailUrl =
    "https://www.googleapis.com/youtube/v3/videos" +
    `?part=contentDetails,status,snippet&id=${ids.join(",")}&key=${apiKey}`;
  const detailData = await getJSON(detailUrl);
  const embeddable = (detailData.items || []).find(
    (video) => video.status && video.status.embeddable === true && video.status.privacyStatus === "public"
  );
  if (!embeddable) return null;

  const thumbs = embeddable.snippet.thumbnails || {};
  return {
    title,
    artist,
    videoId: embeddable.id,
    thumbnail: thumbs.medium?.url || thumbs.default?.url || "",
    ytTitle: embeddable.snippet.title,
    duration: parseDuration(embeddable.contentDetails && embeddable.contentDetails.duration),
  };
}

async function processInBatches(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (err) {
    return reply(400, { error: "Invalid JSON" });
  }

  const songs = Array.isArray(body.songs) ? body.songs.slice(0, 18) : [];
  const apiKey = String(body.apiKey || "").trim();
  if (!songs.length) return reply(400, { error: "No songs provided" });
  if (!apiKey || apiKey.includes("YOUR_")) {
    return reply(500, { error: "The YouTube key in config.js is missing." });
  }

  const rawResults = await processInBatches(songs, 6, (song) => {
    const title = String(song.title || "").trim();
    const artist = String(song.artist || "").trim();
    if (!title) return Promise.resolve(null);
    return searchSong(title, artist, apiKey).catch(() => null);
  });

  const found = rawResults.filter(Boolean);
  if (!found.length) return reply(404, { error: "No playable videos were found for those songs." });
  return reply(200, { success: true, songs: found, skipped: songs.length - found.length });
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function reply(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body: JSON.stringify(body),
  };
}
