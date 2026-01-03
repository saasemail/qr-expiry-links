// api/go.js — Edge runtime, verifikacija istim secret-om kao u /api/create
export const config = { runtime: "edge" };

function b64urlToBytes(b64u) {
  const s = b64u.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  // chunk to avoid call stack limits
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmacBytes(payload, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return new Uint8Array(sig);
}

async function hmacB64url(payload, secret, truncBytes = null) {
  const bytes = await hmacBytes(payload, secret);
  const out = truncBytes ? bytes.subarray(0, truncBytes) : bytes;
  return bytesToB64url(out);
}

function parseV2Payload(bytes) {
  // [1 byte version=2][4 bytes expirySeconds BE][utf8 url bytes]
  if (!bytes || bytes.length < 6) return null;
  if (bytes[0] !== 2) return null;

  const expSec = (
    (bytes[1] << 24) |
    (bytes[2] << 16) |
    (bytes[3] << 8) |
    (bytes[4])
  ) >>> 0;

  const urlBytes = bytes.subarray(5);
  const u = new TextDecoder().decode(urlBytes);
  if (!u) return null;

  return { u, eMs: expSec * 1000, v: 2 };
}

function parseV1Payload(bytes) {
  // v1 was base64url(JSON string) where JSON has {u, e, v}
  try {
    const str = new TextDecoder().decode(bytes);
    const obj = JSON.parse(str);
    if (!obj?.u || !obj?.e) return null;
    const eMs = new Date(obj.e).getTime();
    if (!Number.isFinite(eMs)) return null;
    return { u: obj.u, eMs, v: obj.v || 1 };
  } catch {
    return null;
  }
}

export default async function handler(req) {
  const url = new URL(req.url);

  // podržavamo i /api/go?id=... i /go/<id> (preko rewrite-a)
  let id = url.searchParams.get("id");
  if (!id) {
    const parts = url.pathname.split("/");
    const idx = parts.indexOf("go");
    if (idx >= 0 && parts[idx + 1]) id = parts[idx + 1];
  }

  if (!id || !id.includes(".")) return new Response("Not found", { status: 404 });

  const [payloadB64, sig] = id.split(".");

  // KLJUČNO: koristi isti ENV kao /api/create
  const secret = process.env.SIGNING_SECRET || "dev-secret";

  // Accept both:
  // - v2 short tag (12 bytes => 16 chars b64url)
  // - legacy full tag (32 bytes => 43 chars b64url)
  const expectedShort = await hmacB64url(payloadB64, secret, 12);
  if (sig !== expectedShort) {
    const expectedFull = await hmacB64url(payloadB64, secret, null);
    if (sig !== expectedFull) return new Response("Invalid link", { status: 400 });
  }

  let payloadBytes;
  try {
    payloadBytes = b64urlToBytes(payloadB64);
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  const p2 = parseV2Payload(payloadBytes);
  const p1 = p2 ? null : parseV1Payload(payloadBytes);
  const payload = p2 || p1;

  if (!payload?.u || !payload?.eMs) return new Response("Bad payload", { status: 400 });

  if (Date.now() > payload.eMs) {
    const html = `<!doctype html><meta charset="utf-8"><title>Link expired</title>
    <style>body{font-family:system-ui;padding:40px;background:#0b0b0f;color:#e6e6f0}</style>
    <h1>Link expired</h1><p>This link is no longer available.</p>`;
    return new Response(html, { status: 410, headers: { "content-type": "text/html" } });
  }

  return new Response(null, { status: 302, headers: { Location: payload.u } });
}
