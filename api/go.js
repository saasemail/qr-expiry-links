// api/go.js — Redirect na originalni URL ako link nije istekao
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).send("Server not configured (missing env)");
    }
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // ID stiže kao query (?id=xxxxx) iz vercel.json rute
    const id = req.query?.id || req.query?.ID || null;
    if (!id) return res.status(400).send("Missing link id");

    // Nađi link
    const { data: link, error } = await admin
      .from("links")
      .select("id,url,expires_at,plan,tier")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error("[go] select error:", error.message || error);
      return res.status(500).send("Lookup failed");
    }
    if (!link) return res.status(404).send("Link not found");

    const now = Date.now();
    const exp = new Date(link.expires_at).getTime();
    if (!exp || exp <= now) {
      // Opcija: vrati mali HTML umesto plain teksta
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(410).end(`
        <!doctype html><meta charset="utf-8">
        <title>Link expired</title>
        <body style="font-family:system-ui;display:grid;place-items:center;height:100vh">
          <div style="text-align:center">
            <h1>Link expired</h1>
            <p>This QR link is no longer available.</p>
          </div>
        </body>
      `);
    }

    // Log click (best effort)
    try {
      const ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
      const ua = (req.headers["user-agent"] || "").slice(0, 300);
      await admin.from("link_events").insert([{
        link_id: link.id, event: "click", ip, user_agent: ua, plan: link.plan, tier: link.tier
      }]);
    } catch (e) {
      console.warn("[go] event log failed:", e?.message || e);
    }

    res.writeHead(302, {
      Location: link.url,
      "Cache-Control": "no-store, max-age=0"
    });
    res.end();
  } catch (e) {
    console.error("[go] ERROR:", e?.message || e);
    res.status(500).send("Internal Server Error");
  }
}
