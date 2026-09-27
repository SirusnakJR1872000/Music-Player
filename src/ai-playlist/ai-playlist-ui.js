import { askMusicAI, loadSharedPlaylist } from "./ai-playlist.js";
import { loadSaved, deletePlaylist, incrementPlayCount, copyShareLink } from "./saved-playlists.js";
import { getPersonaCard, getSmartSuggestions } from "./suggestions.js";

const SPARK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.2l1.5 6.3L20 10l-6.5 1.5L12 17.8l-1.5-6.3L4 10l6.5-1.5L12 2.2z"/><path fill="currentColor" d="M18.2 14.2l.7 2.4 2.3.6-2.3.7-.7 2.3-.6-2.3-2.4-.7 2.4-.6.6-2.4z"/></svg>`;
const PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 7.2v9.6l8-4.8-8-4.8z"/></svg>`;
const USER = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.2" fill="currentColor"/><path fill="currentColor" d="M6.2 18.4c.8-2.4 3-3.6 5.8-3.6s5 .1 5.8 3.6c.2.5-.2 1.1-.8 1.1H7c-.6 0-1-.6-.8-1.1z"/></svg>`;

let latestPlaylist = null;
let history = [];
let busy = false;

const ui = {};

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

function scrollThread() {
  ui.thread.scrollTop = ui.thread.scrollHeight;
}

function addBubble(text, role) {
  const row = el("div", `ai-row ai-row-${role}`);
  if (role === "bot") row.append(el("span", "ai-spark", SPARK));
  const bubble = el("div", `ai-bubble ai-bubble-${role}`);
  bubble.textContent = text;
  row.append(bubble);
  if (role === "user") row.append(el("span", "ai-avatar", USER));
  ui.thread.append(row);
  scrollThread();
  return bubble;
}

function showTyping() {
  const row = el("div", "ai-row ai-row-bot");
  row.dataset.typing = "true";
  row.append(el("span", "ai-spark", SPARK));
  const bubble = el("div", "ai-bubble ai-bubble-bot");
  bubble.append(el("span", "ai-typing", "<i></i><i></i><i></i>"));
  row.append(bubble);
  ui.thread.append(row);
  scrollThread();
  return row;
}

function formatLength(songs) {
  const seconds = songs.reduce((sum, song) => sum + (Number(song.duration) || 0), 0);
  const count = `${songs.length} song${songs.length === 1 ? "" : "s"}`;
  if (!seconds) return `Playlist · ${count}`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  const length = hours ? `${hours}h ${minutes}m` : `${minutes}m`;
  return `Playlist · ${count} · ${length}`;
}

function showPlaylistCard(playlist) {
  const card = el("article", "ai-mix");
  const shot = playlist.songs.find((song) => song.thumbnail);
  if (shot) {
    const image = document.createElement("img");
    image.alt = "";
    image.src = shot.thumbnail;
    card.append(image);
  } else {
    card.append(el("div", "ai-mix-fallback"));
  }
  const copy = el("div");
  const title = document.createElement("strong");
  title.textContent = playlist.playlistName || playlist.name || "Playlist";
  const meta = document.createElement("span");
  meta.textContent = formatLength(playlist.songs || []);
  const play = el("button", "ai-play-mix", `${PLAY} Play Playlist`);
  play.type = "button";
  play.addEventListener("click", () => playPlaylist(playlist));
  copy.append(title, meta, play);
  card.append(copy);
  ui.thread.append(card);
  scrollThread();
}

function playPlaylist(playlist) {
  const songs = playlist.songs || [];
  if (typeof window.loadAIQueue !== "function") return;
  const started = window.loadAIQueue(songs, { name: playlist.playlistName || playlist.name || "Music AI" });
  if (!started) {
    addBubble("Those songs are not ready to play yet.", "bot");
    return;
  }
  if (playlist.savedId) incrementPlayCount(playlist.savedId);
  closeChat();
}

