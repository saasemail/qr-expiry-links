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

// Pro modal
const proModal = document.getElementById("proModal");
const getProBtn = document.getElementById("getProBtn");
const closeProModal = document.getElementById("closeProModal");

// Success modal
const successModal = document.getElementById("successModal");
const closeSuccessModal = document.getElementById("closeSuccessModal");
const successCode = document.getElementById("successCode");
const copyCodeBtn = document.getElementById("copyCodeBtn");
const applyCodeBtn = document.getElementById("applyCodeBtn");
const resendLink = document.getElementById("resendLink");

let expiryTimer;
let countdownTimer;
let lastRedirectUrl = "";

// Helpers
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
      const ctx = qrcodeCanvas.getContext("2d");
      ctx.clearRect(0, 0, qrcodeCanvas.width, qrcodeCanvas.height);
      generatedLink.textContent = "";
      expiryHint.textContent = "This link has expired.";
      return;
    }
    countdownEl.textContent = formatCountdown(left);
  }, 1000);
}

// ------ Generate flow ------
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

    expiryTimer = setTimeout(() => {
      const ctx = qrcodeCanvas.getContext("2d");
      ctx.clearRect(0, 0, qrcodeCanvas.width, qrcodeCanvas.height);
      generatedLink.textContent = "";
      expiryHint.textContent = "This link has expired.";
      countdownEl.textContent = "Expired";
    }, created.minutes * 60_000);

    startCountdown(created.expires_at);
  } catch (err) {
    console.error("Create error:", err);
    alert(err.message);
  } finally {
    setLoading(false);
  }
});

// Copy & download
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
  } catch {
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
  } catch {
    alert("Could not download QR.");
  }
});

// ------ Pro modal ------
function openModal(modal) {
  if (!modal) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  const first = modal.querySelector(".plan-select, .modal-close, button, a, input");
  (first || modal.querySelector(".modal-card"))?.focus();
  document.addEventListener("keydown", onEsc);
  document.addEventListener("keydown", trapTab);
}

function closeModal(modal) {
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.removeEventListener("keydown", onEsc);
  document.removeEventListener("keydown", trapTab);
}

function onEsc(e) {
  if (e.key === "Escape") {
    closeModal(proModal);
    closeModal(successModal);
  }
}

function trapTab(e) {
  const open = document.querySelector(".modal.open");
  if (!open || e.key !== "Tab") return;
  const focusables = open.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    last.focus();
    e.preventDefault();
  } else if (!e.shiftKey && document.activeElement === last) {
    first.focus();
    e.preventDefault();
  }
}

getProBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  openModal(proModal);
});

closeProModal?.addEventListener("click", () => closeModal(proModal));
proModal?.addEventListener("click", (e) => {
  if (e.target && e.target.matches(".modal-overlay,[data-close='modal']")) closeModal(proModal);
});

// When user clicks a plan -> start checkout session (simulate partner)
document.querySelectorAll(".plan-select").forEach((btn) => {
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    const tier = Number(btn.dataset.tier || 0);
    try {
      const r = await fetch(`/api/checkout-session?tier=${tier}`);
      if (r.ok) {
        const js = await r.json(); // { session_id }
        const sid = js?.session_id;
        // Redirect with session_id in query; partner would do this after payment.
        const base = location.origin + location.pathname;
        location.href = `${base}?session_id=${encodeURIComponent(sid)}`;
      } else {
        // Fallback – open email (same kao ranije)
        const mail = "support@qr.expire.links.com";
        const subjects = {1:"QR Expiry Links - Tier 1",2:"QR Expiry Links - Tier 2",3:"QR Expiry Links - Tier 3 (Lifetime)"};
        const bodies   = {
          1:"I want Tier 1 (24h per link, 5/day). Please send payment instructions and my Pro code.",
          2:"I want Tier 2 (7 days per link, unlimited). Please send payment instructions and my Pro code.",
          3:"I want Tier 3 (30 days per link, unlimited, lifetime). Please send payment instructions and my Pro code."
        };
        const s = encodeURIComponent(subjects[tier] || "QR Expiry Links - Pro");
        const b = encodeURIComponent(bodies[tier] || "Please send payment instructions and my Pro code.");
        location.href = `mailto:${mail}?subject=${s}&body=${b}`;
      }
    } catch {
      // same fallback
      const mail = "support@qr.expire.links.com";
      location.href = `mailto:${mail}?subject=QR%20Expiry%20Links%20-%20Pro&body=Please%20send%20payment%20instructions%20and%20my%20Pro%20code.`;
    } finally {
      closeModal(proModal);
      tokenInput?.focus();
    }
  });
});

// ------ Success modal workflow ------

// open & close
function openSuccess(token) {
  if (!token) return;
  successCode.value = token;
  try { localStorage.setItem("pro_code", token); } catch {}
  openModal(successModal);
}

closeSuccessModal?.addEventListener("click", () => closeModal(successModal));
successModal?.addEventListener("click", (e) => {
  if (e.target && e.target.matches(".modal-overlay,[data-close='modal']")) closeModal(successModal);
});

copyCodeBtn?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(successCode.value || "");
    copyCodeBtn.textContent = "Copied!";
    setTimeout(() => (copyCodeBtn.textContent = "Copy"), 1200);
  } catch {
    alert("Could not copy.");
  }
});

applyCodeBtn?.addEventListener("click", () => {
  tokenInput.value = successCode.value || "";
  closeModal(successModal);
  generateBtn?.focus();
});

// Prefill from localStorage on load
try {
  const saved = localStorage.getItem("pro_code");
  if (saved && !tokenInput.value) tokenInput.value = saved;
} catch {}

// Polling for session_id in URL
function getQueryParam(name) {
  return new URLSearchParams(location.search).get(name);
}

async function pollStatus(sessionId, { tries = 30, interval = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`/api/checkout-status?session_id=${encodeURIComponent(sessionId)}`);
      if (r.ok) {
        const js = await r.json(); // { ok, token? }
        if (js?.ok && js?.token) return js.token;
      }
    } catch { /* ignore */ }
    await new Promise((res) => setTimeout(res, interval));
  }
  return null;
}

// On load: if ?session_id=... then poll backend, show modal with token
(async () => {
  const sid = getQueryParam("session_id");
  if (sid) {
    const token = await pollStatus(sid);
    if (token) {
      openSuccess(token);
      // optionally clean the URL
      const base = location.origin + location.pathname;
      history.replaceState({}, "", base);
    }
  }
})();

// “Resend my code” placeholder (može da gaš do admin API-ja kasnije)
resendLink?.addEventListener("click", (e) => {
  e.preventDefault();
  alert("Please contact support to resend your code. (Admin endpoint coming next.)");
});
