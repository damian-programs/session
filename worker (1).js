/**
 * SESSION mail relay — Cloudflare Worker
 * Greater Cleveland Food Bank / Kids Cafe CACFP
 *
 * Holds the Postmark server token so it never reaches the browser.
 * SESSION posts the Postmark payload here with an X-Session-Key header;
 * this Worker authenticates it, forwards it to Postmark's HTTP API, and
 * returns the result.
 *
 * Secrets (set with `npx wrangler secret put NAME`):
 *   POSTMARK_TOKEN  - the Postmark server token
 *   SESSION_KEY     - a long random string; must match "Relay access key" in SESSION Settings
 *
 * Vars (set in wrangler.toml):
 *   ALLOWED_ORIGINS - comma-separated origins allowed to call this relay
 *   FROM_EMAIL      - verified Postmark sender; overrides whatever the client sends
 *   MESSAGE_STREAM  - default Postmark stream ID if the client doesn't send one
 */

const POSTMARK_URL = 'https://api.postmarkapp.com/email';
const MAX_RECIPIENTS = 50;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowList = (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // With no allow list configured, fall back to '*' so a first deploy works.
    // Set ALLOWED_ORIGINS in wrangler.toml as soon as you know your host.
    const originOk = allowList.length === 0 || allowList.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowList.length === 0 ? '*' : (originOk ? origin : 'null'),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Session-Key',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    // Preflight. SESSION sends a custom header, so the browser always sends this first.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method === 'GET') {
      // Plain health check you can open in a browser tab.
      return reply({ ok: true, service: 'session-mail', configured: !!env.POSTMARK_TOKEN }, 200, cors);
    }

    if (request.method !== 'POST') {
      return reply({ error: 'Method not allowed' }, 405, cors);
    }

    if (!originOk) {
      return reply({ error: 'Origin not allowed: ' + origin }, 403, cors);
    }

    if (!env.POSTMARK_TOKEN) {
      return reply({ error: 'Relay is missing POSTMARK_TOKEN' }, 500, cors);
    }

    if (!env.SESSION_KEY || !safeEqual(request.headers.get('X-Session-Key') || '', env.SESSION_KEY)) {
      return reply({ error: 'Unauthorized — relay access key does not match' }, 401, cors);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return reply({ error: 'Body was not valid JSON' }, 400, cors);
    }

    const recipients = String(payload.To || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!recipients.length) {
      return reply({ error: 'No recipient address' }, 400, cors);
    }
    if (recipients.length > MAX_RECIPIENTS) {
      return reply({ error: 'Too many recipients in one request' }, 400, cors);
    }

    const from = env.FROM_EMAIL || payload.From;
    if (!from) {
      return reply({ error: 'No From address' }, 400, cors);
    }

    const message = {
      From: from,
      To: recipients.join(','),
      Subject: String(payload.Subject || '(no subject)').slice(0, 250),
      TextBody: payload.TextBody || undefined,
      HtmlBody: payload.HtmlBody || undefined,
      Tag: payload.Tag || 'session',
      MessageStream: payload.MessageStream || env.MESSAGE_STREAM || 'outbound',
    };
    if (payload.ReplyTo) message.ReplyTo = payload.ReplyTo;

    let pmRes, pmBody;
    try {
      pmRes = await fetch(POSTMARK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Postmark-Server-Token': env.POSTMARK_TOKEN,
        },
        body: JSON.stringify(message),
      });
      pmBody = await pmRes.json().catch(() => ({}));
    } catch (e) {
      return reply({ error: 'Could not reach Postmark: ' + (e.message || e) }, 502, cors);
    }

    // Postmark returns ErrorCode 0 on success. Anything else is a failure,
    // even when the HTTP status looks fine.
    if (!pmRes.ok || (pmBody.ErrorCode && pmBody.ErrorCode !== 0)) {
      return reply(
        {
          error: pmBody.Message || 'Postmark rejected the message',
          postmarkErrorCode: pmBody.ErrorCode === undefined ? null : pmBody.ErrorCode,
        },
        pmRes.status >= 400 ? pmRes.status : 502,
        cors
      );
    }

    return reply(
      { ok: true, messageId: pmBody.MessageID || null, submittedAt: pmBody.SubmittedAt || null },
      200,
      cors
    );
  },
};

function reply(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// Length-independent comparison so the access key can't be guessed byte by byte.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
