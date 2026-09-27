const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7.2v9.6l8-4.8-8-4.8z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7h2.6v10H8zm5.4 0H16v10h-2.6z"/></svg>';

let player = null;
let playerReady = false;
let songs = [];
let currentIndex = 0;
let isPlaying = false;
let mediaLoaded = false;
let progressInterval = null;
let loadToken = 0;
let embedSkipCount = 0;
let playWhenReady = false;
let userWantsPlayback = false;
let hiddenResumeAttempts = 0;
let progressTicks = 0;
let lyricsToken = 0;
let lyricsForId = "";
let syncedLines = [];
let lyricsFollowTime = false;
let activeLyricIndex = -1;

function isPlaceholder(value) {
  return !value || String(value).includes("YOUR_");
}

let activePlaylist = null;

function playlistChoices() {
  return Array.isArray(CONFIG.PLAYLISTS) ? CONFIG.PLAYLISTS : [];
}

function isConfigured(cfg) {
  return !isPlaceholder(cfg.API_KEY) && !isPlaceholder(cfg.PLAYLIST_ID);
}

function getConfig() {
  return {
    API_KEY: String(CONFIG.API_KEY || "").trim(),
    PLAYLIST_ID: normalizePlaylistId(String(activePlaylist?.playlistId || "")),
  };
}

function normalizePlaylistId(value) {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return url.searchParams.get("list") || trimmed;
  } catch (err) {
    return trimmed;
  }
}

function $(id) {
  return document.getElementById(id);
}

function bindUi() {
  document.querySelectorAll("[data-play-icon]").forEach((el) => {
    el.innerHTML = PLAY_ICON;
  });
  $("playBtn").addEventListener("click", onPlay);
  $("nextBtn").addEventListener("click", () => nextSong(true));
  $("prevBtn").addEventListener("click", prevSong);
  $("progressBar").addEventListener("click", seek);
  $("playlistToggle")?.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePlaylistMenu();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".picker")) closePlaylistMenu();
  });
  document.addEventListener("keydown", onKeyDown);
  $("lyricsToggle")?.addEventListener("click", (event) => {
    event.stopPropagation();
    setLyricsEnabled(!document.body.classList.contains("lyrics-on"));
  });
  setLyricsEnabled(savedLyricsEnabled());
  bindMediaSession();
  bindBackgroundPlayback();
  setupAnalytics();
  tickClock();
  setInterval(tickClock, 1000);
  renderPlaylistMenu();
}

function renderPlaylistMenu() {
  const menu = $("playlistMenu");
  if (!menu) return;
  menu.replaceChildren();
  playlistChoices().forEach((choice) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "option");
    button.dataset.playlist = choice.id;
    button.textContent = choice.label;
    button.setAttribute("aria-selected", String(choice.id === activePlaylist?.id));
    button.addEventListener("click", () => selectPlaylist(choice.id));
    item.append(button);
    menu.append(item);
  });
}

function togglePlaylistMenu() {
  const menu = $("playlistMenu");
  const toggle = $("playlistToggle");
  if (!menu || !toggle) return;
  const open = menu.hidden;
  menu.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
}

function closePlaylistMenu() {
  const menu = $("playlistMenu");
  const toggle = $("playlistToggle");
  if (menu) menu.hidden = true;
  toggle?.setAttribute("aria-expanded", "false");
}

function applyPlaylistTheme() {
  if (!activePlaylist) return;
  document.body.classList.toggle("show-heart", activePlaylist.id === "bollywood-romantic");
  setText("heroTitle", activePlaylist.title);
  setText("heroKicker", activePlaylist.kicker);
  setText("heroTagline", activePlaylist.tagline);
  setText("playlistToggleLabel", activePlaylist.label);
  document.title = `${activePlaylist.label}`;
  const poster = $("poster");
  if (poster && activePlaylist.image) {
    poster.src = activePlaylist.image;
    poster.alt = activePlaylist.label;
  }
  document.querySelectorAll("#playlistMenu button").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.playlist === activePlaylist.id));
  });
}

