// api/go.js — Edge runtime, verifikacija istim secret-om kao u /api/create
export const config = { runtime: "edge" };

function fromB64url(b64u) {
  const s = b64u.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return atob(s + pad);
}
function toB64url(bytesStr) {
  return btoa(bytesStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function hmac(payload, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return toB64url(String.fromCharCode(...new Uint8Array(sig)));
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

  const expected = await hmac(payloadB64, secret);
  if (sig !== expected) return new Response("Invalid link", { status: 400 });

  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64));
  } catch {
    return new Response("Bad payload", { status: 400 });
  }
  if (!payload?.u || !payload?.e) return new Response("Bad payload", { status: 400 });

  if (Date.now() > new Date(payload.e).getTime()) {
    const html = `<!doctype html><meta charset="utf-8"><title>Link expired</title>
    <style>body{font-family:system-ui;padding:40px;background:#0b0b0f;color:#e6e6f0}</style>
    <h1>Link expired</h1><p>This link is no longer available.</p>`;
    return new Response(html, { status: 410, headers: { "content-type": "text/html" } });
  }

  return new Response(null, { status: 302, headers: { Location: payload.u } });
}
