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

function songCount(prompt, fallback) {
  const text = String(prompt || "").toLowerCase();
  const numbered = text.match(/\b(\d{1,2})\s+songs?\b/);
  const named = [
    ["twenty five", 25], ["twenty-five", 25], ["twenty", 20], ["fifteen", 15],
    ["twelve", 12], ["ten", 10], ["eight", 8], ["five", 5],
  ];
  let count = null;
  if (numbered) count = Number(numbered[1]);
  else {
    const word = named.find(([label]) => text.includes(`${label} song`));
    if (word) count = word[1];
    else if (/\blonger\b|\bmore songs\b/.test(text)) count = 25;
  }
  if (!count) {
    const fromClient = Number(fallback);
    count = fromClient >= 20 && fromClient <= 25 ? fromClient : 20;
  }
  return Math.min(25, Math.max(1, count));
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
- If the user asks for a number of songs, return exactly that many, up to 25. Otherwise return 20. Never stop at 12 unless they asked for 12.
- Hindi, English, and Marathi songs are all allowed. Use the language they ask for. If they do not name one, mix languages when it fits the mood.
- For Hindi and Marathi, write the title in the romanized spelling people type on YouTube, and use the singer's name.
- Prefer well-known songs that can be played on YouTube. Do not stop after 2 or 3 songs.
- Do not repeat an artist more than 3 times.
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
  const maxSongs = songCount(prompt, body.maxSongs);
  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];

  const apiKey = String(body.apiKey || process.env.OPENROUTER_API_KEY || "").trim();
  const model = String(body.model || process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini").trim();

  if (prompt.length < 2) return reply(400, { error: "Tell me what you want to hear." });
  if (!apiKey) return reply(500, { error: "Add OPENROUTER_API_KEY in the Netlify environment variables." });

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...history
      .filter((item) => item && (item.role === "user" || item.role === "assistant"))
      .map((item) => ({
        role: item.role,
        content: String(item.content || "").slice(0, 1500),
      })),
    { role: "user", content: `${prompt}\nReturn exactly ${maxSongs} songs. Hindi, English, and Marathi are all fine.` },
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
        max_tokens: Math.max(2200, maxSongs * 160),
        response_format: { type: "json_object" },
        messages,
      }
    );
  } catch (err) {
    console.error("OpenRouter call failed");
    return reply(502, { error: "Could not reach the assistant." });
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return reply(500, { error: "The OpenRouter key was rejected. Check OPENROUTER_API_KEY in the Netlify environment variables." });
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

  if (playlist.songs.length < maxSongs) {
    const more = await extraSongs(apiKey, model, prompt, playlist.songs, maxSongs - playlist.songs.length);
    const seen = new Set(playlist.songs.map((song) => `${song.title.toLowerCase()}|${song.artist.toLowerCase()}`));
    more.forEach((song) => {
      const key = `${song.title.toLowerCase()}|${song.artist.toLowerCase()}`;
      if (seen.has(key) || playlist.songs.length >= maxSongs) return;
      seen.add(key);
      playlist.songs.push(song);
    });
  }

  if (!playlist.songs.length) return reply(502, { error: "The assistant did not return any songs." });
  return reply(200, { type: "playlist", playlist });
};

async function extraSongs(apiKey, model, prompt, have, need) {
  if (!need) return [];
  const chosen = have.map((song) => `${song.title} - ${song.artist}`).join(", ");
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
        max_tokens: Math.max(900, need * 160),
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Return only JSON: {\"songs\":[{\"title\":\"exact song title\",\"artist\":\"artist name\",\"reason\":\"one short sentence\"}]}",
          },
          {
            role: "user",
            content: `${prompt}\nAlready chosen: ${chosen}\nReturn exactly ${need} more different songs. Do not repeat any song above.`,
          },
        ],
      }
    );
  } catch (err) {
    return [];
  }
  if (upstream.status < 200 || upstream.status >= 300) return [];
  try {
    const raw = upstream.body?.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim());
    if (!Array.isArray(parsed.songs)) return [];
    return parsed.songs.slice(0, need).map((song) => ({
      title: String(song.title || "").trim(),
      artist: String(song.artist || "").trim(),
      reason: String(song.reason || "").trim(),
    })).filter((song) => song.title && song.artist);
  } catch (err) {
    return [];
  }
}

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
