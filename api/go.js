const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://xyfacudywygreaquvzjr.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5ZmFjdWR5d3lncmVhcXV2empyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY4MjQ3MDcsImV4cCI6MjA3MjQwMDcwN30.9-fY6XV7BdPyto1l_xHw7pltmY2mBHj93bdVh418vSI";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

module.exports = async (req, res) => {
  try {
    let id = req?.query?.id;
    if (!id && req.url) {
      const m = req.url.match(/[?&]id=([^&]+)/);
      if (m) id = decodeURIComponent(m[1]);
    }
    if (!id) return res.status(400).send("Missing link ID");

    const { data, error } = await supabase
      .from("links").select("url, expires_at").eq("id", id).single();

    if (error || !data) return res.status(404).send("Link not found");

    const expiresAt = Date.parse(data.expires_at);
    if (!Number.isFinite(expiresAt)) return res.status(500).send("Invalid expiry date on record");
    if (Date.now() > expiresAt) return res.status(410).send("This link has expired");

    res.setHeader("Cache-Control", "no-store");
    res.writeHead(302, { Location: data.url });
    res.end();
  } catch (e) {
    console.error("[go] ERROR", e);
    res.status(500).send("Internal Server Error");
  }
};
