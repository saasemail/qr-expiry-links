// ui.js — QR Expiry Links (Free vs Pro via /api/create)

const urlInput = document.getElementById("urlInput");
const expiryInput = document.getElementById("expiryInput");
const tokenInput = document.getElementById("tokenInput");

const generateBtn = document.getElementById("generateBtn");

const resultCard = document.getElementById("resultCard");
const qrcodeCanvas = document.getElementById("qrcode");
const generatedLink = document.getElementById("generatedLink");
const expiryHint = document.getElementById("expiryHint");
const countdownEl = document.getElementById("countdown");
const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");

let expiryTimer;
let countdownTimer;
let lastRedirectUrl = "";

function setLoading(state) {
  generateBtn.disabled = state;
  generateBtn.textContent = state ? "Generating..." : "Generate QR";
}

async function createLink(url, minutes, token) {
  const resp = await fetch("/api/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, minutes, token }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    try {
      const maybeJson = JSON.parse(text);
      throw new Error(maybeJson?.message || maybeJson || text || "Create failed");
    } catch {
      throw new Error(text || "Create failed");
    }
  }

  return resp.json(); // { id, expires_at, plan, tier, minutes }
}

function formatCountdown(ms) {
  if (ms <= 0) return "00:00:00";
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function startCountdown(isoExpires) {
  const end = new Date(isoExpires).getTime();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    const left = end - Date.now();
    if (left <= 0) {
      clearInterval(countdownTimer);
      countdownEl.textContent = "Expired";
      // Also clear visuals
      const ctx = qrcodeCanvas.getContext("2d");
      ctx.clearRect(0, 0, qrcodeCanvas.width, qrcodeCanvas.height);
      generatedLink.textContent = "";
      expiryHint.textContent = "This link has expired.";
      return;
    }
    countdownEl.textContent = formatCountdown(left);
  }, 1000);
}

generateBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  const minutes = parseInt(expiryInput.value, 10);
  const token = (tokenInput?.value || "").trim();

  if (!/^https?:\/\//i.test(url)) {
    alert("Please enter a valid URL (include https://).");
    return;
  }
  if (!Number.isFinite(minutes) || minutes < 1) {
    alert("Expiry must be at least 1 minute.");
    return;
  }

  clearTimeout(expiryTimer);
  clearInterval(countdownTimer);
  setLoading(true);

  try {
    const created = await createLink(url, minutes, token);
    const linkId = created.id;
    const redirectUrl = `${window.location.origin}/go/${linkId}`;
    lastRedirectUrl = redirectUrl;

    generatedLink.textContent = redirectUrl;
    generatedLink.href = redirectUrl;

    QRCode.toCanvas(qrcodeCanvas, redirectUrl, { width: 200 }, (err) => {
      if (err) console.error(err);
    });

    resultCard.classList.remove("hidden");
    const endLocal = new Date(created.expires_at);
    expiryHint.textContent = `Plan: ${(created.plan || "free").toUpperCase()} • Expires in ${created.minutes} min • Until ${endLocal.toLocaleString()}`;

    // Visual timeout
    expiryTimer = setTimeout(() => {
      const ctx = qrcodeCanvas.getContext("2d");
      ctx.clearRect(0, 0, qrcodeCanvas.width, qrcodeCanvas.height);
      generatedLink.textContent = "";
      expiryHint.textContent = "This link has expired.";
      countdownEl.textContent = "Expired";
    }, created.minutes * 60_000);

    // Live countdown
    startCountdown(created.expires_at);
  } catch (err) {
    console.error("Create error:", err);
    alert(err.message);
  } finally {
    setLoading(false);
  }
});

copyBtn?.addEventListener("click", async () => {
  try {
    if (!lastRedirectUrl) return;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(lastRedirectUrl);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy link"), 1200);
    } else {
      const ta = document.createElement("textarea");
      ta.value = lastRedirectUrl;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  } catch (e) {
    alert("Could not copy link.");
  }
});

downloadBtn?.addEventListener("click", () => {
  try {
    const url = qrcodeCanvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = "qr-link.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (e) {
    alert("Could not download QR.");
  }
});
