// api/qr.js — generates a scannable PNG QR for link previews (og:image)

import crypto from "node:crypto";
import QRCode from "qrcode";

function b64urlToBytes(b64u) {
  const s = String(b64u || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return Buffer.from(s + pad, "base64");
}

function bytesToB64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function hmacB64url(payload, secret, truncBytes = null) {
  const full = crypto.createHmac("sha256", secret).update(payload, "utf8").digest();
  const out = truncBytes ? full.subarray(0, truncBytes) : full;
  return bytesToB64url(out);
}

function parseV2Payload(bytes) {
  // [1 byte version=2][4 bytes expirySeconds BE][utf8 url bytes]
  if (!bytes || bytes.length < 6) return null;
  if (bytes[0] !== 2) return null;

  const expSec = bytes.readUInt32BE(1);
  const urlBytes = bytes.subarray(5);
  const u = urlBytes.toString("utf8");
  if (!u) return null;

  return { u, eMs: expSec * 1000, v: 2 };
}

function parseV1Payload(bytes) {
  try {
    const str = bytes.toString("utf8");
    const obj = JSON.parse(str);
    if (!obj?.u || !obj?.e) return null;
    const eMs = new Date(obj.e).getTime();
    if (!Number.isFinite(eMs)) return null;
    return { u: obj.u, eMs, v: obj.v || 1 };
  } catch {
    return null;
  }
}

function getOrigin(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers["host"] || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  try {
    let id = String(req.query?.id || "").trim();
    if (!id) return res.status(404).send("Not found");

    // allow /qr/<id>.png
    id = decodeURIComponent(id);
    if (id.endsWith(".png")) id = id.slice(0, -4);

    if (!id.includes(".")) return res.status(404).send("Not found");

    const [payloadB64, sig] = id.split(".");
    const secret = process.env.SIGNING_SECRET || "dev-secret";

    // validate signature (short or full)
    const expectedShort = hmacB64url(payloadB64, secret, 12);
    if (sig !== expectedShort) {
      const expectedFull = hmacB64url(payloadB64, secret, null);
      if (sig !== expectedFull) return res.status(400).send("Invalid link");
    }

    let payloadBytes;
    try {
      payloadBytes = b64urlToBytes(payloadB64);
    } catch {
      return res.status(400).send("Bad payload");
    }

    const p2 = parseV2Payload(payloadBytes);
    const p1 = p2 ? null : parseV1Payload(payloadBytes);
    const payload = p2 || p1;

    if (!payload?.u || !payload?.eMs) return res.status(400).send("Bad payload");

    if (Date.now() > payload.eMs) return res.status(410).send("Expired");

    const origin = getOrigin(req);
    const goUrl = `${origin}/go/${encodeURIComponent(id)}`;

    const png = await QRCode.toBuffer(goUrl, {
      type: "png",
      errorCorrectionLevel: "L",
      margin: 4,
      width: 512
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).send(png);
  } catch (e) {
    console.error("[qr] ERROR:", e?.message || e);
    return res.status(500).send("Internal Server Error");
  }
}
