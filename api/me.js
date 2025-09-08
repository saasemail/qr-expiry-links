// api/me.js — vrati status naloga i Pro info
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    const auth = String(req.headers["authorization"] || "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const jwt = m?.[1] || null;
    if (!jwt) return res.status(401).send("Unauthorized");

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE) return res.status(500).send("Server not configured");

    const pub = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: userData, error: userErr } = await pub.auth.getUser(jwt);
    if (userErr || !userData?.user) return res.status(401).send("Unauthorized");
    const user = userData.user;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const { data: rows, error } = await admin
      .from("tokens")
      .select("tier,max_minutes,expires_at")
      .eq("user_id", user.id)
      .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
      .order("max_minutes", { ascending: false })
      .limit(1);
    if (error) return res.status(500).send("DB error");

    const best = rows?.[0] || null;
    const pro = best ? {
      has: true,
      tier: best.tier,
      max_minutes: best.max_minutes,
      expires_at: best.expires_at
    } : { has: false };

    res.status(200).json({
      email: user.email,
      user_id: user.id,
      pro
    });
  } catch (e) {
    console.error("[me] ERROR:", e?.message || e);
    res.status(500).send("Internal Server Error");
  }
}
