/* ui.js
 * Client-only UI logic for TempQR
 * - Generates QR based on a short/redirect link returned by /api/create
 * - Handles copy, download, share, countdown
 * - Supports "custom duration" and presets
 */

const urlInput = document.getElementById("urlInput");
const expirySelect = document.getElementById("expirySelect");
const customExpiryWrap = document.getElementById("customExpiryWrap");
const customDays = document.getElementById("customDays");
const customHours = document.getElementById("customHours");
const customMinutes = document.getElementById("customMinutes");
const customDurationHint = document.getElementById("customDurationHint");

const generateBtn = document.getElementById("generateBtn");
const resultCard = document.getElementById("resultCard");
const qrcodeEl = document.getElementById("qrcode");
const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");
const shareBtn = document.getElementById("shareBtn");
const downloadSvgBtn = document.getElementById("downloadSvgBtn");

const generatedLink = document.getElementById("generatedLink");
const countdownEl = document.getElementById("countdown");
const expiryHint = document.getElementById("expiryHint");

let lastShortUrl = "";
let lastExpiresAt = 0;
let countdownTimer = null;
let qrInstance = null;

// ---------- helpers ----------
function isValidUrl(value) {
  try {
    const u = new URL(value.includes("://") ? value : "https://" + value);
    return !!u.hostname;
  } catch (e) {
    return false;
  }
}

function normalizeUrl(value) {
  if (!value.includes("://")) return "https://" + value;
  return value;
}

function getCustomMinutesTotal() {
  const d = Number(customDays.value || 0);
  const h = Number(customHours.value || 0);
  const m = Number(customMinutes.value || 0);
  const total = d * 24 * 60 + h * 60 + m;
  return total;
}

function clampCustomDuration(minutes) {
  // Max ~10 years
  const max = 10 * 365 * 24 * 60;
  if (minutes < 1) return 1;
  if (minutes > max) return max;
  return minutes;
}

function setCustomHint(totalMinutes) {
  if (!customDurationHint) return;
  const max = 10 * 365 * 24 * 60;
  if (totalMinutes >= max) {
    customDurationHint.textContent = "Max reached (~10 years).";
  } else if (totalMinutes < 1) {
    customDurationHint.textContent = "Minimum is 1 minute.";
  } else {
    customDurationHint.textContent = "Tip: set a mix of days, hours, and minutes. Max ~10 years.";
  }
}

function msToHMS(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch (e2) {
      document.body.removeChild(ta);
      return false;
    }
  }
}

function setButtonsEnabled(enabled) {
  copyBtn.disabled = !enabled;
  downloadBtn.disabled = !enabled;
  shareBtn.disabled = !enabled;
  downloadSvgBtn.disabled = !enabled;
}

// ---------- UI events ----------
expirySelect?.addEventListener("change", () => {
  const isCustom = expirySelect.value === "custom";
  customExpiryWrap.style.display = isCustom ? "block" : "none";

  if (isCustom) {
    const t = getCustomMinutesTotal();
    setCustomHint(t);
  }
});

[customDays, customHours, customMinutes].forEach((el) => {
  el?.addEventListener("input", () => {
    const total = getCustomMinutesTotal();
    setCustomHint(total);
  });
});

// ---------- QR ----------
function renderQR(shortUrl) {
  qrcodeEl.innerHTML = "";
  qrInstance = new QRCode(qrcodeEl, {
    text: shortUrl,
    width: 220,
    height: 220,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M,
  });
}

function downloadPNG(filename = "tempqr.png") {
  const img = qrcodeEl.querySelector("img");
  const canvas = qrcodeEl.querySelector("canvas");
  let dataUrl = "";

  if (img?.src) dataUrl = img.src;
  else if (canvas) dataUrl = canvas.toDataURL("image/png");

  if (!dataUrl) return;

  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function canvasToSVGDataURL(canvas) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const imgData = ctx.getImageData(0, 0, w, h).data;

  // Build a very simple pixel-based SVG (compact enough for QR)
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  svg += `<rect width="100%" height="100%" fill="#fff"/>`;

  // Draw dark pixels as 1x1 rects
  // (This is not the most efficient possible, but works well and is deterministic.)
  svg += `<g fill="#000">`;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = imgData[i], g = imgData[i + 1], b = imgData[i + 2], a = imgData[i + 3];
      // dark pixel threshold
      if (a > 0 && r < 100 && g < 100 && b < 100) {
        svg += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
      }
    }
  }
  svg += `</g></svg>`;

  const blob = new Blob([svg], { type: "image/svg+xml" });
  return URL.createObjectURL(blob);
}

