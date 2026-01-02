// ui.js — FREE version (no Pro / no auth).
// Fix: QR must be scannable. We auto-size QR based on its actual module count
// (because the encoded /go/<id> is long and can require a dense QR version).

const urlInput         = document.getElementById("urlInput");
const expirySelect     = document.getElementById("expirySelect");
const customExpiryWrap = document.getElementById("customExpiryWrap");

const customDays       = document.getElementById("customDays");
const customHours      = document.getElementById("customHours");
const customMinutes    = document.getElementById("customMinutes");
const customDurationHint = document.getElementById("customDurationHint");

const generateBtn      = document.getElementById("generateBtn");

const resultCard       = document.getElementById("resultCard");
const qrcodeCanvas     = document.getElementById("qrcode");
const generatedLink    = document.getElementById("generatedLink");
const expiryHint       = document.getElementById("expiryHint");
const countdownEl      = document.getElementById("countdown");

const copyBtn          = document.getElementById("copyBtn");
const downloadBtn      = document.getElementById("downloadBtn");       // PNG
const downloadSvgBtn   = document.getElementById("downloadSvgBtn");    // SVG (currently hidden in HTML)

let expiryTimer = null;
let countdownTimer = null;
let lastRedirectUrl = "";
let linkExpired = false;

// Track last preset minutes so switching to Custom can prefill nicely
let lastPresetMinutes = 10;
let customTouched = false;

// QR rendering params (tuned for scan reliability)
const QR_ECL = "L";   // lower density than M/Q for long strings
const QR_MARGIN = 4;  // quiet zone (modules)

function setLoading(state) {
  if (!generateBtn) return;
  generateBtn.disabled = state;
  generateBtn.textContent = state ? "Generating..." : "Generate QR";
}

function formatCountdown(ms) {
  ms = Math.max(0, ms | 0);
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

function setDownloadButtonsEnabled(enabled) {
  try {
    if (downloadBtn) downloadBtn.disabled = !enabled;
    if (downloadSvgBtn) downloadSvgBtn.disabled = !enabled;
    if (copyBtn) copyBtn.disabled = !enabled;
  } catch {}
}

function startCountdown(iso) {
  const end = new Date(iso).getTime();
  clearInterval(countdownTimer);

  countdownTimer = setInterval(() => {
    const left = end - Date.now();
    if (left <= 0) {
      clearInterval(countdownTimer);
      countdownEl.textContent = "Expired";

      try {
        const ctx = qrcodeCanvas.getContext("2d");
        ctx.clearRect(0, 0, qrcodeCanvas.width, qrcodeCanvas.height);
      } catch {}

      generatedLink.textContent = "";
      generatedLink.href = "#";
      generatedLink.title = "";
      expiryHint.textContent = "This link has expired.";

      linkExpired = true;
      setDownloadButtonsEnabled(false);
      return;
    }

    countdownEl.textContent = formatCountdown(left);
  }, 1000);
}

async function fetchJSON(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function createLink(url, minutes) {
  return fetchJSON(
    "/api/create",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, minutes })
    },
    15000
  );
}

/** Short display text: show domain + /go/ + short id preview */
function makeDisplayLink(fullUrl) {
  try {
    const u = new URL(fullUrl);
    const host = u.host;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "go" && parts[1]) {
      const id = parts[1];
      const shortId = id.length > 14 ? `${id.slice(0, 12)}…` : id;
      return `${host}/go/${shortId}`;
    }
    const path = u.pathname.length > 20 ? `${u.pathname.slice(0, 18)}…` : u.pathname;
    return `${host}${path}`;
  } catch {
    if (fullUrl.length > 28) return `${fullUrl.slice(0, 26)}…`;
    return fullUrl;
  }
}

/**
 * Compute a *minimum scannable* QR size in CSS pixels:
 * - Determine module count (QR version) for the given text
 * - Ensure module size >= target px/module (bigger on mobile)
 * - Also respect container width, but never shrink below scannable minimum
 */