function setChips(items) {
  ui.chips.replaceChildren();
  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ai-chip";
    button.textContent = item.label;
    button.addEventListener("click", () => submit(item.prompt));
    ui.chips.append(button);
  });
}

function followUpChips(playlist) {
  const name = playlist.playlistName || playlist.name || "this mix";
  setChips([
    { label: "More like this", prompt: `More songs like ${name}. Keep the same mood.` },
    { label: "Add some classics", prompt: `Add some classic songs to ${name}.` },
    { label: "Make it longer", prompt: `Make ${name} longer with more songs in the same mood.` },
  ]);
}

function remember(role, content) {
  history.push({ role, content: String(content).slice(0, 1500) });
  history = history.slice(-6);
}

async function submit(raw) {
  const prompt = String(raw || "").trim();
  if (!prompt || busy) return;
  busy = true;
  ui.form.reset();
  ui.ideas.hidden = true;
  addBubble(prompt, "user");
  const typing = showTyping();
  try {
    const result = await askMusicAI(prompt, { history });
    typing.remove();
    if (result.type === "chat") {
      addBubble(result.message, "bot");
      remember("user", prompt);
      remember("assistant", result.message);
      return;
    }
    const playlist = result.playlist;
    latestPlaylist = playlist;
    const lead = playlist.message || "Here's a curated playlist just for you.";
    addBubble(lead, "bot");
    if (playlist.description) addBubble(playlist.description, "bot");
    showPlaylistCard(playlist);
    followUpChips(playlist);
    remember("user", prompt);
    remember("assistant", `${lead} Playlist: ${playlist.playlistName}. Songs: ${playlist.songs.map((song) => `${song.title} by ${song.artist}`).join(", ")}`);
  } catch (err) {
    typing.remove();
    addBubble(err.message || "Something went wrong. Please try again.", "bot");
  } finally {
    busy = false;
    ui.input.focus();
  }
}

function closeMenus() {
  ui.menu.hidden = true;
  ui.ideas.hidden = true;
}

function renderMenu() {
  ui.menu.replaceChildren();
  const saved = loadSaved();
  const persona = getPersonaCard();
  if (persona) {
    const label = el("div", "ai-menu-label");
    label.textContent = persona.headline;
    ui.menu.append(label);
    persona.lines.forEach((line) => {
      const note = el("div", "ai-menu-label");
      note.style.letterSpacing = "0";
      note.style.textTransform = "none";
      note.style.fontSize = "12px";
      note.textContent = line;
      ui.menu.append(note);
    });
  }
  const heading = el("div", "ai-menu-label");
  heading.textContent = saved.length ? "Saved playlists" : "Nothing saved yet";
  ui.menu.append(heading);
  saved.forEach((playlist) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = playlist.name;
    button.addEventListener("click", () => {
      closeMenus();
      latestPlaylist = { ...playlist, playlistName: playlist.name };
      addBubble(playlist.description || "A playlist you saved.", "bot");
      showPlaylistCard(latestPlaylist);
      followUpChips(latestPlaylist);
    });
    ui.menu.append(button);
  });
  if (latestPlaylist) {
    const share = document.createElement("button");
    share.type = "button";
    share.textContent = "Copy share link";
    share.addEventListener("click", async () => {
      const { success, link } = await copyShareLink(latestPlaylist);
      share.textContent = success ? "Link copied" : "Copy from the address bar";
      if (!success) ui.input.value = link;
    });
    ui.menu.append(share);
  }
  if (saved[0]) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete latest saved playlist";
    remove.addEventListener("click", () => {
      deletePlaylist(saved[0].id);
      renderMenu();
    });
    ui.menu.append(remove);
  }
}

function openChat() {
  ui.panel.hidden = false;
  ui.launcher.hidden = true;
  document.body.classList.add("ai-chat-open");
  ui.input.focus();
}

