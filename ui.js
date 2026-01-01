// ui.js — FREE version (no Pro / no auth). Compact & readable QR + short display link.

const urlInput       = document.getElementById("urlInput");
const expiryInput    = document.getElementById("expiryInput");
const generateBtn    = document.getElementById("generateBtn");

const resultCard     = document.getElementById("resultCard");
const qrcodeCanvas   = document.getElementById("qrcode");
const generatedLink  = document.getElementById("generatedLink");
const expiryHint     = document.getElementById("expiryHint");
const countdownEl    = document.getElementById("countdown");

const copyBtn        = document.getElementById("copyBtn");
const downloadBtn    = document.getElementById("downloadBtn");       // PNG
const downloadSvgBtn = document.getElementById("downloadSvgBtn");    // SVG (currently hidden in HTML)

let expiryTimer = null;
let countdownTimer = null;
let lastRedirectUrl = "";
let linkExpired = false;

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

/** Compute a compact QR size (in px) based on container width & device.
 *  Goal: readable but compact on all devices.
 */
function computeQrSizePx() {
  // Default safe width if element sizes not ready yet
  const fallback = Math.min(300, Math.max(220, Math.floor(window.innerWidth * 0.62)));

  // Prefer card width so it matches layout
  const card = resultCard;
  const w = card?.getBoundingClientRect?.().width || 0;

  // Leave padding and keep it compact
  const usable = w ? Math.max(200, w - 64) : fallback;

  // Clamp: phones ~220-260, laptops ~240-280, never huge
  const clamped = Math.max(210, Math.min(280, Math.floor(usable)));

  // Force to multiple of 4 for nicer rendering
  return Math.floor(clamped / 4) * 4;
}

/** Short display text: show domain + /go/ + short id preview */
function makeDisplayLink(fullUrl) {
  try {
    const u = new URL(fullUrl);
    const host = u.host;
    const parts = u.pathname.split("/").filter(Boolean);
    // if /go/<id>, show a short prefix of <id>
    if (parts[0] === "go" && parts[1]) {
      const id = parts[1];
      const shortId = id.length > 14 ? `${id.slice(0, 12)}…` : id;
      return `${host}/go/${shortId}`;
    }
    // otherwise just host + path (trimmed)
    const path = u.pathname.length > 20 ? `${u.pathname.slice(0, 18)}…` : u.pathname;
    return `${host}${path}`;
  } catch {
    // fallback
    if (fullUrl.length > 28) return `${fullUrl.slice(0, 26)}…`;
    return fullUrl;
  }
}

async function renderQr(redirectUrl) {
  const size = computeQrSizePx();

  try {
    // Ensure canvas has correct internal resolution (avoid blurry scaling)
    qrcodeCanvas.width = size;
    qrcodeCanvas.height = size;

    await new Promise((resolve, reject) => {
      QRCode.toCanvas(
        qrcodeCanvas,
        redirectUrl,
        { width: size, margin: 1 },
        (err) => (err ? reject(err) : resolve())
      );
    });
  } catch (e) {
    console.warn("[ui] QRCode draw failed:", e);
  }
}

function bindUI() {
  // Guard: if basic DOM is missing, fail loudly (prevents silent “button does nothing” cases)
  if (!generateBtn || !urlInput || !expiryInput || !resultCard || !qrcodeCanvas) {
    console.error("[ui] Missing required DOM elements. Check index.html IDs.");
    return;
  }

  generateBtn.addEventListener("click", async () => {
    const url = String(urlInput.value || "").trim();
    const minutes = parseInt(expiryInput.value, 10);

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

    const safety = setTimeout(() => setLoading(false), 9000);

    try {
      const created = await createLink(url, minutes);

      // Redirect URL: /go/:id (rewrite exists in vercel.json)
      const redirectUrl = `${window.location.origin}/go/${created.id}`;
      lastRedirectUrl = redirectUrl;

      linkExpired = false;
      setDownloadButtonsEnabled(true);

      // Display a short version but keep href full
      generatedLink.textContent = makeDisplayLink(redirectUrl);
      generatedLink.href = redirectUrl;
      generatedLink.title = redirectUrl;

      // Render QR compact & crisp
      resultCard.classList.remove("hidden");
      await renderQr(redirectUrl);

      const endLocal = new Date(created.expires_at);
      expiryHint.textContent = `Expires in ${created.minutes} min • Until ${endLocal.toLocaleString()}`;

      // Auto-clear on expiry
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

  // Re-render QR on resize so it stays ideal (only if we already have a link)
  window.addEventListener("resize", () => {
    if (!lastRedirectUrl || linkExpired) return;
    // throttle via rAF
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

  // SVG download (button is hidden in HTML right now, but handler is safe)
  downloadSvgBtn?.addEventListener("click", async () => {
    if (linkExpired) return;
    if (!lastRedirectUrl) return;

    try {
      if (!QRCode?.toString) throw new Error("SVG generator not available");

      const svgText = await QRCode.toString(lastRedirectUrl, {
        type: "svg",
        // match compact sizing concept (SVG itself scales nicely)
        width: 220,
        margin: 1
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

// --- Start ---
(function start() {
  console.info("[ui] init @", location.origin);
  bindUI();
})();
