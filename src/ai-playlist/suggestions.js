const HISTORY_KEY = "ai_listen_history";
const PERSONA_KEY = "ai_listener_persona";
const MAX_HISTORY = 200;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STOP_WORDS = new Set([
  "make", "create", "give", "want", "need", "play", "songs", "music", "playlist",
  "some", "like", "with", "from", "that", "this", "list", "good", "best", "nice",
  "more", "most", "just", "also",
]);

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch (err) {
    return [];
  }
}

function refreshPersona(history) {
  if (history.length < 3) return;
  const hourCounts = Array(24).fill(0);
  const dayCounts = Array(7).fill(0);
  const moodCounts = {};
  const promptWords = {};

  history.forEach((item) => {
    hourCounts[item.hour] += 1;
    dayCounts[item.day] += 1;
    if (item.mood) moodCounts[item.mood] = (moodCounts[item.mood] || 0) + 1;
    String(item.prompt || "")
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 3 && !STOP_WORDS.has(word))
      .forEach((word) => {
        promptWords[word] = (promptWords[word] || 0) + 1;
      });
  });

  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
  const topMood = Object.entries(moodCounts).sort(([, a], [, b]) => b - a)[0];
  const topWords = Object.entries(promptWords)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([word]) => word);

  localStorage.setItem(PERSONA_KEY, JSON.stringify({
    peakHour,
    peakDay: DAYS[dayCounts.indexOf(Math.max(...dayCounts))],
    topMood: topMood ? topMood[0] : null,
    topWords,
    totalSessions: history.length,
    updatedAt: Date.now(),
  }));
}

export function recordPlay({ prompt, playlistName, songs, mood }) {
  const history = loadHistory();
  history.unshift({
    prompt,
    playlistName,
    songCount: songs.length,
    mood,
    hour: new Date().getHours(),
    day: new Date().getDay(),
    ts: Date.now(),
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
  refreshPersona(history);
}

export function getPersona() {
  try {
    return JSON.parse(localStorage.getItem(PERSONA_KEY) || "null");
  } catch (err) {
    return null;
  }
}

export function getPersonaCard() {
  const persona = getPersona();
  if (!persona || persona.totalSessions < 3) return null;
  const hourLabel = persona.peakHour < 6
    ? "late night"
    : persona.peakHour < 12
      ? "morning"
      : persona.peakHour < 17
        ? "afternoon"
        : persona.peakHour < 21
          ? "evening"
          : "night";
  return {
    headline: "Your listening style",
    lines: [
      `You love listening in the ${hourLabel}.`,
      persona.peakDay ? `${persona.peakDay}s are your favourite day.` : null,
      persona.topMood ? `Your go-to mood is ${persona.topMood}.` : null,
      persona.topWords.length ? `You keep coming back to ${persona.topWords.slice(0, 3).join(", ")}.` : null,
    ].filter(Boolean),
    sessions: persona.totalSessions,
  };
}

export function getSmartSuggestions() {
  const hour = new Date().getHours();
  const day = new Date().getDay();
  const persona = getPersona();
  const history = loadHistory();
  const suggestions = [];

  if (hour >= 22 || hour < 5) suggestions.push("Late night chill songs", "Soft songs for a quiet night");
  else if (hour < 10) suggestions.push("Morning songs to start the day", "Happy upbeat tracks");
  else if (hour < 14) suggestions.push("Feel-good songs for a break");
  else if (hour < 20) suggestions.push("Evening drive playlist", "Songs to unwind after work");
  else suggestions.push("Night drive songs", "Calm songs for the evening");

  if (day === 5 || day === 6) suggestions.push("Weekend party songs");
  if (day === 0) suggestions.push("Slow Sunday morning songs");
  if (persona?.topMood) suggestions.push(`More ${persona.topMood} songs`);

  const popular = [
    "Arijit Singh heartbreak songs",
    "Romantic Hollywood songs for a long drive",
    "90s Bollywood classics",
    "Rainy day songs",
    "Soft romantic dinner music",
  ];
  const recent = new Set(history.slice(0, 10).map((item) => item.prompt));
  return [...suggestions, ...popular.filter((prompt) => !recent.has(prompt))].slice(0, 6);
}

export function extractMood(prompt) {
  const text = prompt.toLowerCase();
  if (/sad|heartbreak|cry|emotional|miss/.test(text)) return "sad";
  if (/happy|fun|party|energy|hype/.test(text)) return "happy";
  if (/chill|relax|calm|soft|sleep/.test(text)) return "chill";
  if (/romantic|love|date|couple/.test(text)) return "romantic";
  if (/drive|road|travel|journey/.test(text)) return "drive";
  if (/workout|gym|run|motivat/.test(text)) return "energetic";
  return "general";
}
