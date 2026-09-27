const { lookupSongs } = require("./youtube-lookup");

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

  const songs = Array.isArray(body.songs) ? body.songs.slice(0, 25) : [];
  if (!songs.length) return reply(400, { error: "No songs provided" });

  const found = await lookupSongs(songs);
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