function selectPlaylist(id) {
  const next = playlistChoices().find((choice) => choice.id === id);
  if (!next || next.id === activePlaylist?.id) {
    closePlaylistMenu();
    return;
  }
  activePlaylist = next;
  applyPlaylistTheme();
  track("playlist_change", { playlist_name: next.label });
  closePlaylistMenu();
  isPlaying = false;
  userWantsPlayback = false;
  mediaLoaded = false;
  embedSkipCount = 0;
  playWhenReady = false;
  setPlayButton(false);
  updateMediaSession();
  resetProgress();
  if (playerReady) loadPlaylist();
  else showLoading();
}

function tickClock() {
  const label = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  $("clock").textContent = label;
  $("clock").dateTime = new Date().toISOString();
}

function bootstrap() {
  try {
    localStorage.removeItem("music-player-config");
    localStorage.removeItem("soundstage-session");
  } catch (err) {
    // Playback does not depend on a saved sign-in.
  }
  activePlaylist = playlistChoices()[0] || null;
  applyPlaylistTheme();
  if (!isConfigured(getConfig())) {
    showError("This playlist is not available right now.");
    return;
  }
  showLoading();
}

window.onYouTubeIframeAPIReady = function onYouTubeIframeAPIReady() {
  player = new YT.Player("ytPlayer", {
    height: "180",
    width: "320",
    playerVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      fs: 0,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
    },
    events: {
      onReady: () => {
        playerReady = true;
        player.setVolume(100);
        const iframe = player.getIframe?.();
        if (iframe) {
          iframe.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
          iframe.setAttribute("playsinline", "1");
          iframe.setAttribute("webkit-playsinline", "1");
        }
        if (activePlaylist?.id === "ai-mix" && songs.length) playSong(currentIndex, { userInitiated: true });
        else if (isConfigured(getConfig())) loadPlaylist();
      },
      onStateChange: onPlayerStateChange,
      onError: onPlayerError,
    },
  });
};

async function loadPlaylist() {
  if (activePlaylist?.id === "ai-mix") return;
  const cfg = getConfig();
  if (!isConfigured(cfg)) {
    showError("This playlist is not available right now.");
    return;
  }

  const token = ++loadToken;
  showLoading();
  setPlayerMessage("");

  try {
    if (playerReady && player?.stopVideo) player.stopVideo();
    mediaLoaded = false;
    isPlaying = false;

    let allSongs = [];
    let nextPageToken = "";
    let page = 0;

    do {
      page += 1;
      const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("maxResults", "50");
      url.searchParams.set("playlistId", cfg.PLAYLIST_ID);
      url.searchParams.set("key", cfg.API_KEY);
      if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);

      const res = await fetch(url);
      const data = await res.json();
      if (token !== loadToken) return;
      if (!res.ok || data.error) {
        showError(data.error?.message || "Could not load that playlist.");
        return;
      }

      const validSongs = (data.items || []).filter((item) => {
        const title = item.snippet?.title;
        const videoId = item.snippet?.resourceId?.videoId;
        return videoId && title !== "Deleted video" && title !== "Private video";
      });
      allSongs = allSongs.concat(validSongs);
      nextPageToken = data.nextPageToken || "";
    } while (nextPageToken && page < 20);

    if (token !== loadToken) return;
    songs = allSongs;
    currentIndex = 0;

    if (songs.length === 0) {
      showError("This playlist has no playable public videos.");
      return;
    }

    $("pageStatus").hidden = true;
    await attachVideoDetails(cfg, token);
    if (token !== loadToken) return;
    updateNowPlaying();
    if (playWhenReady) {
      playWhenReady = false;
      playSong(0, { userInitiated: true });
    }
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    showError("Failed to load the playlist. Check the connection and refresh.");
  }
}

