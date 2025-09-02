// ui.js - QR Expiry Links

// Supabase setup
const SUPABASE_URL = "https://xyfacudywygreaquvzjr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh5ZmFjdWR5d3lncmVhcXV2emp..."; 
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const urlInput = document.getElementById("urlInput");
const expiryInput = document.getElementById("expiryInput");
const generateBtn = document.getElementById("generateBtn");

const resultCard = document.getElementById("resultCard");
const qrcodeCanvas = document.getElementById("qrcode");
const generatedLink = document.getElementById("generatedLink");
const expiryHint = document.getElementById("expiryHint");

let expiryTimer;

generateBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  const expiryMinutes = parseInt(expiryInput.value);

  if (!url) {
    alert("Please enter a valid URL.");
    return;
  }
  if (!expiryMinutes || expiryMinutes < 1) {
    alert("Expiry must be at least 1 minute.");
    return;
  }

  clearTimeout(expiryTimer);

  const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("links")
    .insert([{ url, expires_at: expiresAt }])
    .select();

  if (error) {
    console.error("Error saving link:", error);
    alert("An error occurred while saving the link.");
    return;
  }

  const linkId = data[0].id;
  const redirectUrl = `${window.location.origin}/go/${linkId}`;

  generatedLink.textContent = redirectUrl;
  generatedLink.href = redirectUrl;

  QRCode.toCanvas(qrcodeCanvas, redirectUrl, { width: 200 }, function (error) {
    if (error) console.error(error);
  });

  resultCard.classList.remove("hidden");

  expiryHint.textContent = `This link will expire in ${expiryMinutes} minutes.`;

  expiryTimer = setTimeout(() => {
    qrcodeCanvas.getContext("2d").clearRect(0, 0, qrcodeCanvas.width, qrcodeCanvas.height);
    generatedLink.textContent = "";
    expiryHint.textContent = "This link has expired.";
  }, expiryMinutes * 60 * 1000);
});
