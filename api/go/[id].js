import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://xyfacudywygreaquvzjr.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5ZmFjdWR5d3lncmVhcXV2empyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY4MjQ3MDcsImV4cCI6MjA3MjQwMDcwN30.9-fY6XV7BdPyto1l_xHw7pltmY2mBHj93bdVh418vSI";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  try {
    // Primarno iz query parametara (Vercel stavlja dinamički segment ovde kada ruta radi)
    let id = req?.query?.id;

    // Rezervni načini: parsiranje iz putanje ako iz nekog razloga query izostane
    if (!id && req.url) {
      // /api/go/123  ili  /go/123
      const m1 = req.url.match(/\/api\/go\/([^/?#]+)/);
      const m2 = req.url.match(/\/go\/([^/?#]+)/);
      id = (m1 && m1[1]) || (m2 && m2[1]) || id;
    }

    if (!id) {
      return res.status(400).send("Missing link ID");
    }

    const { data, error } = await supabase
      .from("links")
      .select("url, expires_at")
      .eq("id", id)
      .single();

    if (error || !data) {
      return res.status(404).send("Link not found");
    }

    const now = new Date();
    const expiresAt = new Date(data.expires_at);

    if (isNaN(expiresAt.getTime())) {
      return res.status(500).send("Invalid expiry date on record");
    }

    if (now > expiresAt) {
      return res.status(410).send("This link has expired");
    }

    // 302 redirect ka originalnom URL-u
    return res.redirect(302, data.url);
  } catch (err) {
    console.error("API Error:", err);
    return res.status(500).send("Internal Server Error");
  }
}