async function attachVideoDetails(cfg, token) {
  const ids = songs.map((song) => song.snippet.resourceId.videoId);
  for (let start = 0; start < ids.length; start += 50) {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("id", ids.slice(start, start + 50).join(","));
    url.searchParams.set("key", cfg.API_KEY);
    const res = await fetch(url);
    const data = await res.json();
    if (token !== loadToken) return;
    const byId = new Map((data.items || []).map((item) => [item.id, item]));
    songs.forEach((song) => {
      const details = byId.get(song.snippet.resourceId.videoId);
      if (!details) return;
      song.durationSeconds = parseIsoDuration(details.contentDetails?.duration);
    });
  }
}

function playSong(index, { userInitiated = false } = {}) {
  if (!songs[index]) return;
  if (!playerReady || !player?.loadVideoById) {
    playWhenReady = true;
    currentIndex = index;
    return;
  }
  if (userInitiated) embedSkipCount = 0;

  currentIndex = index;
  const snippet = songs[index].snippet;
  player.loadVideoById(snippet.resourceId.videoId);
  mediaLoaded = true;
  player.setVolume(100);
  resetProgress();
  if (songs[index].durationSeconds) $("duration").textContent = formatTime(songs[index].durationSeconds);
  updateNowPlaying();
  startProgressTracking();
}

function onPlay() {
  if (!songs.length) {
    playWhenReady = true;
    userWantsPlayback = true;
    enableAudioSession();
    track("play");
    return;
  }
  if (!mediaLoaded) {
    userWantsPlayback = true;
    enableAudioSession();
    track("play");
    playSong(currentIndex, { userInitiated: true });
    return;
  }
  togglePlay();
}

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.ENDED) {
    nextSong(false);
    return;
  }
  if (event.data === YT.PlayerState.PLAYING) {
    hiddenResumeAttempts = 0;
    isPlaying = true;
    embedSkipCount = 0;
    setPlayButton(true);
    setPlayerMessage("");
    updateNowPlaying();
    return;
  }
  if (event.data === YT.PlayerState.PAUSED) {
    if (document.hidden && userWantsPlayback && hiddenResumeAttempts < 4) {
      hiddenResumeAttempts += 1;
      setTimeout(keepPlayingInBackground, 200);
      return;
    }
    isPlaying = false;
    setPlayButton(false);
    updateMediaSession();
  }
}

function onPlayerError(event) {
  const blocked = event.data === 100 || event.data === 101 || event.data === 150 || event.data === 5;
  if (!blocked || songs.length === 0) return;
  embedSkipCount += 1;
  if (embedSkipCount >= songs.length) {
    setPlayButton(false);
    setPlayerMessage("These videos cannot be played in an embedded player.");
    return;
  }
  setPlayerMessage("Skipped a video that cannot be embedded.");
  nextSong(false);
}

function togglePlay() {
  if (!playerReady || !player || songs.length === 0) return;
  const state = player.getPlayerState();
  if (state === YT.PlayerState.PLAYING) {
    userWantsPlayback = false;
    track("pause");
    player.pauseVideo();
    return;
  }
  userWantsPlayback = true;
  enableAudioSession();
  track("play");
  if (state === YT.PlayerState.PAUSED || state === YT.PlayerState.CUED || state === YT.PlayerState.BUFFERING) {
    player.playVideo();
    return;
  }
  playSong(currentIndex, { userInitiated: true });
}

function nextSong(userInitiated = false) {
  if (songs.length === 0) return;
  if (userInitiated) track("next_song");
  playSong(currentIndex < songs.length - 1 ? currentIndex + 1 : 0, { userInitiated });
}

function prevSong() {
  if (songs.length === 0) return;
  track("previous_song");
  playSong(currentIndex > 0 ? currentIndex - 1 : songs.length - 1, { userInitiated: true });
}

function updateNowPlaying() {
  const song = songs[currentIndex];
  if (!song) return;
  const snippet = song.snippet;
  setText("songTitle", cleanTitle(snippet.title));
  setText("channelName", artistName(song));
  setImage($("barArt"), bestThumb(snippet.thumbnails));
  if (!isPlaying && song.durationSeconds) $("duration").textContent = formatTime(song.durationSeconds);
  updateMediaSession();
  const videoId = snippet.resourceId?.videoId || "";
  if (videoId && videoId !== lyricsForId) loadLyrics(song);
}

