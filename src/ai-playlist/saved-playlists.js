const SAVED_KEY = "ai_saved_playlists";
const MAX_SAVED = 50;

export function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
  } catch (err) {
    return [];
  }
}

export function savePlaylist(playlist) {
  const all = loadSaved();
  const isDupe = all.some(
    (item) => item.prompt === playlist.prompt && Date.now() - item.createdAt < 3600000
  );
  if (isDupe) return all.find((item) => item.prompt === playlist.prompt) || null;

  const entry = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: playlist.playlistName,
    description: playlist.description || "",
    prompt: playlist.prompt || "",
    reasoning: playlist.reasoning || "",
    message: playlist.message || "",
    songs: playlist.songs,
    createdAt: Date.now(),
    playCount: 0,
  };
  localStorage.setItem(SAVED_KEY, JSON.stringify([entry, ...all].slice(0, MAX_SAVED)));
  return entry;
}

export function deletePlaylist(id) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(loadSaved().filter((item) => item.id !== id)));
}

export function incrementPlayCount(id) {
  const all = loadSaved();
  const match = all.find((item) => item.id === id);
  if (!match) return;
  match.playCount = (match.playCount || 0) + 1;
  localStorage.setItem(SAVED_KEY, JSON.stringify(all));
}

export function generateShareLink(playlist) {
  const payload = {
    n: playlist.playlistName || playlist.name,
    d: playlist.description || "",
    p: playlist.prompt || "",
    m: playlist.message || "",
    s: (playlist.songs || []).map((song) => ({
      t: song.title,
      a: song.artist,
      v: song.videoId,
      th: song.thumbnail,
      du: song.duration,
    })),
  };
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  return `${window.location.origin}${window.location.pathname}#ai=${encoded}`;
}

export function readSharedPlaylist() {
  const hash = window.location.hash;
  if (!hash.startsWith("#ai=")) return null;
  try {
    const payload = JSON.parse(decodeURIComponent(escape(atob(hash.slice(4)))));
    return {
      playlistName: payload.n,
      description: payload.d,
      prompt: payload.p,
      message: payload.m,
      songs: (payload.s || []).map((song) => ({
        title: song.t,
        artist: song.a,
        videoId: song.v,
        thumbnail: song.th,
        duration: song.du,
      })),
      isShared: true,
    };
  } catch (err) {
    return null;
  }
}

export async function copyShareLink(playlist) {
  const link = generateShareLink(playlist);
  try {
    await navigator.clipboard.writeText(link);
    return { success: true, link };
  } catch (err) {
    return { success: false, link };
  }
}
