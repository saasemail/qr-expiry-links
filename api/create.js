export const config = { runtime: 'edge' };

function b64url(s) {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function hmac(payload, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const bytes = String.fromCharCode(...new Uint8Array(sig));
  return b64url(bytes);
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }

  const url = String(body?.url || '');
  const minutesIn = parseInt(body?.minutes, 10);
  const minutes = Number.isFinite(minutesIn) ? Math.max(1, Math.min(minutesIn, 43200)) : 10; // max 30d
  const token = (body?.token || '').trim();

  if (!/^https?:\/\//i.test(url)) return new Response('Invalid URL', { status: 400 });
  if (minutes > 60 && !token) {
    return new Response('Pro required: set a Pro code to exceed 60 minutes.', { status: 401 });
  }

  const expires_at = new Date(Date.now() + minutes * 60_000).toISOString();
  const payload = b64url(JSON.stringify({ u: url, e: expires_at, v: 1 }));

  const secret = process.env.LINK_SECRET || 'dev-secret';
  const sig = await hmac(payload, secret);
  const id = `${payload}.${sig}`;

  return new Response(JSON.stringify({
    id, expires_at, minutes, plan: token ? 'pro' : 'free'
  }), { headers: { 'content-type': 'application/json' }});
}