function startProgressTracking() {
  clearInterval(progressInterval);
  progressInterval = setInterval(updateProgress, 250);
}

function updateProgress() {
  if (!playerReady || !player?.getCurrentTime) return;
  try {
    const current = player.getCurrentTime();
    const total = player.getDuration();
    if (!(total > 0)) return;
    const percent = Math.min(100, (current / total) * 100);
    $("progressFill").style.width = `${percent}%`;
    $("progressBar").setAttribute("aria-valuenow", String(Math.round(percent)));
    $("currentTime").textContent = formatTime(current);
    $("duration").textContent = formatTime(total);
    if (progressTicks++ % 4 === 0) updatePositionState(current, total);
    highlightLyric(current);
  } catch (err) {
    // Metadata is not ready until playback starts.
  }
}

function resetProgress() {
  $("progressFill").style.width = "0%";
  $("progressBar").setAttribute("aria-valuenow", "0");
  $("currentTime").textContent = "0:00";
}

function seek(event) {
  if (!playerReady || !player?.seekTo || !player.getDuration) return;
  const duration = player.getDuration();
  if (!(duration > 0)) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const percent = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  player.seekTo(percent * duration, true);
  track("seek");
  updateProgress();
}

function onKeyDown(event) {
  if (event.code === "Escape") closePlaylistMenu();
  const tag = event.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  switch (event.code) {
    case "Space":
      event.preventDefault();
      onPlay();
      break;
    case "ArrowRight":
      nextSong(true);
      break;
    case "ArrowLeft":
      prevSong();
      break;
    default:
      break;
  }
}

function artistName(song) {
  const owner = song?.snippet?.videoOwnerChannelTitle;
  if (owner && owner !== song.snippet.channelTitle) return owner.replace(/ - Topic$/, "");
  const title = song?.snippet?.title || "";
  const parts = title.split(/\s[-–|]\s/);
  if (parts.length > 1) return parts[parts.length - 1].replace(/\(.*\)/, "").trim();
  return activePlaylist?.kicker?.replace(/ Songs$/, "") || "Playlist";
}

function cleanTitle(title) {
  return String(title || "")
    .replace(/\s*[|\-–]\s*(full song|official|video|audio|lyrics).*$/i, "")
    .trim();
}

function bestThumb(thumbs) {
  const wide = safeThumb(thumbs?.maxres?.url) || safeThumb(thumbs?.medium?.url);
  if (wide) return wide;
  const fallback = safeThumb(thumbs?.high?.url) || safeThumb(thumbs?.standard?.url) || safeThumb(thumbs?.default?.url);
  return fallback.replace("/hqdefault.", "/mqdefault.").replace("/sddefault.", "/mqdefault.");
}

function setImage(image, url) {
  if (!image) return;
  if (url) {
    image.src = url;
    image.hidden = false;
  } else {
    image.removeAttribute("src");
    image.hidden = true;
  }
}

function safeThumb(url) {
  return typeof url === "string" && url.startsWith("https://") ? url : "";
}

