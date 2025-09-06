import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return res.status(500).send("Server not configured (missing env)");
    }
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const id = req.query?.id || null;
    if (!id) return res.status(400).send("Missing link id");

    const { data: link, error } = await admin
      .from("links")
      .select("id,url,expires_at,plan,tier")
      .eq("id", id)
      .maybeSingle();

    if (error) return res.status(500).send("Lookup failed");
    if (!link) return res.status(404).send("Link not found");

    if (!link.expires_at || new Date(link.expires_at).getTime() <= Date.now()) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(410).end("<h1>Link expired</h1><p>This QR link is no longer available.</p>");
    }

    // best-effort log
    try {
      const ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
      const ua = (req.headers["user-agent"] || "").slice(0, 300);
      await admin.from("link_events").insert([{ link_id: link.id, event: "click", ip, user_agent: ua, plan: link.plan, tier: link.tier }]);
    } catch {}

    res.writeHead(302, { Location: link.url, "Cache-Control": "no-store, max-age=0" });
    res.end();
  } catch (e) {
    res.status(500).send("Internal Server Error");
  }
}
