import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: "Missing id parameter" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });

    const { data, error } = await supabase
      .from("links")
      .select("max_opens, open_count")
      .eq("token", id)
      .maybeSingle();

    if (error || !data) {
      return res.status(404).json({ error: "Link not found" });
    }

    return res.status(200).json({
      max_opens: data.max_opens,
      open_count: data.open_count || 0
    });
  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }
}