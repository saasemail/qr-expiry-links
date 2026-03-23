import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.ANALYTICS_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.ANALYTICS_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (Array.isArray(xff)) return xff[0] || null;
  if (typeof xff === "string") return xff.split(",")[0].trim();
  return req.headers["x-real-ip"] || null;
}

function safeText(value, max = 500) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!supabase) {
    return res.status(500).json({ ok: false, error: "Supabase is not configured" });
  }

  try {
    const body = typeof req.body === "object" && req.body ? req.body : {};

    const event_type = safeText(body.event_type, 100);
    const page = safeText(body.page, 200);
    const link_id = safeText(body.link_id, 200);
    const content_kind = safeText(body.content_kind, 50);
    const referrer = safeText(body.referrer || req.headers.referer, 500);
    const user_agent = safeText(req.headers["user-agent"], 500);
    const ip = safeText(getClientIp(req), 100);

    if (!event_type) {
      return res.status(400).json({ ok: false, error: "Missing event_type" });
    }

    const { error } = await supabase.from("analytics_events").insert([
      {
        event_type,
        page,
        link_id,
        content_kind,
        referrer,
        user_agent,
        ip,
      },
    ]);

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : "Unexpected error",
    });
  }
}