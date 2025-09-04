// api/go.js (ESM)
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      console.error("[go] missing env");
      return res.status(500).send("Server not configured");
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const u = new URL(req.url, `http://${req.headers.host}`);
    let id = u.searchParams.get("id");
    if (!id) {
      const m = u.pathname.match(/\/api\/go\/([^/?#]+)/i);
      if (m) id = decodeURIComponent(m[1]);
    }
    if (!id) return res.status(400).send("Missing link ID");

    const ip =
      (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";
    const ua = (req.headers["user-agent"] || "").slice(0, 300);

    const { data, error } = await admin
      .from("links")
      .select("url, expires_at")
      .eq("id", id)
      .single();

    if (error || !data) {
      console.error("[go] not found:", error?.message);
      return res.status(404).send("Link not found");
    }

    const expiresAt = Date.parse(data.expires_at);
    if (!Number.isFinite(expiresAt)) {
      console.error("[go] invalid expires_at:", data.expires_at);
      return res.status(500).send("Invalid expiry on record");
    }

    if (Date.now() > expiresAt) {
      try {
        await admin.from("link_events").insert([{
          link_id: id,
          event: "expired",
          ip,
          user_agent: ua
        }]);
      } catch (e) {
        console.warn("[go] event log (expired) failed:", e?.message || e);
      }
      return res.status(410).send("This link has expired");
    }

    try {
      await admin.from("link_events").insert([{
        link_id: id,
        event: "hit",
        ip,
        user_agent: ua
      }]);
    } catch (e) {
      console.warn("[go] event log (hit) failed:", e?.message || e);
    }

    res.setHeader("Cache-Control", "no-store");
    res.writeHead(302, { Location: data.url });
    res.end();
  } catch (e) {
    console.error("[go] ERROR:", e?.message || e);
    return res.status(500).send("Internal Server Error");
  }
}
