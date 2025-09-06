// ui.js — QR Expiry Links (Free vs Pro via /api/create + Pro modal checkout polling)

// --- DOM refs ---
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
let statusPollTimer = null;

// --- Helpers ---
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
      const maybe = JSON.parse(text);
      throw new Error(maybe?.message || text || "Create failed");
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
  return d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
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

// ------ Generate flow (free & pro token) ------
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
  const f = open.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
  else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
}

getProBtn?.addEventListener("click", (e) => { e.preventDefault(); openModal(proModal); });
closeProModal?.addEventListener("click", () => closeModal(proModal));
proModal?.addEventListener("click", (e) => {
  if (e.target && e.target.matches(".modal-overlay,[data-close='modal']")) closeModal(proModal);
});

// Kada user izabere plan -> kreiraj checkout session i počni polling
document.querySelectorAll(".plan-select").forEach((btn) => {
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    const tier = Number(btn.dataset.tier || 0);
    if (!tier) return;
    try {
      const r = await fetch("/api/checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      if (!r.ok) throw new Error(await r.text());
      const { session_id } = await r.json();
      startStatusPolling(session_id);
    } catch (err) {
      alert("Could not start checkout session.");
      console.error(err);
    } finally {
      closeModal(proModal);
      tokenInput?.focus();
    }
  });
});

function startStatusPolling(sessionId) {
  stopStatusPolling();
  statusPollTimer = setInterval(async () => {
    try {
      const r = await fetch(`/api/checkout-status?session_id=${encodeURIComponent(sessionId)}`);
      if (!r.ok) return;
      const data = await r.json(); // { ready, token }
      if (data?.ready && data?.token) {
        stopStatusPolling();
        showSuccessModal(data.token, sessionId);
      }
    } catch { /* ignore */ }
  }, 2000);
}
function stopStatusPolling() {
  if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
}

// ------ Success modal ------
function openSuccess(modal) {
  if (!modal) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  const first = modal.querySelector(".modal-close, button, a, input");
  (first || modal.querySelector(".modal-card"))?.focus();
  document.addEventListener("keydown", onEsc);
  document.addEventListener("keydown", trapTab);
}
function closeSuccess() { closeModal(successModal); }

function showSuccessModal(token, sessionId) {
  successCode.value = token || "";
  try { localStorage.setItem("pro_code", token || ""); } catch {}
  if (resendLink) {
    const subject = encodeURIComponent("QR Expiry Links - Resend my code");
    const body = encodeURIComponent(`Hello,\nI completed the payment. My sessionId is: ${sessionId}\nPlease resend my Pro code.`);
    resendLink.href = `mailto:support@example.com?subject=${subject}&body=${body}`;
  }
  openSuccess(successModal);
}

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
  closeSuccess();
  generateBtn?.focus();
});
closeSuccessModal?.addEventListener("click", closeSuccess);
successModal?.addEventListener("click", (e) => {
  if (e.target && e.target.matches(".modal-overlay,[data-close='success']")) closeSuccess();
});

// Prefill Pro koda sa localStorage
try {
  const saved = localStorage.getItem("pro_code");
  if (saved && !tokenInput.value) tokenInput.value = saved;
} catch {}
