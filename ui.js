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
const shareBtn         = document.getElementById("shareBtn");          // Web Share API
const downloadSvgBtn   = document.getElementById("downloadSvgBtn");    // SVG (currently hidden in HTML)
// --- NEW: mode + file/text inputs ---
const modeButtons = Array.from(document.querySelectorAll(".mode-btn"));
const modePanels  = Array.from(document.querySelectorAll(".mode-panel"));

const fileInput = document.getElementById("fileInput");
const uploadProgress = document.getElementById("uploadProgress");
const uploadProgressText = document.getElementById("uploadProgressText");

const textInput = document.getElementById("textInput");

let currentMode = "url"; // "url" | "file" | "text"
let expiryTimer = null;
let countdownTimer = null;
let lastRedirectUrl = "";
let linkExpired = false;

// Track last preset minutes so switching to Custom can prefill nicely
let lastPresetMinutes = 10;
let customTouched = false;

// Custom duration hard max (10 years in days)
const CUSTOM_DAYS_MAX = 3650;

// QR rendering params (tuned for scan reliability)
const QR_ECL = "L";   // lower density than M/Q for long strings
const QR_MARGIN = 4;  // quiet zone (modules)

/**
 * Persist last generated result so if user opens native share app and comes back,
 * we restore the QR/link instead of "session wiped".
 *
 * NOTE: This is NOT history; it's only "last result" and auto-clears after expiry.
 */
const LAST_STATE_KEY = "tempqr_last_state_v1";

function safeJSONParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function saveLastState(state) {
  try {
    if (!state || !state.redirectUrl || !state.expiresAt) return;
    const payload = {
      redirectUrl: String(state.redirectUrl),
      expiresAt: String(state.expiresAt),
      minutes: Number(state.minutes || 0),
      savedAt: Date.now()
    };
    localStorage.setItem(LAST_STATE_KEY, JSON.stringify(payload));
  } catch {}
}

function clearLastState() {
  try { localStorage.removeItem(LAST_STATE_KEY); } catch {}
}

function loadLastState() {
  try {
    const raw = localStorage.getItem(LAST_STATE_KEY);
    if (!raw) return null;

    const data = safeJSONParse(raw);
    if (!data || !data.redirectUrl || !data.expiresAt) return null;

    const end = new Date(data.expiresAt).getTime();
    if (!Number.isFinite(end)) return null;

    // If already expired, clear it.
    if (Date.now() >= end) {
      clearLastState();
      return null;
    }

    // Safety: don't keep it forever in case expiresAt is wrong
    const savedAt = Number(data.savedAt || 0);
    if (savedAt && (Date.now() - savedAt) > 7 * 24 * 60 * 60 * 1000) {
      clearLastState();
      return null;
    }

    return {
      redirectUrl: String(data.redirectUrl),
      expiresAt: String(data.expiresAt),
      minutes: Number(data.minutes || 0)
    };
  } catch {
    return null;
  }
}

function normalizeHttpUrl(input) {
  let s = String(input || "").trim();
  if (!s) return "";

  // If user pasted spaces/newlines, kill it early
  if (/\s/.test(s)) return "";

  // Allow protocol-relative //example.com
  if (s.startsWith("//")) s = "https:" + s;

  // Add https:// if missing scheme
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) {
    s = "https://" + s;
  }

  // Validate + enforce http/https only
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (!u.hostname) return "";
    return u.toString();
  } catch {
    return "";
  }
}

function setLoading(state) {
  if (!generateBtn) return;
  generateBtn.disabled = state;
  generateBtn.textContent = state ? "Creating..." : "Create Private Link";
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
    if (shareBtn) shareBtn.disabled = !enabled;
  } catch {}
}

function expireUINow() {
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

  // Once expired, clear persisted state so it won't restore a dead link.
  clearLastState();
}