function parseIsoDuration(value) {
  const match = String(value || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${secs}`;
  return `${minutes}:${secs}`;
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text ?? "";
}

function measurementId() {
  const id = String(CONFIG.MEASUREMENT_ID || "").trim();
  return /^G-[A-Z0-9]+$/i.test(id) ? id : "";
}

function setupAnalytics() {
  const id = measurementId();
  if (!id || window.gtag) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", id);
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.append(script);
}

function track(eventName, params = {}) {
  if (!measurementId() || typeof window.gtag !== "function") return;
  window.gtag("event", eventName, {
    playlist_name: activePlaylist?.label || "",
    ...params,
  });
}

function enableAudioSession() {
  const session = navigator.audioSession;
  if (!session || session.type === "playback") return;
  try {
    session.type = "playback";
  } catch (err) {
    // Older browsers keep the default audio session.
  }
}

function bindMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const handlers = {
    play: () => {
      userWantsPlayback = true;
      enableAudioSession();
      if (!mediaLoaded) playSong(currentIndex, { userInitiated: true });
      else player?.playVideo?.();
    },
    pause: () => {
      userWantsPlayback = false;
      player?.pauseVideo?.();
    },
    previoustrack: () => prevSong(),
    nexttrack: () => nextSong(true),
    seekbackward: (details) => seekBy(-(details.seekOffset || 10)),
    seekforward: (details) => seekBy(details.seekOffset || 10),
    seekto: (details) => {
      if (details.seekTime == null || !player?.seekTo) return;
      player.seekTo(details.seekTime, true);
      updateProgress();
    },
  };
  Object.entries(handlers).forEach(([action, handler]) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (err) {
      // This browser does not support that lock-screen action.
    }
  });
}

function bindBackgroundPlayback() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenResumeAttempts = 0;
      keepPlayingInBackground();
      return;
    }
    syncPlaybackState();
  });
}

function keepPlayingInBackground() {
  if (!userWantsPlayback || !player?.playVideo) return;
  let state = -1;
  try {
    state = player.getPlayerState();
  } catch (err) {
    return;
  }
  if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) return;
  try {
    player.playVideo();
  } catch (err) {
    // The browser may block playback until the page is visible again.
  }
}

function syncPlaybackState() {
  if (!player?.getPlayerState) return;
  let state = -1;
  try {
    state = player.getPlayerState();
  } catch (err) {
    return;
  }
  isPlaying = state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING;
  setPlayButton(isPlaying);
  updateProgress();
  updateMediaSession();
}

function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const song = songs[currentIndex];
  if (!song) {
    navigator.mediaSession.playbackState = "none";
    return;
  }
  const thumb = bestThumb(song.snippet?.thumbnails);
  const artwork = thumb ? [{ src: thumb, sizes: "320x180", type: "image/jpeg" }] : [];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: cleanTitle(song.snippet?.title),
      artist: artistName(song),
      album: activePlaylist?.label || "",
      artwork,
    });
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  } catch (err) {
    // Metadata can be rejected if the artwork URL is not usable.
  }
}

function updatePositionState(position, duration) {
  if (!navigator.mediaSession?.setPositionState) return;
  if (!(duration > 0) || !Number.isFinite(position)) return;
  const safePosition = Math.min(Math.max(0, position), duration);
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: player?.getPlaybackRate?.() || 1,
      position: safePosition,
    });
  } catch (err) {
    // Position state is optional on some browsers.
  }
}

function seekBy(delta) {
  if (!player?.getCurrentTime || !player.seekTo) return;
  const duration = player.getDuration?.() || 0;
  const next = Math.min(Math.max(0, player.getCurrentTime() + delta), duration || Number.POSITIVE_INFINITY);
  player.seekTo(next, true);
  updateProgress();
}

function setPlayButton(playing) {
  document.querySelectorAll("[data-play-icon]").forEach((icon) => {
    icon.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  });
  $("playBtn")?.setAttribute("aria-label", playing ? "Pause" : "Play");
  $("barArt")?.classList.toggle("is-spinning", playing);
}

function setPlayerMessage(message) {
  const el = $("playerMessage");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message;
}

function showLoading() {
  setText("songTitle", "Loading playlist");
  setText("channelName", "");
  if ($("pageStatus")) $("pageStatus").hidden = true;
  lyricsForId = "";
  syncedLines = [];
  lyricsFollowTime = false;
  activeLyricIndex = -1;
  renderLyricsMessage("Lyrics will appear with the song.");
}

function savedLyricsEnabled() {
  try {
    return localStorage.getItem("music-player-lyrics") !== "off";
  } catch (err) {
    return true;
  }
}

function setLyricsEnabled(on) {
  document.body.classList.toggle("lyrics-on", on);
  const toggle = $("lyricsToggle");
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(on));
    toggle.setAttribute("aria-label", on ? "Turn lyrics off" : "Turn lyrics on");
  }
  const panel = $("lyricsPanel");
  if (panel) panel.hidden = !on;
  try {
    localStorage.setItem("music-player-lyrics", on ? "on" : "off");
  } catch (err) {
    // The choice still applies for this visit.
  }
}

function renderLyricsMessage(message) {
  const body = $("lyricsBody");
  if (!body) return;
  body.style.height = "";
  body.replaceChildren();
  const status = document.createElement("p");
  status.className = "lyrics-status";
  status.textContent = message;
  body.append(status);
}

function lyricsSearchTitle(title) {
  return cleanTitle(title)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadLyrics(song) {
  const videoId = song?.snippet?.resourceId?.videoId || "";
  const token = ++lyricsToken;
  lyricsForId = videoId;
  syncedLines = [];
  lyricsFollowTime = false;
  activeLyricIndex = -1;
  renderLyricsMessage("Finding lyrics…");

  const track = lyricsSearchTitle(song.snippet?.title || "");
  const artist = artistName(song);
  const duration = Number(song.durationSeconds) || 0;
  if (!track) {
    renderLyricsMessage("Lyrics aren’t available for this song.");
    return;
  }

  try {
    const record = await findLyrics(track, artist, duration);
    if (token !== lyricsToken) return;
    if (!record || record.instrumental || (!record.plainLyrics && !record.syncedLyrics)) {
      renderLyricsMessage("Lyrics aren’t available for this song.");
      return;
    }
    syncedLines = parseSyncedLyrics(record.syncedLyrics);
    lyricsFollowTime = syncedLines.length > 0;
    if (!syncedLines.length) {
      syncedLines = plainLyricLines(record.plainLyrics, duration);
      lyricsFollowTime = duration > 0 && syncedLines.length > 1;
    }
    if (!syncedLines.length) {
      renderLyricsMessage("Lyrics aren’t available for this song.");
      return;
    }
    renderLyricLines();
  } catch (err) {
    if (token !== lyricsToken) return;
    renderLyricsMessage("Lyrics aren’t available for this song.");
  }
}

function hasLyricText(item) {
  return Boolean(item && !item.instrumental && (item.plainLyrics || item.syncedLyrics));
}

async function findLyrics(track, artist, duration) {
  const candidates = [];
  const exact = new URL("https://lrclib.net/api/get");
  exact.searchParams.set("track_name", track);
  if (artist) exact.searchParams.set("artist_name", artist);
  if (duration > 0) exact.searchParams.set("duration", String(Math.round(duration)));
  const exactResponse = await fetch(exact);
  if (exactResponse.ok) {
    const record = await exactResponse.json();
    if (hasLyricText(record)) candidates.push(record);
  }

  const search = new URL("https://lrclib.net/api/search");
  search.searchParams.set("track_name", track);
  if (artist) search.searchParams.set("artist_name", artist);
  const searchResponse = await fetch(search);
  if (searchResponse.ok) {
    const matches = await searchResponse.json();
    if (Array.isArray(matches)) candidates.push(...matches.filter(hasLyricText));
  }

  return candidates.sort((a, b) => lyricScore(a, track, duration) - lyricScore(b, track, duration))[0] || null;
}

function lyricScore(item, track, duration) {
  const name = String(item.trackName || "").toLowerCase();
  const wanted = String(track || "").toLowerCase();
  let score = 0;
  if (name !== wanted) score += 40;
  if (/\b(lofi|remix|karaoke|instrumental|reprise|slowed)\b/.test(name)) score += 80;
  if (!item.syncedLyrics) score += 8;
  if (duration > 0 && item.duration > 0) score += Math.abs(item.duration - duration) / 8;
  return score;
}

function parseSyncedLyrics(value) {
  const lines = [];
  String(value || "").split(/\r?\n/).forEach((row) => {
    const stamps = [...row.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const text = row.replace(/\[[\d:.]+\]/g, "").trim();
    if (!stamps.length || !text) return;
    stamps.forEach((stamp) => {
      lines.push({ time: Number(stamp[1]) * 60 + Number(stamp[2]), text });
    });
  });
  return lines.sort((a, b) => a.time - b.time);
}

function plainLyricLines(value, duration) {
  const rows = String(value || "").split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  if (!rows.length) return [];
  const step = duration > 0 ? duration / rows.length : 0;
  return rows.map((text, index) => ({ time: step * index, text }));
}

function renderLyricLines() {
  const body = $("lyricsBody");
  if (!body || !syncedLines.length) return;
  body.replaceChildren();
  const track = document.createElement("div");
  track.className = "lyrics-track";
  track.id = "lyricsTrack";
  syncedLines.forEach((line) => {
    const paragraph = document.createElement("p");
    paragraph.className = "lyrics-line is-upcoming";
    paragraph.textContent = line.text;
    track.append(paragraph);
  });
  body.append(track);
  activeLyricIndex = -1;
  positionLyric(0, false);
}

function positionLyric(index, animate) {
  const body = $("lyricsBody");
  const track = $("lyricsTrack");
  const line = track?.children[index];
  if (!body || !track || !line) return;
  activeLyricIndex = index;
  [...track.children].forEach((item, lineIndex) => {
    item.classList.toggle("is-current", lineIndex === index);
    item.classList.toggle("is-upcoming", lineIndex !== index);
  });
  const visibleCount = Math.min(4, track.children.length - index);
  let height = 0;
  for (let i = 0; i < visibleCount; i += 1) height += track.children[index + i].offsetHeight;
  height += 12 * Math.max(0, visibleCount - 1);
  body.style.height = `${height}px`;
  track.style.transition = animate ? "transform 0.6s ease" : "none";
  track.style.transform = `translateY(${-line.offsetTop}px)`;
}

function highlightLyric(seconds) {
  if (!lyricsFollowTime || !syncedLines.length) return;
  let index = 0;
  if (seconds >= syncedLines[0].time) {
    for (let i = 0; i < syncedLines.length; i += 1) {
      if (syncedLines[i].time <= seconds) index = i;
      else break;
    }
  }
  if (index === activeLyricIndex) return;
  positionLyric(index, true);
}

function showError(message) {
  setText("songTitle", "Playlist unavailable");
  setText("channelName", "");
  const status = $("pageStatus");
  if (status) {
    status.hidden = false;
    status.textContent = message;
  }
}

window.loadAIQueue = function loadAIQueue(tracks, meta = {}) {
  const playable = (tracks || []).filter((track) => track && track.videoId);
  if (!playable.length) return false;
  loadToken += 1;
  songs = playable.map((track) => ({
    durationSeconds: Number(track.duration) || 0,
    snippet: {
      title: track.title || "Untitled",
      videoOwnerChannelTitle: track.artist || "",
      thumbnails: track.thumbnail ? { medium: { url: track.thumbnail } } : {},
      resourceId: { videoId: track.videoId },
    },
  }));
  currentIndex = 0;
  embedSkipCount = 0;
  mediaLoaded = false;
  userWantsPlayback = true;
  playWhenReady = false;
  if (meta.name) setText("playlistToggleLabel", meta.name);
  const status = $("pageStatus");
  if (status) status.hidden = true;
  document.querySelectorAll("#playlistMenu button").forEach((button) => {
    button.setAttribute("aria-selected", "false");
  });
  activePlaylist = {
    ...(activePlaylist || {}),
    id: "ai-mix",
    label: meta.name || "Music AI",
  };
  track("playlist_change", { playlist_name: meta.name || "Music AI" });
  playSong(0, { userInitiated: true });
  return true;
};

bindUi();
bootstrap();

setTimeout(() => {
  if (!playerReady && isConfigured(getConfig())) {
    showError("The player did not load. Check your connection and refresh.");
  }
}, 15000);