function computeScannableQrSizePx(text) {
  // Container/viewport constraints
  const cardW = resultCard?.getBoundingClientRect?.().width || 0;
  const usable = cardW ? Math.max(240, Math.floor(cardW - 64)) : Math.max(240, Math.floor(window.innerWidth * 0.78));
  const maxCss = Math.min(420, Math.max(280, usable)); // allow bigger when needed, but keep it reasonable

  // Target module size: mobile needs bigger modules to scan reliably
  const mobile = window.matchMedia && window.matchMedia("(max-width: 520px)").matches;
  const pxPerModule = mobile ? 7 : 6; // key scan reliability knob

  // Estimate module count by building QR matrix
  let moduleCount = 0;
  try {
    if (QRCode?.create) {
      const q = QRCode.create(text, { errorCorrectionLevel: QR_ECL });
      moduleCount = q?.modules?.size || 0;
    }
  } catch {}

  // Fallback if create() not present
  if (!moduleCount || !Number.isFinite(moduleCount)) moduleCount = 33; // ~Version 4-ish

  // Total modules including quiet zone on both sides
  const totalModules = moduleCount + (QR_MARGIN * 2);

  // Required minimum CSS size for scannability
  const minCss = Math.ceil(totalModules * pxPerModule);

  // Final: not smaller than min scannable, not larger than maxCss
  // If minCss exceeds maxCss, we still allow it (because otherwise it won't scan),
  // but we cap it to 520 to prevent absurdly huge UI.
  const css = Math.min(520, Math.max(minCss, Math.min(maxCss, 320)));

  // Make divisible by 4 for nicer output
  return Math.floor(css / 4) * 4;
}

