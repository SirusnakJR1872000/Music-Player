const https = require("https");

function postJSON(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch (err) {
            reject(new Error("Bad JSON from upstream"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function buildSystemPrompt() {
  return `You are Music AI, a friendly music companion inside a music player.
When a user talks to you, return ONLY a valid JSON object. No markdown. No text outside the JSON.

If they want songs, a mood, an artist, or a playlist, return:
{
  "type": "playlist",
  "message": "one short friendly sentence",
  "playlistName": "short creative name",
  "description": "one sentence about the mood",
  "reasoning": "one sentence on why these songs fit",
  "songs": [
    { "title": "exact song title", "artist": "exact artist name", "reason": "one short sentence" }
  ]
}

If they are greeting you, asking what you can do, or not asking for music yet, return:
{
  "type": "chat",
  "message": "a short friendly reply that invites them to name a mood, artist, or occasion"
}

Playlist rules:
- Return 12 songs unless the user asks for a different number, never more than 18.
- Prefer well-known, officially released songs that are on YouTube.
- For Bollywood, use the original Hindi title and the singer, not the film name.
- Match the requested mood. Do not repeat an artist more than 3 times.
- Order the songs so the playlist flows.
- Only return the JSON object.`;
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
    return reply(400, { error: "Invalid JSON body" });
  }

  const prompt = String(body.prompt || "").trim().slice(0, 500);
  const maxSongs = Math.min(18, Math.max(8, Number(body.maxSongs) || 12));
  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];

  const apiKey = String(body.apiKey || process.env.OPENROUTER_API_KEY || "").trim();
  const model = String(body.model || process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini").trim();

  if (prompt.length < 2) return reply(400, { error: "Tell me what you want to hear." });
  if (!apiKey) return reply(500, { error: "Add the OpenRouter key in config.js." });

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...history
      .filter((item) => item && (item.role === "user" || item.role === "assistant"))
      .map((item) => ({
        role: item.role,
        content: String(item.content || "").slice(0, 1500),
      })),
    { role: "user", content: `${prompt}\nMax songs: ${maxSongs}` },
  ];

  let upstream;
  try {
    upstream = await postJSON(
      "openrouter.ai",
      "/api/v1/chat/completions",
      {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://your-playlist.netlify.app",
        "X-Title": "Music Player",
      },
      {
        model,
        temperature: 0.7,
        max_tokens: 1800,
        response_format: { type: "json_object" },
        messages,
      }
    );
  } catch (err) {
    console.error("OpenRouter call failed");
    return reply(502, { error: "Could not reach the assistant." });
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return reply(500, { error: "The OpenRouter key was rejected. Check OPENROUTER_API_KEY in config.js." });
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    return reply(502, { error: "The assistant could not answer just now." });
  }

  const raw = upstream.body?.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return reply(502, { error: "The assistant returned an unexpected reply." });
  }

  if (parsed.type === "chat") {
    return reply(200, { type: "chat", message: String(parsed.message || "Tell me a mood, artist, or occasion.").trim() });
  }

  if (!Array.isArray(parsed.songs) || parsed.songs.length === 0) {
    return reply(502, { error: "The assistant did not return any songs." });
  }

  const playlist = {
    playlistName: String(parsed.playlistName || "Made for you").trim(),
    description: String(parsed.description || "").trim(),
    reasoning: String(parsed.reasoning || "").trim(),
    message: String(parsed.message || "Here's a curated playlist just for you.").trim(),
    songs: parsed.songs.slice(0, maxSongs).map((song) => ({
      title: String(song.title || "").trim(),
      artist: String(song.artist || "").trim(),
      reason: String(song.reason || "").trim(),
    })).filter((song) => song.title && song.artist),
  };

  if (!playlist.songs.length) return reply(502, { error: "The assistant did not return any songs." });
  return reply(200, { type: "playlist", playlist });
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
