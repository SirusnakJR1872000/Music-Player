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

function dataUrlFromBase64(b64) {
  const mime = String(b64).startsWith("iVBOR") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${b64}`;
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
    return reply(400, { error: "Invalid JSON" });
  }

  const prompt = String(body.prompt || "").trim().slice(0, 1200);
  const model = String(body.model || "openai/gpt-image-1").trim();
  const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim();
  if (!prompt) return reply(400, { error: "No wallpaper prompt" });
  if (!apiKey) return reply(500, { error: "Add OPENROUTER_API_KEY in the Netlify environment variables." });

  let upstream;
  try {
    upstream = await postJSON(
      "openrouter.ai",
      "/api/v1/images",
      {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://your-playlist.netlify.app",
        "X-Title": "Music Player",
      },
      {
        model,
        prompt,
        aspect_ratio: "16:9",
        quality: "medium",
        output_format: "jpeg",
      }
    );
  } catch (err) {
    return reply(502, { error: "Could not create a wallpaper." });
  }

  const item = Array.isArray(upstream.body?.data) ? upstream.body.data[0] : null;
  const image = item?.b64_json ? dataUrlFromBase64(item.b64_json) : (item?.url || "");
  if (!image) return reply(502, { error: "The wallpaper model did not return an image." });
  return reply(200, { image });
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