function startCountdown(iso) {
  const end = new Date(iso).getTime();
  clearInterval(countdownTimer);

  countdownTimer = setInterval(() => {
    const left = end - Date.now();
    if (left <= 0) {
      clearInterval(countdownTimer);
      expireUINow();
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
    if (!res.ok) {
      let msg = "";
      try { msg = (await res.text()) || ""; } catch {}
      throw new Error(msg || `HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function setMode(mode) {
  currentMode = mode;

  // buttons
  modeButtons.forEach(btn => {
    const m = btn.getAttribute("data-mode");
    const active = (m === mode);
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });

  // panels
  modePanels.forEach(p => {
    const key = p.getAttribute("data-panel");
    p.classList.toggle("hidden", key !== mode);
  });
}

function showUploadProgress(show, pct = 0, text = "Uploading…") {
  if (!uploadProgress || !uploadProgressText) return;
  uploadProgress.classList.toggle("hidden", !show);
  uploadProgressText.classList.toggle("hidden", !show);
  if (show) {
    uploadProgress.value = pct;
    uploadProgressText.textContent = text;
  }
}

async function getR2UploadUrl({ filename, contentType, size, folder }) {
  return fetchJSON("/api/r2-upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, contentType, size, folder })
  }, 15000);
}

// PUT with progress (so user sees it moving)
function putWithProgress(url, file, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);

    xhr.upload.onprogress = (evt) => {
      if (!evt.lengthComputable) return;
      const pct = Math.round((evt.loaded / evt.total) * 100);
      onProgress?.(pct, evt.loaded, evt.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed (network)"));
    xhr.send(file);
  });
}

async function createFileLink({ key, filename, contentType, minutes, token }) {
  const url = `file:${key}|${encodeURIComponent(filename || "file.bin")}|${encodeURIComponent(contentType || "")}`;

  return fetchJSON("/api/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "file",
      url,
      minutes,
      token: token || null
    })
  }, 15000);
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

  customDays.value = String(clampInt(p.days, 0, CUSTOM_DAYS_MAX));
  customHours.value = String(clampInt(p.hours, 0, 23));
  customMinutes.value = String(clampInt(p.minutes, 0, 59));
}

function getCustomMinutes() {
  const d = clampInt(customDays?.value, 0, CUSTOM_DAYS_MAX);
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

function flashButtonText(btn, tempText, ms, fallbackText) {
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = tempText;
  setTimeout(() => {
    // If user changed it in the meantime, don't fight it
    btn.textContent = fallbackText || original;
  }, ms);
}

async function restoreLastResultIfAny() {
  const st = loadLastState();
  if (!st) return;

  // Avoid restoring if DOM missing
  if (!resultCard || !generatedLink || !qrcodeCanvas) return;

  const endMs = new Date(st.expiresAt).getTime();
  const remainingMs = endMs - Date.now();
  if (remainingMs <= 0) {
    clearLastState();
    return;
  }

  lastRedirectUrl = st.redirectUrl;
  linkExpired = false;
  setDownloadButtonsEnabled(true);

  generatedLink.textContent = makeDisplayLink(st.redirectUrl);
  generatedLink.href = st.redirectUrl;
  generatedLink.title = st.redirectUrl;

  resultCard.classList.remove("hidden");
  await renderQr(st.redirectUrl);

  const endLocal = new Date(st.expiresAt);
  if (st.minutes && Number.isFinite(st.minutes)) {
    expiryHint.textContent = `Expires in ${st.minutes} min • Until ${endLocal.toLocaleString()}`;
  } else {
    expiryHint.textContent = `Until ${endLocal.toLocaleString()}`;
  }

  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => {
    expireUINow();
  }, remainingMs);

  startCountdown(st.expiresAt);
}

function bindUI() {
  if (!generateBtn || !urlInput || !expirySelect || !resultCard || !qrcodeCanvas) {
    console.error("[ui] Missing required DOM elements. Check index.html IDs.");
    return;
  }

  // NEW: mode switch (runs only if DOM is OK)
  modeButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const m = btn.getAttribute("data-mode") || "url";
      setMode(m);
    });
  });

  // default mode
  setMode("url");

  // (Optional UX) Normalize on blur so user sees https:// added (but don't force while typing)
  urlInput.addEventListener("blur", () => {
    const norm = normalizeHttpUrl(urlInput.value);
    if (norm) urlInput.value = norm;
  });

  // Show Share only if Web Share API exists
  if (shareBtn) {
    const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
    shareBtn.style.display = canShare ? "" : "none";
    shareBtn.disabled = true;
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
    if (customDays) customDays.value = String(clampInt(customDays.value, 0, CUSTOM_DAYS_MAX));
    if (customHours) customHours.value = String(clampInt(customHours.value, 0, 23));
    if (customMinutes) customMinutes.value = String(clampInt(customMinutes.value, 0, 59));
    updateCustomHint();
  };

  customDays?.addEventListener("input", onCustomChange);
  customHours?.addEventListener("input", onCustomChange);
  customMinutes?.addEventListener("input", onCustomChange);

  generateBtn.addEventListener("click", async () => {
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
    // =========================
    // MODE: URL (FREE)
    // =========================
    if (currentMode === "url") {
      const raw = String(urlInput.value || "").trim();
      const url = normalizeHttpUrl(raw);

      if (!url) {
        alert("Please enter a valid URL (e.g. google.com or https://example.com).");
        return;
      }

      urlInput.value = url;

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

      saveLastState({ redirectUrl, expiresAt: created.expires_at, minutes: created.minutes });

      const endMs = new Date(created.expires_at).getTime();
      const remainingMs = endMs - Date.now();

      expiryTimer = setTimeout(() => expireUINow(), Math.max(0, remainingMs));
      startCountdown(created.expires_at);
      return;
    }

    // =========================
    // MODE: FILE upload (DEV bypass optional)
    // =========================
    if (currentMode === "file") {
      const f = fileInput?.files?.[0];
      if (!f) {
        alert("Please choose a file.");
        return;
      }

      // UI-enforce 500MB
      const MAX = 500 * 1024 * 1024;
      if (f.size > MAX) {
        alert("File too large. Max 500MB.");
        return;
      }

      const devBypass = document.documentElement.getAttribute("data-upload-bypass") === "1";
      if (!devBypass) {
        alert("Upload is not enabled yet.");
        return;
      }

      

      // 1) presigned upload URL
      showUploadProgress(true, 0, "Preparing upload…");
      const up = await getR2UploadUrl({
        filename: f.name,
        contentType: f.type || "application/octet-stream",
        size: f.size,
        folder: "files"
      });

      // 2) upload direct to R2
      showUploadProgress(true, 0, "Uploading…");
      await putWithProgress(up.uploadUrl, f, f.type || "application/octet-stream", (pct) => {
        showUploadProgress(true, pct, `Uploading… ${pct}%`);
      });

      // 3) create TempQR link using file reference
      showUploadProgress(true, 100, "Creating link…");
      const created = await createFileLink({
        key: up.key,
        filename: f.name,
        contentType: f.type || "application/octet-stream",
        minutes,
        token: null
      });

      showUploadProgress(false);

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

      saveLastState({ redirectUrl, expiresAt: created.expires_at, minutes: created.minutes });

      const endMs = new Date(created.expires_at).getTime();
      const remainingMs = endMs - Date.now();

      expiryTimer = setTimeout(() => expireUINow(), Math.max(0, remainingMs));
      startCountdown(created.expires_at);

      return;
    }

    // =========================
    // MODE: TEXT (next step)
    // =========================
    alert("Text mode is next. First we finish file upload.");
  } catch (err) {
    console.error("[ui] Create error:", err);
    showUploadProgress(false);
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

  // When user returns from native share app, some browsers will restore tab; some will reload.
  // On focus/visibility, try restoring last result if current state is empty.
  window.addEventListener("focus", () => {
    if (!lastRedirectUrl && !linkExpired) {
      restoreLastResultIfAny();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !lastRedirectUrl && !linkExpired) {
      restoreLastResultIfAny();
    }
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

  shareBtn?.addEventListener("click", async () => {
    if (linkExpired) return;
    if (!lastRedirectUrl) return;
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") return;

    // Ensure we persist before leaving to any external app
    // (in case tab gets killed and user reopens).
    // We don't know expiresAt here unless we saved it earlier, but saveLastState already ran on create.
    // This is just a safe no-op.
    try {
      // refresh savedAt to keep it "recent" while still expiring naturally
      const st = loadLastState();
      if (st && st.redirectUrl === lastRedirectUrl && st.expiresAt) {
        saveLastState({ redirectUrl: st.redirectUrl, expiresAt: st.expiresAt, minutes: st.minutes });
      }
    } catch {}

    try {
      await navigator.share({
        title: "TempQR",
        text: "Expiring link:",
        url: lastRedirectUrl
      });

      // If share succeeds and we remain/return to the page:
      flashButtonText(shareBtn, "Sent!", 1400, "Share");
    } catch (e) {
      // User cancel (AbortError) or other share issues — keep silent to avoid confusion.
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

(async function start() {
  console.info("[ui] init @", location.origin);
  bindUI();

  // Restore last generated result (if any) so share doesn't "wipe the session" on mobile.
  await restoreLastResultIfAny();
})();
