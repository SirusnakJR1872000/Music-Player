import { splitByCache, bulkSetCache } from "./playlist-cache.js";
import { savePlaylist, readSharedPlaylist } from "./saved-playlists.js";
import { recordPlay, extractMood } from "./suggestions.js";

const SYSTEM_PROMPT = `You are Music AI, a friendly music companion inside a music player.
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
- If the user asks for a number of songs, return exactly that many, up to 25. Otherwise return 12.
- Hindi, English, and Marathi songs are all allowed. Use the language they ask for. If they do not name one, mix languages when it fits the mood.
- For Hindi and Marathi, write the title in the romanized spelling people type on YouTube, and use the singer's name.
- Prefer well-known songs that can be played on YouTube. Do not stop after 2 or 3 songs.
- Do not repeat an artist more than 3 times.
- Order the songs so the playlist flows.
- Only return the JSON object.`;

function songCount(prompt) {
  const text = String(prompt || "").toLowerCase();
  const numbered = text.match(/\b(\d{1,2})\s+songs?\b/);
  const named = [
    ["twenty five", 25], ["twenty-five", 25], ["twenty", 20], ["fifteen", 15],
    ["twelve", 12], ["ten", 10], ["eight", 8], ["five", 5],
  ];
  let count = 12;
  if (numbered) count = Number(numbered[1]);
  else {
    const word = named.find(([label]) => text.includes(`${label} song`));
    if (word) count = word[1];
  }
  return Math.min(25, Math.max(1, count));
}

function setting(name) {
  return String(window.CONFIG?.[name] || "").trim();
}

function apiMessage(data, fallback) {
  const error = data?.error;
  if (typeof error === "string" && error) return error;
  if (error?.message) return error.message;
  return fallback;
}

async function createPlaylist(prompt, history) {
  const apiKey = setting("OPENROUTER_API_KEY");
  if (!apiKey) return createPlaylistOnServer(prompt, history);
  const model = setting("OPENROUTER_MODEL") || "openai/gpt-4o-mini";

  const maxSongs = songCount(prompt);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history
      .filter((item) => item && (item.role === "user" || item.role === "assistant"))
      .slice(-6)
      .map((item) => ({ role: item.role, content: String(item.content || "").slice(0, 1500) })),
    { role: "user", content: `${prompt}\nReturn exactly ${maxSongs} songs. Hindi, English, and Marathi are all fine.` },
  ];

  let response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": window.location.origin,
        "X-Title": "Music Player",
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: Math.max(2200, maxSongs * 160),
        response_format: { type: "json_object" },
        messages,
      }),
    });
  } catch (err) {
    throw new Error("Could not reach the assistant.");
  }

  const data = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) {
    throw new Error("The OpenRouter key was rejected. Check OPENROUTER_API_KEY in config.js.");
  }
  if (!response.ok) throw new Error(apiMessage(data, "The assistant could not answer just now."));

  const raw = data?.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim());
  } catch (err) {
    throw new Error("The assistant returned an unexpected reply.");
  }

  if (parsed.type === "chat") {
    return { type: "chat", message: String(parsed.message || "Tell me a mood, artist, or occasion.").trim() };
  }
  if (!Array.isArray(parsed.songs) || !parsed.songs.length) {
    throw new Error("The assistant did not return any songs.");
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
  if (!playlist.songs.length) throw new Error("The assistant did not return any songs.");
  return { type: "playlist", playlist };
}

async function createPlaylistOnServer(prompt, history) {
  let response;
  try {
    response = await fetch("/.netlify/functions/create-playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        history,
        maxSongs: songCount(prompt),
        model: setting("OPENROUTER_MODEL") || "openai/gpt-4o-mini",
      }),
    });
  } catch (err) {
    throw new Error("Could not reach the assistant.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(apiMessage(data, "Could not reach the assistant."));
  if (data?.type === "chat") return { type: "chat", message: data.message };
  if (!data?.playlist) throw new Error("The assistant did not return any songs.");
  return data;
}

async function searchSongs(songs) {
  let response;
  try {
    response = await fetch("/.netlify/functions/search-youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        songs: songs.map((song) => ({ title: song.title, artist: song.artist })),
      }),
    });
  } catch (err) {
    throw new Error("Could not look up those songs. Try again in a little while.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(apiMessage(data, "No playable songs were found. Try a different mood or artist."));
  }
  return Array.isArray(data?.songs) ? data.songs : [];
}