function downloadSVG(filename = "tempqr.svg") {
  const canvas = qrcodeEl.querySelector("canvas");
  if (!canvas) return;
  const url = canvasToSVGDataURL(canvas);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- countdown ----------
function expireUINow() {
  clearInterval(countdownTimer);
  countdownEl.textContent = "Link expired";
  generatedLink.textContent = "";
  generatedLink.removeAttribute("href");
  expiryHint.textContent = "This temporary link is no longer available.";
  setButtonsEnabled(false);
}

function startCountdown(expiresAtMs) {
  clearInterval(countdownTimer);
  const tick = () => {
    const left = expiresAtMs - Date.now();
    if (left <= 0) {
      expireUINow();
      return;
    }
    countdownEl.textContent = `Expires in: ${msToHMS(left)}`;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

// ---------- API ----------
async function fetchJSON(url, opts) {
  const res = await fetch(url, { ...opts });
  const txt = await res.text();
  try {
    return { ok: res.ok, status: res.status, json: JSON.parse(txt) };
  } catch {
    return { ok: res.ok, status: res.status, json: { error: txt || "Invalid response" } };
  }
}

// ---------- generate ----------
generateBtn?.addEventListener("click", async () => {
  const raw = (urlInput.value || "").trim();
  if (!raw) {
    alert("Please enter a URL.");
    return;
  }
  if (!isValidUrl(raw)) {
    alert("Please enter a valid URL (example.com or https://example.com).");
    return;
  }

  const url = normalizeUrl(raw);

  let minutes = 0;
  if (expirySelect.value === "custom") {
    minutes = clampCustomDuration(getCustomMinutesTotal());
    setCustomHint(minutes);
  } else {
    minutes = Number(expirySelect.value);
    if (!minutes || minutes < 1) minutes = 5;
  }

  generateBtn.disabled = true;
  generateBtn.textContent = "Generating...";
  setButtonsEnabled(false);

  try {
    const payload = { url, minutes };

    const { ok, json } = await fetchJSON("/api/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!ok || !json?.shortUrl) {
      const msg = json?.error || "Failed to generate link.";
      alert(msg);
      return;
    }

    lastShortUrl = json.shortUrl;
    lastExpiresAt = json.expiresAt;

    // show UI
    resultCard.style.display = "block";
    generatedLink.href = lastShortUrl;
    generatedLink.textContent = lastShortUrl;
    expiryHint.textContent = "";

    renderQR(lastShortUrl);
    setButtonsEnabled(true);

    startCountdown(lastExpiresAt);
  } catch (e) {
    console.error(e);
    alert("Something went wrong. Please try again.");
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate QR Code";
  }
});

// ---------- actions ----------
copyBtn?.addEventListener("click", async () => {
  if (!lastShortUrl) return;
  const ok = await copyText(lastShortUrl);
  copyBtn.textContent = ok ? "Copied!" : "Copy failed";
  setTimeout(() => (copyBtn.textContent = "Copy Link"), 900);
});

downloadBtn?.addEventListener("click", () => {
  if (!lastShortUrl) return;
  downloadPNG("tempqr.png");
});

downloadSvgBtn?.addEventListener("click", () => {
  if (!lastShortUrl) return;
  downloadSVG("tempqr.svg");
});

shareBtn?.addEventListener("click", async () => {
  if (!lastShortUrl) return;

  // Prefer native share if available
  if (navigator.share) {
    try {
      await navigator.share({
        title: "TempQR",
        text: "Temporary QR code (expires automatically):",
        url: lastShortUrl,
      });
      return;
    } catch (e) {
      // fall back below
    }
  }

  // fallback: copy
  const ok = await copyText(lastShortUrl);
  shareBtn.textContent = ok ? "Link copied" : "Copy failed";
  setTimeout(() => (shareBtn.textContent = "Share"), 900);
});

// Basic init
setButtonsEnabled(false);
