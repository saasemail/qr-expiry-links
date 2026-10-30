// api/qr.js — generates a scannable PNG QR for link previews (og:image)

import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";

function getOrigin(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers["host"] || "").split(",")[0].trim();
  return `${proto}://${host}`;
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

    // DODATO: Umesto parsiranja potpisa, tražimo link direktno u bazi
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(500).send("Server misconfigured");

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    const { data: link, error } = await supabase
      .from("links")
      .select("expires_at")
      .eq("token", id)
      .maybeSingle();

    if (error || !link) return res.status(404).send("Not found");

    if (Date.now() > new Date(link.expires_at).getTime()) return res.status(410).send("Expired");

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