export async function askMusicAI(prompt, { history = [], onProgress } = {}) {
  const progress = onProgress || (() => {});
  progress("thinking", "Finding the perfect songs for you…");

  const aiData = await createPlaylist(String(prompt || "").trim().slice(0, 500), history);
  if (aiData.type === "chat") return aiData;

  const playlist = aiData.playlist;
  const { cached, uncached } = splitByCache(playlist.songs);
  progress("searching", "Matching songs and painting the wallpaper…");

  const [freshResults, wallpaper] = await Promise.all([
    (async () => {
      if (!uncached.length) return [];
      const found = await searchSongs(uncached);
      bulkSetCache(found);
      return found;
    })(),
    createWallpaper(playlist, prompt),
  ]);

  const allFound = [...cached, ...freshResults];
  const orderedSongs = playlist.songs
    .map((song) => allFound.find(
      (found) => found.title.toLowerCase() === song.title.toLowerCase()
        && found.artist.toLowerCase() === song.artist.toLowerCase()
    ))
    .filter(Boolean)
    .map((song) => {
      const meta = playlist.songs.find((item) => item.title.toLowerCase() === song.title.toLowerCase());
      return { ...song, reason: meta?.reason || "" };
    });

  if (!orderedSongs.length) {
    throw new Error("No playable songs were found. Try a different mood or artist.");
  }

  const finalPlaylist = {
    ...playlist,
    prompt,
    songs: orderedSongs,
    skippedCount: playlist.songs.length - orderedSongs.length,
  };
  const saved = savePlaylist(finalPlaylist);
  if (saved) finalPlaylist.savedId = saved.id;
  if (wallpaper) finalPlaylist.wallpaper = wallpaper;
  recordPlay({
    prompt,
    playlistName: playlist.playlistName,
    songs: orderedSongs,
    mood: extractMood(prompt),
  });
  progress("done", `${orderedSongs.length} songs are ready.`);
  return { type: "playlist", playlist: finalPlaylist };
}

export function loadSharedPlaylist() {
  return readSharedPlaylist();
}

function wallpaperPrompt(playlist, userPrompt) {
  const titles = (playlist.songs || []).slice(0, 4).map((song) => song.title).filter(Boolean).join(", ");
  return [
    "Cinematic painterly illustration for a music-player wallpaper, wide landscape, rich color, soft film lighting.",
    "No text, no letters, no watermark, no logo, no frame, no user interface.",
    `Mood and title: ${playlist.playlistName || "Playlist"}. ${playlist.description || ""}`,
    `Listener request: ${userPrompt || ""}.`,
    titles ? `Inspired by these songs: ${titles}.` : "",
  ].filter(Boolean).join(" ");
}

function dataUrlFromBase64(b64) {
  const mime = String(b64).startsWith("iVBOR") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${b64}`;
}

function imageFromPayload(data) {
  const item = Array.isArray(data?.data) ? data.data[0] : null;
  if (!item) return "";
  if (item.b64_json) return dataUrlFromBase64(item.b64_json);
  if (typeof item.url === "string") return item.url;
  return "";
}

async function requestWallpaper(scene, apiKey) {
  const model = setting("OPENROUTER_IMAGE_MODEL") || "openai/gpt-image-1";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": window.location.origin,
    "X-Title": "Music Player",
  };
  const full = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      prompt: scene,
      aspect_ratio: "16:9",
      quality: "medium",
      output_format: "jpeg",
    }),
  });
  if (full.ok) return imageFromPayload(await full.json().catch(() => null));
  const plain = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers,
    body: JSON.stringify({ model, prompt: scene }),
  });
  if (!plain.ok) return "";
  return imageFromPayload(await plain.json().catch(() => null));
}

async function createWallpaper(playlist, userPrompt) {
  const scene = wallpaperPrompt(playlist, userPrompt);
  try {
    const apiKey = setting("OPENROUTER_API_KEY");
    if (apiKey) return await requestWallpaper(scene, apiKey);
    const response = await fetch("/.netlify/functions/create-wallpaper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: scene,
        model: setting("OPENROUTER_IMAGE_MODEL") || "openai/gpt-image-1",
      }),
    });
    if (!response.ok) return "";
    const data = await response.json().catch(() => null);
    return data?.image || "";
  } catch (err) {
    return "";
  }
}
