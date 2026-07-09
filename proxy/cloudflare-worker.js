/**
 * Cloudflare Worker proxy for Song to App.
 *
 * Routes:
 *   POST /api/claude   → https://api.anthropic.com/v1/messages
 *   POST /api/whisper  → https://api.openai.com/v1/audio/transcriptions
 *
 * Required secrets (set with `wrangler secret put`):
 *   ANTHROPIC_API_KEY
 *   OPENAI_API_KEY
 *
 * Optional env vars:
 *   ALLOWED_ORIGIN      – restrict CORS to a specific origin (default: *)
 *   ANTHROPIC_VERSION   – Anthropic API version header (default: 2023-06-01)
 *   MAX_BODY_BYTES      – max request body size in bytes (default: 26214400 = 25 MB)
 */

const JSON_CT = "application/json; charset=utf-8";
const DEFAULT_MAX_BODY = 26_214_400; // 25 MB

function corsHeaders(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers":
      "content-type, authorization, anthropic-version, x-api-key, anthropic-dangerous-direct-browser-access",
    "access-control-max-age": "86400",
  };
}

function jsonResponse(body, status, env) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": JSON_CT, ...corsHeaders(env) },
  });
}

function withCors(response, env) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(env))) headers.set(k, v);
  // Forward rate-limit headers so the client can back off gracefully
  for (const header of response.headers.keys()) {
    if (header.startsWith("x-ratelimit") || header.startsWith("retry-after")) {
      headers.set(header, response.headers.get(header));
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Read up to maxBytes from a request, returning null if the limit is exceeded.
 * This prevents memory exhaustion from oversized payloads.
 */
async function readBodyWithLimit(request, maxBytes) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel();
      return null; // signal: body too large
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function proxyClaude(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "Server misconfiguration: missing ANTHROPIC_API_KEY." }, 500, env);
  }

  const maxBytes = Number(env.MAX_BODY_BYTES) || DEFAULT_MAX_BODY;
  const bodyBytes = await readBodyWithLimit(request, maxBytes);
  if (bodyBytes === null) {
    return jsonResponse({ error: "Request body too large.", maxBytes }, 413, env);
  }

  // Validate that it is parseable JSON before forwarding
  let parsedBody;
  try {
    parsedBody = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400, env);
  }

  // Ensure streaming is requested — it keeps the worker connection alive
  parsedBody.stream = true;

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": env.ANTHROPIC_VERSION || "2023-06-01",
      },
      body: JSON.stringify(parsedBody),
    });
    return withCors(upstream, env);
  } catch (err) {
    return jsonResponse({ error: "Claude upstream unavailable.", detail: err.message }, 502, env);
  }
}

async function proxyWhisper(request, env) {
  if (!env.OPENAI_API_KEY) {
    return jsonResponse({ error: "Server misconfiguration: missing OPENAI_API_KEY." }, 500, env);
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return jsonResponse({ error: "Expected multipart/form-data for audio transcription." }, 400, env);
  }

  const maxBytes = Number(env.MAX_BODY_BYTES) || DEFAULT_MAX_BODY;
  const bodyBytes = await readBodyWithLimit(request, maxBytes);
  if (bodyBytes === null) {
    return jsonResponse({ error: "Audio file too large.", maxBytes }, 413, env);
  }

  try {
    const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": contentType,
      },
      body: bodyBytes,
    });
    return withCors(upstream, env);
  } catch (err) {
    return jsonResponse({ error: "Whisper upstream unavailable.", detail: err.message }, 502, env);
  }
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed. Use POST.", allowed: ["POST"] }, 405, env);
    }

    const url = new URL(request.url);
    if (url.pathname === "/api/claude")  return proxyClaude(request, env);
    if (url.pathname === "/api/whisper") return proxyWhisper(request, env);

    return jsonResponse({
      error: "Unknown route.",
      routes: { "POST /api/claude": "Proxy to Anthropic Messages API", "POST /api/whisper": "Proxy to OpenAI Whisper" },
    }, 404, env);
  },
};