async function renderQr(redirectUrl) {
  const cssSize = computeScannableQrSizePx(redirectUrl);

  try {
    // Avoid browser downscaling blur: keep canvas internal size equal to displayed size
    qrcodeCanvas.style.width = `${cssSize}px`;
    qrcodeCanvas.style.height = `${cssSize}px`;
    qrcodeCanvas.width = cssSize;
    qrcodeCanvas.height = cssSize;

    await new Promise((resolve, reject) => {
      QRCode.toCanvas(
        qrcodeCanvas,
        redirectUrl,
        {
          width: cssSize,
          margin: QR_MARGIN,
          errorCorrectionLevel: QR_ECL,
          color: { dark: "#000000", light: "#FFFFFF" }
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  } catch (e) {
    console.warn("[ui] QRCode draw failed:", e);
  }
}

function clampInt(v, min, max) {
  const n = parseInt(String(v ?? "").trim(), 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function minutesToParts(total) {
  total = Math.max(0, total | 0);
  const days = Math.floor(total / 1440);
  total -= days * 1440;
  const hours = Math.floor(total / 60);
  const minutes = total - hours * 60;
  return { days, hours, minutes };
}

function partsToMinutes(days, hours, minutes) {
  return (days * 1440) + (hours * 60) + minutes;
}

function formatDurationText(totalMinutes) {
  totalMinutes = Math.max(0, totalMinutes | 0);
  const { days, hours, minutes } = minutesToParts(totalMinutes);

  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes || parts.length === 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);

  return parts.join(" ");
}

function setCustomFromMinutes(mins) {
  if (!customDays || !customHours || !customMinutes) return;
  const p = minutesToParts(mins);

  customDays.value = String(clampInt(p.days, 0, 30));
  customHours.value = String(clampInt(p.hours, 0, 23));
  customMinutes.value = String(clampInt(p.minutes, 0, 59));
}

function getCustomMinutes() {
  const d = clampInt(customDays?.value, 0, 30);
  const h = clampInt(customHours?.value, 0, 23);
  const m = clampInt(customMinutes?.value, 0, 59);
  return partsToMinutes(d, h, m);
}

function updateCustomHint() {
  if (!customDurationHint) return;
  const mins = getCustomMinutes();
  customDurationHint.textContent = `Expires in ${formatDurationText(mins)}.`;
}

function toggleCustomUI() {
  if (!expirySelect || !customExpiryWrap) return;

  const isCustom = String(expirySelect.value) === "custom";
  customExpiryWrap.classList.toggle("hidden", !isCustom);

  if (isCustom) {
    // If user never touched custom, prefill from last preset
    if (!customTouched) {
      setCustomFromMinutes(lastPresetMinutes || 10);
    }
    updateCustomHint();
  }
}

function getSelectedMinutesOrThrow() {
  const mode = String(expirySelect?.value || "10");

  if (mode !== "custom") {
    const minutes = parseInt(mode, 10);
    if (!Number.isFinite(minutes) || minutes < 1) {
      throw new Error("Please choose a valid expiration time.");
    }
    return minutes;
  }

  // custom duration
  const minutes = getCustomMinutes();
  if (!Number.isFinite(minutes) || minutes < 1) {
    throw new Error("Custom duration must be at least 1 minute.");
  }
  return minutes;
}

function bindUI() {
  if (!generateBtn || !urlInput || !expirySelect || !resultCard || !qrcodeCanvas) {
    console.error("[ui] Missing required DOM elements. Check index.html IDs.");
    return;
  }

  // Initialize custom duration from default preset (10 minutes)
  lastPresetMinutes = parseInt(String(expirySelect.value || "10"), 10);
  if (!Number.isFinite(lastPresetMinutes) || lastPresetMinutes < 1) lastPresetMinutes = 10;
  setCustomFromMinutes(lastPresetMinutes);
  updateCustomHint();
  toggleCustomUI();

  // Preset/custom UI behavior
  expirySelect.addEventListener("change", () => {
    const v = String(expirySelect.value);

    if (v !== "custom") {
      const mins = parseInt(v, 10);
      if (Number.isFinite(mins) && mins >= 1) {
        lastPresetMinutes = mins;
        // Keep custom prefilled from latest preset (nice UX)
        if (!customTouched) setCustomFromMinutes(lastPresetMinutes);
        updateCustomHint();
      }
    }

    toggleCustomUI();
  });

  // Mark custom as touched + update hint live
  const onCustomChange = () => {
    customTouched = true;
    // Clamp inputs immediately for clean UX
    if (customDays) customDays.value = String(clampInt(customDays.value, 0, 30));
    if (customHours) customHours.value = String(clampInt(customHours.value, 0, 23));
    if (customMinutes) customMinutes.value = String(clampInt(customMinutes.value, 0, 59));
    updateCustomHint();
  };

  customDays?.addEventListener("input", onCustomChange);
  customHours?.addEventListener("input", onCustomChange);
  customMinutes?.addEventListener("input", onCustomChange);

  generateBtn.addEventListener("click", async () => {
    const url = String(urlInput.value || "").trim();

    if (!/^https?:\/\//i.test(url)) {
      alert("Please enter a valid URL (include https://).");
      return;
    }

    let minutes;
    try {
      minutes = getSelectedMinutesOrThrow();
    } catch (e) {
      alert(e?.message || "Invalid expiration time.");
      return;
    }

    clearTimeout(expiryTimer);
    clearInterval(countdownTimer);
    setLoading(true);

    const safety = setTimeout(() => setLoading(false), 9000);

    try {
      const created = await createLink(url, minutes);

      const redirectUrl = `${window.location.origin}/go/${created.id}`;
      lastRedirectUrl = redirectUrl;

      linkExpired = false;
      setDownloadButtonsEnabled(true);

      generatedLink.textContent = makeDisplayLink(redirectUrl);
      generatedLink.href = redirectUrl;
      generatedLink.title = redirectUrl;

      resultCard.classList.remove("hidden");
      await renderQr(redirectUrl);

      const endLocal = new Date(created.expires_at);
      expiryHint.textContent = `Expires in ${created.minutes} min • Until ${endLocal.toLocaleString()}`;

      expiryTimer = setTimeout(() => {
        try {
          const ctx = qrcodeCanvas.getContext("2d");
          ctx.clearRect(0, 0, qrcodeCanvas.width, qrcodeCanvas.height);
        } catch {}

        generatedLink.textContent = "";
        generatedLink.href = "#";
        generatedLink.title = "";
        expiryHint.textContent = "This link has expired.";
        countdownEl.textContent = "Expired";

        linkExpired = true;
        setDownloadButtonsEnabled(false);
      }, created.minutes * 60_000);

      startCountdown(created.expires_at);
    } catch (err) {
      console.error("[ui] Create error:", err);
      alert(err?.message || "Could not create link.");
    } finally {
      clearTimeout(safety);
      setLoading(false);
    }
  });

  window.addEventListener("resize", () => {
    if (!lastRedirectUrl || linkExpired) return;
    window.requestAnimationFrame(() => renderQr(lastRedirectUrl));
  });

  copyBtn?.addEventListener("click", async () => {
    if (linkExpired) return;
    if (!lastRedirectUrl) return;

    try {
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
    } catch {
      alert("Could not copy link.");
    }
  });

  downloadBtn?.addEventListener("click", () => {
    if (linkExpired) return;

    try {
      const url = qrcodeCanvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = "qr-link.png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      alert("Could not download QR.");
    }
  });

  downloadSvgBtn?.addEventListener("click", async () => {
    if (linkExpired) return;
    if (!lastRedirectUrl) return;

    try {
      if (!QRCode?.toString) throw new Error("SVG generator not available");

      const svgText = await QRCode.toString(lastRedirectUrl, {
        type: "svg",
        width: 320,
        margin: QR_MARGIN,
        errorCorrectionLevel: QR_ECL,
        color: { dark: "#000000", light: "#FFFFFF" }
      });

      const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = "qr-link.svg";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.error("[ui] SVG download failed:", e);
      alert("Could not download SVG.");
    }
  });
}

(function start() {
  console.info("[ui] init @", location.origin);
  bindUI();
})();
