/**
 * LiteLLM Stripping Proxy
 *
 * Sits in front of LiteLLM and removes reasoning/thinking params that
 * Claude Code CLI sends via the Anthropic /v1/messages endpoint.
 * LiteLLM's adapter translates these to reasoning.effort before its own
 * drop_params runs — so we must strip them upstream before they reach LiteLLM.
 *
 * Listens on :4001, forwards clean requests to LiteLLM on :4000.
 */

'use strict';

const http  = require('http');
const https = require('https');

const LITELLM_HOST = process.env.LITELLM_HOST || 'litellm';
const LITELLM_PORT = parseInt(process.env.LITELLM_PORT || '4000', 10);
const LISTEN_PORT  = parseInt(process.env.PROXY_PORT    || '4001', 10);

// Params to strip from the top-level request body before forwarding.
// Covers both Anthropic format (thinking) and any pre-translated variants.
const DROP_PARAMS = new Set([
  'thinking',
  'reasoning_effort',
  'reasoning',
]);

function stripBody(body) {
  if (!body || typeof body !== 'object') return body;
  const cleaned = { ...body };
  for (const key of DROP_PARAMS) {
    if (key in cleaned) {
      delete cleaned[key];
    }
  }
  // Also strip from nested reasoning object if present (reasoning.effort)
  if (cleaned.reasoning && typeof cleaned.reasoning === 'object') {
    delete cleaned.reasoning;
  }
  return cleaned;
}

const server = http.createServer((req, res) => {
  let rawBody = '';

  req.on('data', chunk => { rawBody += chunk; });

  req.on('end', () => {
    let bodyToSend = rawBody;

    // Only attempt to strip JSON bodies
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json') && rawBody) {
      try {
        const parsed = JSON.parse(rawBody);
        const cleaned = stripBody(parsed);
        bodyToSend = JSON.stringify(cleaned);
      } catch (_) {
        // Not valid JSON — pass through as-is
      }
    }

    const bodyBuffer = Buffer.from(bodyToSend, 'utf8');

    const options = {
      hostname: LITELLM_HOST,
      port:     LITELLM_PORT,
      path:     req.url,
      method:   req.method,
      headers:  {
        ...req.headers,
        host:             `${LITELLM_HOST}:${LITELLM_PORT}`,
        'content-length': bodyBuffer.length,
      },
    };

    const proxyReq = http.request(options, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', err => {
      console.error('[Proxy] Upstream error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
      }
    });

    proxyReq.write(bodyBuffer);
    proxyReq.end();
  });

  req.on('error', err => {
    console.error('[Proxy] Request error:', err.message);
  });
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[Proxy] Stripping proxy listening on :${LISTEN_PORT}`);
  console.log(`[Proxy] Forwarding to LiteLLM at ${LITELLM_HOST}:${LITELLM_PORT}`);
  console.log(`[Proxy] Dropping params: ${[...DROP_PARAMS].join(', ')}`);
});
