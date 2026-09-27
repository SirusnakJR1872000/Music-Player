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
- Return 12 songs unless the user asks for a different number, never more than 18.
- Prefer well-known, officially released songs that are on YouTube.
- For Bollywood, use the original Hindi title and the singer, not the film name.
- Match the requested mood. Do not repeat an artist more than 3 times.
- Order the songs so the playlist flows.
- Only return the JSON object.`;

function setting(name) {
  return String(window.CONFIG?.[name] || "").trim();
}

function apiMessage(data, fallback) {
  const error = data?.error;
  if (typeof error === "string" && error) return error;
  if (error?.message) return error.message;
  return fallback;
}

function parseDuration(iso) {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

async function createPlaylist(prompt, history) {
  const apiKey = setting("OPENROUTER_API_KEY");
  const model = setting("OPENROUTER_MODEL") || "openai/gpt-4o-mini";
  if (!apiKey) throw new Error("Add the OpenRouter key in config.js.");

  const maxSongs = 12;
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history
      .filter((item) => item && (item.role === "user" || item.role === "assistant"))
      .slice(-6)
      .map((item) => ({ role: item.role, content: String(item.content || "").slice(0, 1500) })),
    { role: "user", content: `${prompt}\nMax songs: ${maxSongs}` },
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
        max_tokens: 1800,
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
    songs: parsed.songs.slice(0, 18).map((song) => ({
      title: String(song.title || "").trim(),
      artist: String(song.artist || "").trim(),
      reason: String(song.reason || "").trim(),
    })).filter((song) => song.title && song.artist),
  };
  if (!playlist.songs.length) throw new Error("The assistant did not return any songs.");
  return { type: "playlist", playlist };
}

async function searchSong(title, artist, apiKey) {
  const query = encodeURIComponent(`${title} ${artist} official audio`);
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=4&videoCategoryId=10&q=${query}&key=${encodeURIComponent(apiKey)}`;
  const searchData = await fetch(searchUrl).then((response) => response.json());
  if (searchData.error) throw new Error(searchData.error.message || "YouTube search failed.");
  const ids = (searchData.items || []).map((item) => item.id?.videoId).filter(Boolean);
  if (!ids.length) return null;

  const detailUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,status,snippet&id=${ids.join(",")}&key=${encodeURIComponent(apiKey)}`;
  const detailData = await fetch(detailUrl).then((response) => response.json());
  const embeddable = (detailData.items || []).find(
    (video) => video.status?.embeddable === true && video.status?.privacyStatus === "public"
  );
  if (!embeddable) return null;
  const thumbs = embeddable.snippet.thumbnails || {};
  return {
    title,
    artist,
    videoId: embeddable.id,
    thumbnail: thumbs.medium?.url || thumbs.default?.url || "",
    ytTitle: embeddable.snippet.title,
    duration: parseDuration(embeddable.contentDetails?.duration),
  };
}

async function searchSongs(songs) {
  const apiKey = setting("API_KEY");
  if (!apiKey) throw new Error("The YouTube key in config.js is missing.");
  const results = [];
  for (let i = 0; i < songs.length; i += 4) {
    const batch = await Promise.all(songs.slice(i, i + 4).map((song) => (
      searchSong(song.title, song.artist, apiKey).catch(() => null)
    )));
    results.push(...batch);
  }
  return results.filter(Boolean);
}

export async function askMusicAI(prompt, { history = [], onProgress } = {}) {
  const progress = onProgress || (() => {});
  progress("thinking", "Finding the perfect songs for you…");

  const aiData = await createPlaylist(String(prompt || "").trim().slice(0, 500), history);
  if (aiData.type === "chat") return aiData;

  const playlist = aiData.playlist;
  progress("cache", `Got ${playlist.songs.length} songs. Matching them on YouTube…`);
  const { cached, uncached } = splitByCache(playlist.songs);

  let freshResults = [];
  if (uncached.length) {
    progress("searching", `Searching YouTube for ${uncached.length} song${uncached.length === 1 ? "" : "s"}…`);
    freshResults = await searchSongs(uncached);
    bulkSetCache(freshResults);
  }

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
