// api/go.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const SUPABASE_URL = "https://xyfacudywygreaquvzjr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5ZmFjdWR5d3lncmVhcXV2empyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY4MjQ3MDcsImV4cCI6MjA3MjQwMDcwN30.9-fY6XV7BdPyto1l_xHw7pltmY2mBHj93bdVh418vSI";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  try {
    const { query } = req;
    const { id } = query;

    if (!id) {
      return res.status(400).send("Missing link ID");
    }

    // Fetch link from DB
    const { data, error } = await supabase
      .from("links")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      return res.status(404).send("Link not found");
    }

    // Check expiry
    const now = new Date();
    const expiresAt = new Date(data.expires_at);

    if (now > expiresAt) {
      return res.status(410).send("This link has expired");
    }

    // Redirect
    return res.redirect(302, data.url);
  } catch (err) {
    console.error("API Error:", err);
    return res.status(500).send("Internal Server Error");
  }
}
