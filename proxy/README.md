# Cloudflare Worker Proxy

This optional proxy keeps API keys off the frontend while preserving the browser app's request shape.

## Routes

- `POST /api/claude` forwards JSON to `https://api.anthropic.com/v1/messages`.
- `POST /api/whisper` forwards multipart audio to `https://api.openai.com/v1/audio/transcriptions`.

## Required Secrets

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put OPENAI_API_KEY
```

## Optional Variables

```bash
ALLOWED_ORIGIN=https://your-github-pages-url
ANTHROPIC_VERSION=2023-06-01
```

## Local Development

```bash
wrangler dev proxy/cloudflare-worker.js
```

Then use these URLs in the app:

```text
Claude Proxy URL: http://127.0.0.1:8787/api/claude
Whisper Proxy URL: http://127.0.0.1:8787/api/whisper
```
