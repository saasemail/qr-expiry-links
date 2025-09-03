// ui.js - QR Expiry Links (using fetch instead of supabase-js SDK)

const SUPABASE_URL = "https://xyfacudywygreaquvzjr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5ZmFjdWR5d3lncmVhcXV2empyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY4MjQ3MDcsImV4cCI6MjA3MjQwMDcwN30.9-fY6XV7BdPyto1l_xHw7pltmY2mBHj93bdVh418vSI";

// DOM elements
const urlInput = document.getElementById("urlInput");
const expiryInput = document.getElementById("expiryInput");
const generateBtn = document.getElementById("generateBtn");

const resultCard = document.getElementById("resultCard");
const qrcodeCanvas = document.getElementById("qrcode");
const generatedLink = document.getElementById("generatedLink");
const expiryHint = document.getElementById("expiryHint");

let expiryTimer;

// helper: save link via Supabase REST API
async function saveLink(url, expiresAt) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/links`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Prefer: "return=representation"
    },
    body: JSON.stringify([{ url, expires_at: expiresAt }])
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(err);
  }

  const data = await resp.json();
  return data[0]; // vraća { id, url, expires_at }
}

generateBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  const expiryMinutes = parseInt(expiryInput.value);

  if (!url) {
    alert("Please enter a valid URL (include https://).");
    return;
  }
  if (!expiryMinutes || expiryMinutes < 1) {
    alert("Expiry must be at least 1 minute.");
    return;
  }

  clearTimeout(expiryTimer);

  const expiresAt = new Date(Date.now() + expiryMinutes * 60000).toISOString();

  try {
    const saved = await saveLink(url, expiresAt);

    const linkId = saved.id;
    const redirectUrl = `${window.location.origin}/go/${linkId}`;

    generatedLink.textContent = redirectUrl;
    generatedLink.href = redirectUrl;

    QRCode.toCanvas(qrcodeCanvas, redirectUrl, { width: 200 }, (err) => {
      if (err) console.error(err);
    });

    resultCard.classList.remove("hidden");
    expiryHint.textContent = `This link will expire in ${expiryMinutes} minutes.`;

    expiryTimer = setTimeout(() => {
      qrcodeCanvas.getContext("2d").clearRect(0, 0, qrcodeCanvas.width, qrcodeCanvas.height);
      generatedLink.textContent = "";
      expiryHint.textContent = "This link has expired.";
    }, expiryMinutes * 60000);

  } catch (err) {
    console.error("Error saving link:", err);
    alert("Error: " + err.message);
  }
});
