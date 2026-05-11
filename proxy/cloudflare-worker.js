const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

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
    headers: { ...JSON_HEADERS, ...corsHeaders(env) },
  });
}

function withCors(response, env) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(env))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function proxyClaude(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "Missing ANTHROPIC_API_KEY" }, 500, env);
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": env.ANTHROPIC_VERSION || "2023-06-01",
      },
      body: await request.text(),
    });

    return withCors(upstream, env);
  } catch (error) {
    return jsonResponse({ error: "Claude upstream unavailable", detail: error.message }, 502, env);
  }
}

async function proxyWhisper(request, env) {
  if (!env.OPENAI_API_KEY) {
    return jsonResponse({ error: "Missing OPENAI_API_KEY" }, 500, env);
  }

  const contentType = request.headers.get("content-type");
  if (!contentType || !contentType.includes("multipart/form-data")) {
    return jsonResponse({ error: "Expected multipart/form-data" }, 400, env);
  }

  try {
    const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": contentType,
      },
      body: request.body,
    });

    return withCors(upstream, env);
  } catch (error) {
    return jsonResponse({ error: "Whisper upstream unavailable", detail: error.message }, 502, env);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Use POST" }, 405, env);
    }

    const url = new URL(request.url);
    if (url.pathname === "/api/claude") return proxyClaude(request, env);
    if (url.pathname === "/api/whisper") return proxyWhisper(request, env);

    return jsonResponse(
      {
        error: "Unknown route",
        routes: ["/api/claude", "/api/whisper"],
      },
      404,
      env,
    );
  },
};
