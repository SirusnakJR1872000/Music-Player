const CACHE_KEY = "ai_playlist_song_cache";
const MAX_ENTRIES = 2000;
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
  } catch (err) {
    return {};
  }
}

function saveCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch (err) {
    pruneCache(cache, Math.floor(MAX_ENTRIES / 2));
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (retryErr) {
      // The browser refused more storage. Playback still works.
    }
  }
}

function makeKey(title, artist) {
  return `${title.toLowerCase().trim()}|||${artist.toLowerCase().trim()}`;
}

function pruneCache(cache, targetSize) {
  const entries = Object.entries(cache).sort(([, a], [, b]) => a.savedAt - b.savedAt);
  entries.slice(0, Math.max(0, entries.length - targetSize)).forEach(([key]) => {
    delete cache[key];
  });
}

export function getCached(title, artist) {
  const cache = loadCache();
  const key = makeKey(title, artist);
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.savedAt > ENTRY_TTL_MS) {
    delete cache[key];
    saveCache(cache);
    return null;
  }
  return entry.data;
}

export function setCached(title, artist, data) {
  const cache = loadCache();
  cache[makeKey(title, artist)] = { data, savedAt: Date.now() };
  if (Object.keys(cache).length > MAX_ENTRIES) pruneCache(cache, MAX_ENTRIES);
  saveCache(cache);
}

export function splitByCache(songs) {
  const cached = [];
  const uncached = [];
  songs.forEach((song) => {
    const hit = getCached(song.title, song.artist);
    if (hit) cached.push({ ...song, ...hit });
    else uncached.push(song);
  });
  return { cached, uncached };
}

export function bulkSetCache(results) {
  results.forEach((result) => {
    setCached(result.title, result.artist, {
      videoId: result.videoId,
      thumbnail: result.thumbnail,
      duration: result.duration,
      ytTitle: result.ytTitle,
    });
  });
}
