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
  closePlaylistMenu();
  isPlaying = false;
  mediaLoaded = false;
  embedSkipCount = 0;
  playWhenReady = false;
  setPlayButton(false);
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
        if (isConfigured(getConfig())) loadPlaylist();
      },
      onStateChange: onPlayerStateChange,
      onError: onPlayerError,
    },
  });
};

async function loadPlaylist() {
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
    return;
  }
  if (!mediaLoaded) {
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
    isPlaying = true;
    embedSkipCount = 0;
    setPlayButton(true);
    setPlayerMessage("");
    updateNowPlaying();
    return;
  }
  if (event.data === YT.PlayerState.PAUSED) {
    isPlaying = false;
    setPlayButton(false);
    updateNowPlaying();
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
    player.pauseVideo();
    return;
  }
  if (state === YT.PlayerState.PAUSED || state === YT.PlayerState.CUED || state === YT.PlayerState.BUFFERING) {
    player.playVideo();
    return;
  }
  playSong(currentIndex, { userInitiated: true });
}

function nextSong(userInitiated = false) {
  if (songs.length === 0) return;
  playSong(currentIndex < songs.length - 1 ? currentIndex + 1 : 0, { userInitiated });
}

function prevSong() {
  if (songs.length === 0) return;
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

bindUi();
bootstrap();

setTimeout(() => {
  if (!playerReady && isConfigured(getConfig())) {
    showError("The player did not load. Check your connection and refresh.");
  }
}, 15000);