function closeChat() {
  closeMenus();
  ui.panel.hidden = true;
  ui.launcher.hidden = false;
  document.body.classList.remove("ai-chat-open");
}

function bindSpeech() {
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  ui.mic.addEventListener("click", () => {
    if (!Speech) {
      addBubble("Voice input is not available in this browser. Type a mood instead.", "bot");
      return;
    }
    const recognition = new Speech();
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      ui.input.value = event.results[0][0].transcript;
      ui.input.focus();
    };
    recognition.start();
  });
}

function build() {
  ui.launcher = el("button", "ai-launcher", SPARK);
  ui.launcher.type = "button";
  ui.launcher.setAttribute("aria-label", "Open Music AI");
  ui.launcher.addEventListener("click", openChat);

  ui.panel = el("section", "ai-chat");
  ui.panel.hidden = true;
  ui.panel.setAttribute("aria-label", "Music AI");

  const head = el("header", "ai-chat-head");
  head.append(el("span", "ai-mark", SPARK));
  const titles = el("div");
  const heading = document.createElement("h2");
  heading.textContent = "Music AI";
  const sub = document.createElement("p");
  sub.textContent = "Your personal music companion";
  titles.append(heading, sub);
  const actions = el("div", "ai-head-actions");
  const more = el("button", "", `<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18" cy="12" r="1.4" fill="currentColor"/></svg>`);
  more.type = "button";
  more.setAttribute("aria-label", "More");
  const close = el("button", "", `<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`);
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", closeChat);
  actions.append(more, close);
  head.append(titles, actions);

  ui.menu = el("div", "ai-menu");
  ui.menu.hidden = true;
  more.addEventListener("click", () => {
    ui.ideas.hidden = true;
    if (ui.menu.hidden) renderMenu();
    ui.menu.hidden = !ui.menu.hidden;
  });

  ui.thread = el("div", "ai-thread");
  ui.chips = el("div", "ai-chips");
  ui.ideas = el("div", "ai-ideas");
  ui.ideas.hidden = true;

  ui.form = el("form", "ai-composer");
  const plus = el("button", "ai-icon-btn", `<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`);
  plus.type = "button";
  plus.setAttribute("aria-label", "Suggestions");
  plus.addEventListener("click", () => {
    ui.menu.hidden = true;
    ui.ideas.replaceChildren();
    getSmartSuggestions().forEach((prompt) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = prompt;
      button.addEventListener("click", () => submit(prompt));
      ui.ideas.append(button);
    });
    ui.ideas.hidden = !ui.ideas.hidden;
  });
  ui.input = document.createElement("input");
  ui.input.type = "text";
  ui.input.maxLength = 200;
  ui.input.placeholder = "Ask for a playlist, song, or mood...";
  ui.input.setAttribute("aria-label", "Message Music AI");
  ui.mic = el("button", "ai-icon-btn", `<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`);
  ui.mic.type = "button";
  ui.mic.setAttribute("aria-label", "Speak");
  ui.send = el("button", "ai-send", `<svg viewBox="0 0 24 24"><path d="M12 17V7M7.5 11.5L12 7l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  ui.send.type = "submit";
  ui.send.setAttribute("aria-label", "Send");
  ui.form.append(plus, ui.input, ui.mic, ui.send);
  ui.form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(ui.input.value);
  });

  ui.panel.append(head, ui.menu, ui.thread, ui.chips, ui.ideas, ui.form);
  document.body.append(ui.launcher, ui.panel);
  addBubble("Hi there! I'm your music assistant. Tell me what you're in the mood for and I'll create the perfect playlist.", "bot");
  bindSpeech();

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !ui.panel.hidden) closeChat();
  });

  const shared = loadSharedPlaylist();
  if (shared) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    latestPlaylist = shared;
    openChat();
    addBubble(shared.description || "Someone shared this playlist with you.", "bot");
    showPlaylistCard(shared);
    followUpChips(shared);
  }
}

build();
