
"use strict";

// StudyOS — application logic
// This version runs locally in the browser.
// Cloud authentication and database sync come later.

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

const AUTH_TOKEN_KEY = "studyos-auth-token";
const DEVICE_ID_KEY = "studyos-device-id";
let currentAuthAccount = null;

function getStudyOSDeviceId() {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId && window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    deviceId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

function collectStudyOSAccountData() {
  const keys = [
    "studyos-tasks",
    "studyos-focus-sessions",
    "studyos-test-attempts",
    "studyos-ai-test-history",
    "studyos-progress-v1",
    "studyos-ai-conversations",
    "studyos-saved-doubts",
    "studyos-library-progress",
    "studyos-active-theme",
    "studyos-saved-themes",
    "studyos-theme",
    "studyos-appearance",
    "studyos-glass-intensity",
    "studyos-corner-style",
    "studyos-motion",
    "studyos-learning-studio-v1"
  ];
  const data = {};
  keys.forEach((key) => {
    try {
      const value = localStorage.getItem(key);
      data[key] = value ? JSON.parse(value) : null;
    } catch {
      data[key] = localStorage.getItem(key);
    }
  });
  return data;
}

async function syncStudyOSAccount() {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!token || !currentAuthAccount) return;
  const snapshot = collectStudyOSAccountData();
  const progress = snapshot["studyos-progress-v1"]?.profile ? snapshot["studyos-progress-v1"] : null;
  try {
    const response = await fetch("/api/account/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        name: currentAuthAccount.name,
        avatar: currentAuthAccount.avatar,
        data: {
          ...snapshot,
          progress: progress || snapshot["studyos-progress-v1"] || null,
          testAttempts: snapshot["studyos-test-attempts"] || [],
          theme: snapshot["studyos-active-theme"] || snapshot["studyos-theme"] || null
        }
      })
    });
    if (!response.ok) throw new Error("Account sync failed.");
  } catch (error) {
    console.warn(error.message);
  }
}

async function restoreStudyOSAccountData(account) {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) return;
  try {
    const response = await fetch("/api/account/me", {
      headers: { "Authorization": `Bearer ${token}` },
      cache: "no-store"
    });
    if (!response.ok) throw new Error("Could not restore account data.");
    const result = await response.json();
    const snapshot = result.snapshot?.data;
    if (snapshot && typeof snapshot === "object") {
      Object.entries(snapshot).forEach(([key, value]) => {
        if (value === null || value === undefined) {
          localStorage.removeItem(key);
        } else if (typeof value === "string") {
          localStorage.setItem(key, value);
        } else {
          localStorage.setItem(key, JSON.stringify(value));
        }
      });
    }
  } catch (error) {
    console.warn(error.message);
  }

  const progressKey = "studyos-progress-v1";
  let progress;
  try {
    progress = JSON.parse(localStorage.getItem(progressKey) || "null");
  } catch {
    progress = null;
  }
  if (!progress || typeof progress !== "object") progress = {};
  if (!progress.profile || typeof progress.profile !== "object") progress.profile = {};
  progress.profile.name = progress.profile.name || account.name || account.username;
  progress.profile.avatar = progress.profile.avatar || account.avatar || "🎓";
  localStorage.setItem(progressKey, JSON.stringify(progress));
  if (typeof renderXPAndAchievements === "function") renderXPAndAchievements();
  if (typeof renderLeaderboard === "function") renderLeaderboard();
}

async function unlockStudyOS(account) {
  currentAuthAccount = account;
  $("#auth-screen")?.classList.add("hidden");
  document.querySelector(".app-shell")?.classList.remove("auth-locked");
  const label = $("#auth-user-label");
  if (label) label.textContent = `${account.name || account.username} · ${account.role === "owner" ? "Owner" : "Student"}`;
  const logout = $("#auth-logout-button");
  if (logout) logout.hidden = false;
  const exportButton = $("#owner-export-button");
  if (exportButton) exportButton.hidden = account.role !== "owner";
  await restoreStudyOSAccountData(account);
  syncStudyOSAccount();
}

async function restoreStudyOSSession() {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) {
    return;
  }
  try {
    const response = await fetch("/api/auth/me", {
      headers: { "Authorization": `Bearer ${token}` },
      cache: "no-store"
    });
    if (!response.ok) throw new Error();
    const data = await response.json();
    unlockStudyOS(data.account);
  } catch {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  }
}

let authMode = "login";

window.addEventListener("storage", () => {
  if (currentAuthAccount) syncStudyOSAccount();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && currentAuthAccount) syncStudyOSAccount();
});
window.addEventListener("pagehide", () => {
  if (currentAuthAccount) syncStudyOSAccount();
});

$$(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    authMode = tab.dataset.authMode;
    $$(".auth-tab").forEach((item) => item.classList.toggle("active", item === tab));
    const registering = authMode === "register";
    $("#auth-name").hidden = !registering;
    $("#auth-name-label").hidden = !registering;
    $("#auth-submit").textContent = registering ? "Create account" : "Log in";
    $("#auth-title").textContent = registering ? "Create your StudyOS account" : "Sign in to StudyOS";
    $("#auth-description").textContent = registering
      ? "Create an account to sync your study data and appear in community rankings."
      : "Your study progress, tests and rankings stay synced to your account.";
    $("#auth-password").autocomplete = registering ? "new-password" : "current-password";
    $("#auth-status").textContent = "";
  });
});

$("#auth-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = $("#auth-status");
  const submit = $("#auth-submit");
  submit.disabled = true;
  status.textContent = authMode === "register" ? "Creating account..." : "Signing in...";
  try {
    const response = await fetch(`/api/auth/${authMode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: $("#auth-name").value.trim(),
        username: $("#auth-username").value.trim(),
        password: $("#auth-password").value,
        deviceId: getStudyOSDeviceId()
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Authentication failed.");
    localStorage.setItem(AUTH_TOKEN_KEY, data.token);
    $("#auth-password").value = "";
    unlockStudyOS(data.account);
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$("#auth-logout-button")?.addEventListener("click", () => {
  const deviceId = getStudyOSDeviceId();
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (deviceId) {
    fetch("/api/auth/forget-device", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ deviceId })
    }).catch(() => {});
  }
  localStorage.removeItem(AUTH_TOKEN_KEY);
  currentAuthAccount = null;
  $("#auth-screen")?.classList.remove("hidden");
  document.querySelector(".app-shell")?.classList.add("auth-locked");
  $("#auth-logout-button").hidden = true;
  $("#owner-export-button").hidden = true;
  $("#auth-status").textContent = "";
  $("#auth-password").value = "";
});

$("#owner-export-button")?.addEventListener("click", () => {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) return;
  const url = "/api/admin/export";
  fetch(url, { headers: { "Authorization": `Bearer ${token}` } })
    .then(async (response) => {
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Could not export account data.");
      }
      return response.blob();
    })
    .then((blob) => {
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = "studyos-account-export.json";
      link.click();
      URL.revokeObjectURL(downloadUrl);
    })
    .catch((error) => window.alert(error.message));
});

restoreStudyOSSession();

// ---------- Navigation ----------

function showScreen(screenId) {
  const target = document.getElementById(screenId);

  if (!target || !target.classList.contains("screen")) return;

  $$(".screen").forEach((screen) => {
    screen.classList.toggle("active", screen.id === screenId);
  });

  $$(".nav-item").forEach((button) => {
    const active = button.dataset.screen === screenId;

    button.classList.toggle("active", active);

    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });

  const secondaryScreens = new Set([
    "ai-doubts", "ai-test", "learning-studio", "testlab",
    "insights", "achievements", "leaderboard", "settings"
  ]);
  const moreButton = $("#more-nav-item");
  const moreIsActive = secondaryScreens.has(screenId);
  if (moreButton) {
    moreButton.classList.toggle("active", moreIsActive);
    if (moreIsActive) {
      moreButton.setAttribute("aria-current", "page");
    } else {
      moreButton.removeAttribute("aria-current");
    }
  }
  $$("#more-menu .more-menu-item").forEach((button) => {
    const active = button.dataset.screen === screenId ||
      (screenId === "learning-studio" && button.dataset.studio === document.querySelector(".studio-tab.active")?.dataset.studio);
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  window.scrollTo({ top: 0, behavior: "smooth" });

  if (screenId === "home" && typeof renderHomeAnalytics === "function") {
    renderHomeAnalytics();
  }

  if (screenId === "insights" && typeof renderAnalytics === "function") {
    renderAnalytics();
  }

  if (screenId === "testlab" && typeof renderTestLabSelection === "function") {
    renderTestLabSelection();
  }

  if (screenId === "library" && typeof renderSavedDoubts === "function") {
    renderSavedDoubts();
  }

  if (screenId === "ai-doubts" && typeof initializeDoubtSolver === "function") {
    initializeDoubtSolver();
  }

  if (screenId === "ai-test" && typeof initializeAITest === "function") {
    initializeAITest();
  }
}

$$(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    if (!button.dataset.screen) return;
    showScreen(button.dataset.screen);
  });
});

$("#quick-focus")?.addEventListener("click", () => {
  showScreen("focus");
});

$("#open-test-lab")?.addEventListener("click", () => {
  showScreen("testlab");
});

const moreButton = $("#more-nav-item");
const moreMenu = $("#more-menu");
const moreBackdrop = $("#more-menu-backdrop");
const moreCloseButton = $("#more-menu-close");
let moreMenuReturnFocus = null;

function openMoreMenu() {
  if (!moreMenu || !moreBackdrop || !moreButton) return;
  moreMenuReturnFocus = document.activeElement;
  moreBackdrop.hidden = false;
  moreMenu.hidden = false;
  document.body.classList.add("more-menu-open");
  moreButton.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => {
    moreMenu.classList.add("open");
    moreCloseButton?.focus();
  });
}

function closeMoreMenu({ restoreFocus = true } = {}) {
  if (!moreMenu || !moreBackdrop || !moreButton) return;
  moreMenu.classList.remove("open");
  moreButton.setAttribute("aria-expanded", "false");
  document.body.classList.remove("more-menu-open");
  window.setTimeout(() => {
    moreMenu.hidden = true;
    moreBackdrop.hidden = true;
    if (restoreFocus) moreMenuReturnFocus?.focus();
  }, 180);
}

moreButton?.addEventListener("click", () => {
  if (moreMenu?.classList.contains("open")) closeMoreMenu();
  else openMoreMenu();
});
moreCloseButton?.addEventListener("click", () => closeMoreMenu());
moreBackdrop?.addEventListener("click", () => closeMoreMenu());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && moreMenu?.classList.contains("open")) closeMoreMenu();
});

$$("#more-menu [data-screen]").forEach((button) => {
  button.addEventListener("click", () => {
    closeMoreMenu({ restoreFocus: false });
    showScreen(button.dataset.screen);
  });
});

$$("#more-menu [data-studio]").forEach((button) => {
  button.addEventListener("click", () => {
    closeMoreMenu({ restoreFocus: false });
    showScreen("learning-studio");
    if (typeof renderStudio === "function") renderStudio(button.dataset.studio);
  });
});

$$('[data-open-screen]').forEach((button) => {
  button.addEventListener("click", () => showScreen(button.dataset.openScreen));
});

const DOUBT_USER_KEY = "studyos-ai-user-id";
const DOUBT_CONVERSATIONS_KEY = "studyos-ai-conversations";
const SAVED_DOUBTS_KEY = "studyos-saved-doubts";

let doubtUserId = "";
let doubtConversationId = "";
let doubtConversations = [];
let doubtAttachment = null;
let doubtRequestInFlight = false;

function createDoubtId(prefix) {
  if (window.crypto?.randomUUID) {
    return `${prefix}_${window.crypto.randomUUID().replace(/-/g, "")}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function readDoubtStorage(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function saveDoubtConversations() {
  try {
    localStorage.setItem(DOUBT_CONVERSATIONS_KEY, JSON.stringify(doubtConversations));
  } catch {
    // Keep the current conversation usable when browser storage is unavailable.
  }
}

function escapeDoubtHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDoubtAnswer(text) {
  return escapeDoubtHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .split(/\n{2,}/)
    .map((paragraph) => /^#{1,3}\s/.test(paragraph)
      ? `<h3>${paragraph.replace(/^#{1,3}\s/, "")}</h3>`
      : `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function renderMathIfAvailable(container) {
  if (typeof window.renderMathInElement === "function") {
    window.renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true }
      ],
      throwOnError: false,
      strict: "ignore",
      trust: false,
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"]
    });
  }
}

function getActiveDoubtConversation() {
  return doubtConversations.find((item) => item.id === doubtConversationId && item.active)
    || doubtConversations.find((item) => item.id === doubtConversationId)
    || null;
}

function renderDoubtConversation() {
  const conversation = $("#doubt-conversation");
  if (!conversation) return;
  conversation.replaceChildren();

  const active = getActiveDoubtConversation();
  const messages = active?.messages || [];
  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "doubt-empty muted";
    empty.textContent = "Ask NOVA an academic question. Get a clear explanation, worked step by step.";
    conversation.append(empty);
    return;
  }

  messages.forEach((message) => {
    const bubble = document.createElement("article");
    bubble.className = `doubt-message ${message.role === "user" ? "user" : "assistant"}`;
    if (message.pending) bubble.classList.add("pending");
    if (message.role === "assistant") {
      const head = document.createElement("div");
      head.className = "doubt-message-head";
      head.textContent = "NOVA · StudyOS Intelligence";
      bubble.append(head);
      if (message.pending) {
        const typing = document.createElement("div");
        typing.className = "ai-thinking";
        typing.setAttribute("role", "status");
        typing.setAttribute("aria-label", "NOVA is answering");
        for (let dotIndex = 0; dotIndex < 3; dotIndex += 1) {
          const dot = document.createElement("span");
          typing.append(dot);
        }
        bubble.append(typing);
        conversation.append(bubble);
        return;
      }
      const answer = document.createElement("div");
      answer.innerHTML = formatDoubtAnswer(message.content);
      bubble.append(answer);
      renderMathIfAvailable(answer);
    } else {
      bubble.textContent = message.content;
    }
    conversation.append(bubble);
  });
  conversation.scrollTop = conversation.scrollHeight;
}

function updateDoubtChapters() {
  const subjectSelect = $("#doubt-subject");
  const chapterSelect = $("#doubt-chapter");
  if (!subjectSelect || !chapterSelect) return;
  const subject = subjectSelect.value === "Mathematics" ? "Maths" : subjectSelect.value;
  chapterSelect.replaceChildren(new Option("No chapter selected", ""));
  (libraryData[subject] || [])
    .filter((chapter) => chapter.contentStatus === "written" && chapter.syllabusScope === "included")
    .forEach((chapter) => {
    chapterSelect.append(new Option(chapter.name, chapter.name));
  });
}

async function checkDoubtProvider() {
  const status = $("#doubt-status");
  if (!status) return;
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not check AI service.");
    const data = await response.json();
    status.textContent = data.providerConfigured
      ? "NOVA is ready. Ask an academic question for a clear, step-by-step explanation."
      : "NOVA setup needed: the server AI provider is not configured.";
  } catch {
    status.textContent = navigator.onLine
      ? "Could not connect to the NOVA service."
      : "You are offline. Check your connection and try again.";
  }
}

function initializeDoubtSolver() {
  const subjectSelect = $("#doubt-subject");
  const chapterSelect = $("#doubt-chapter");
  if (!subjectSelect || !chapterSelect) return;

  try {
    doubtUserId = localStorage.getItem(DOUBT_USER_KEY) || createDoubtId("user");
    localStorage.setItem(DOUBT_USER_KEY, doubtUserId);
  } catch {
    doubtUserId = createDoubtId("user");
  }
  doubtUserId = doubtUserId.slice(0, 80);

  doubtConversations = readDoubtStorage(DOUBT_CONVERSATIONS_KEY, []);
  const active = doubtConversations.find((item) => item.active);
  if (!active) {
    doubtConversationId = createDoubtId("conversation").slice(0, 80);
    doubtConversations.unshift({
      id: doubtConversationId,
      active: true,
      createdAt: new Date().toISOString(),
      messages: []
    });
    saveDoubtConversations();
  } else {
    doubtConversationId = active.id;
  }

  if (!subjectSelect.dataset.initialized) {
    subjectSelect.addEventListener("change", updateDoubtChapters);
    subjectSelect.dataset.initialized = "true";
  }
  updateDoubtChapters();
  renderDoubtConversation();
  checkDoubtProvider();
}

function clearDoubtConversation() {
  if (doubtRequestInFlight) {
    const status = $("#doubt-status");
    if (status) status.textContent = "Please wait for the current answer before clearing the conversation.";
    return;
  }

  doubtConversations = readDoubtStorage(DOUBT_CONVERSATIONS_KEY, doubtConversations);
  doubtConversations.forEach((conversation) => {
    conversation.active = false;
  });

  doubtConversationId = createDoubtId("conversation").slice(0, 80);
  doubtConversations.unshift({
    id: doubtConversationId,
    active: true,
    createdAt: new Date().toISOString(),
    messages: []
  });
  saveDoubtConversations();

  const input = $("#doubt-input");
  const status = $("#doubt-status");
  const imagePreview = $("#doubt-image-preview");
  const imageInput = $("#doubt-image-input");
  if (input) input.value = "";
  if (status) status.textContent = "Conversation cleared. Start a new doubt.";
  if (imagePreview) imagePreview.replaceChildren();
  if (imageInput) imageInput.value = "";
  doubtAttachment = null;
  renderDoubtConversation();
}

async function sendDoubtMessage(text, mode = "normal") {
  if (doubtRequestInFlight) return;
  const input = $("#doubt-input");
  const status = $("#doubt-status");
  const sendButton = $("#doubt-send");
  const question = String(text || "").trim();
  if (!question) return;
  if (!navigator.onLine) {
    if (status) status.textContent = "You are offline. Check your connection and try again.";
    return;
  }

  initializeDoubtSolver();
  const active = getActiveDoubtConversation();
  if (!active) return;

  doubtRequestInFlight = true;
  if (sendButton) sendButton.disabled = true;
  if (status) status.textContent = "NOVA is thinking through your question...";
  active.messages.push({
    id: createDoubtId("message"),
    role: "user",
    content: question,
    createdAt: new Date().toISOString()
  });
  const pendingAnswerId = createDoubtId("message");
  active.messages.push({
    id: pendingAnswerId,
    role: "assistant",
    content: "",
    pending: true,
    createdAt: new Date().toISOString()
  });
  saveDoubtConversations();
  renderDoubtConversation();
  if (input) input.value = "";

  try {
    const history = active.messages.slice(-13).filter((message) =>
      message.role === "user" || message.role === "assistant"
    );
    const response = await fetch("/api/doubt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: doubtUserId,
        conversationId: doubtConversationId,
        question,
        subject: $("#doubt-subject")?.value || "Physics",
        chapter: $("#doubt-chapter")?.value || "",
        mode,
        history: history.slice(0, -1),
        images: []
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "The AI request failed.");
    if (typeof data.answer !== "string" || !data.answer.trim()) {
      throw new Error("The AI returned an empty answer. Please try again.");
    }
    const pendingAnswer = active.messages.find((message) => message.id === pendingAnswerId);
    if (pendingAnswer) {
      pendingAnswer.content = data.answer;
      pendingAnswer.pending = false;
      pendingAnswer.createdAt = new Date().toISOString();
    }
    saveDoubtConversations();
    renderDoubtConversation();
    if (status) status.textContent = `NOVA answered with ${data.provider || "the configured AI provider"}.`;
  } catch (error) {
    const pendingAnswerIndex = active.messages.findIndex((message) => message.id === pendingAnswerId);
    if (pendingAnswerIndex >= 0) active.messages.splice(pendingAnswerIndex, 1);
    saveDoubtConversations();
    renderDoubtConversation();
    if (status) status.textContent = error.message;
  } finally {
    doubtRequestInFlight = false;
    if (sendButton) sendButton.disabled = false;
  }
}

function renderSavedDoubts() {
  const output = $("#saved-doubts-content");
  if (!output) return;
  output.replaceChildren();
  output.hidden = true;
}

$("#doubt-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  event.stopPropagation();
  sendDoubtMessage($("#doubt-input")?.value || "", "normal");
});
$("#doubt-hint-action")?.addEventListener("click", () => {
  sendDoubtMessage($("#doubt-input")?.value || "Please give me a hint for my current doubt.", "hint");
});
$("#doubt-simple-action")?.addEventListener("click", () => {
  sendDoubtMessage($("#doubt-input")?.value || "Please explain my current doubt more simply.", "simple");
});
$("#doubt-clear-history")?.addEventListener("click", () => {
  clearDoubtConversation();
});

// ---------- VECTRA Assessment Generator ----------

let aiTestRequestInFlight = false;
let currentAITest = null;
let aiTestAnswers = {};

function updateAITestChapters() {
  const subjectSelect = $("#ai-test-subject");
  const chapterSelect = $("#ai-test-chapter");
  if (!subjectSelect || !chapterSelect) return;

  const subjectKey = subjectSelect.value === "Mathematics" ? "Maths" : subjectSelect.value;
  chapterSelect.replaceChildren();

  const chapters = (libraryData[subjectKey] || [])
    .filter((chapter) => chapter.contentStatus === "written" && chapter.syllabusScope === "included");
  if (chapters.length) {
    chapters.forEach((chapter) => {
      chapterSelect.append(new Option(chapter.name, chapter.name));
    });
  } else {
    chapterSelect.append(new Option("General practice", "General practice"));
  }
}

function initializeAITest() {
  const subjectSelect = $("#ai-test-subject");
  if (!subjectSelect || subjectSelect.dataset.initialized) {
    updateAITestChapters();
    return;
  }
  subjectSelect.addEventListener("change", updateAITestChapters);
  subjectSelect.dataset.initialized = "true";
  updateAITestChapters();
  checkAITestProvider();
}

async function checkAITestProvider() {
  const status = $("#ai-test-status");
  if (!status) return;
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const data = await response.json();
    status.textContent = data.providerConfigured
      ? "VECTRA is ready. Choose a subject and topic to build your assessment."
      : "VECTRA setup needed: the server AI provider is not configured.";
  } catch {
    status.textContent = navigator.onLine
      ? "Could not connect to the VECTRA service."
      : "You are offline. Check your connection and try again.";
  }
}

function renderAITest() {
  const content = $("#ai-test-content");
  if (!content || !currentAITest) return;

  const title = document.createElement("div");
  title.className = "ai-test-title";
  title.innerHTML = `<h2>${escapeDoubtHtml(currentAITest.title)}</h2><p class="muted">${escapeDoubtHtml($("#ai-test-subject").value)} · ${escapeDoubtHtml($("#ai-test-chapter").value)}</p>`;

  const form = document.createElement("form");
  form.id = "ai-test-questions-form";

  currentAITest.questions.forEach((question, questionIndex) => {
    const card = document.createElement("article");
    card.className = "ai-test-question";

    const heading = document.createElement("div");
    heading.className = "ai-test-question-heading";
    heading.innerHTML = `<span>Question ${questionIndex + 1} <small>· 1 mark</small></span><small>${escapeDoubtHtml(question.difficulty)}</small>`;
    card.append(heading);

    const prompt = document.createElement("div");
    prompt.className = "ai-test-question-text";
    prompt.innerHTML = escapeDoubtHtml(question.question);
    card.append(prompt);

    const options = document.createElement("div");
    options.className = "ai-test-options";
    question.options.forEach((option, optionIndex) => {
      const label = document.createElement("label");
      label.className = "ai-test-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `ai-question-${questionIndex}`;
      input.value = String(optionIndex);
      input.checked = aiTestAnswers[questionIndex] === optionIndex;
      input.addEventListener("change", () => {
        aiTestAnswers[questionIndex] = optionIndex;
      });
      const text = document.createElement("span");
      text.textContent = String.fromCharCode(65 + optionIndex) + ". " + option;
      label.append(input, text);
      options.append(label);
    });
    card.append(options);

    const explanation = document.createElement("div");
    explanation.className = "ai-test-explanation hidden";
    explanation.innerHTML = `<strong>Explanation</strong><p>${escapeDoubtHtml(question.explanation)}</p>`;
    card.append(explanation);
    form.append(card);
  });

  const actions = document.createElement("div");
  actions.className = "ai-test-actions";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary-button";
  submit.textContent = "Submit answers";
  const score = document.createElement("div");
  score.id = "ai-test-score";
  score.className = "ai-test-score";
  actions.append(score, submit);
  form.append(actions);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    let correct = 0;
    currentAITest.questions.forEach((question, index) => {
      const card = form.querySelectorAll(".ai-test-question")[index];
      const selected = aiTestAnswers[index];
      const options = card.querySelectorAll(".ai-test-option");
      options.forEach((option, optionIndex) => {
        option.classList.remove("correct", "incorrect");
        if (optionIndex === question.correctIndex) option.classList.add("correct");
        if (selected === optionIndex && selected !== question.correctIndex) {
          option.classList.add("incorrect");
        }
        option.querySelector("input").disabled = true;
      });
      if (selected === question.correctIndex) correct += 1;
      if (selected !== question.correctIndex) saveStudyMistake({
        question: question.question, subject: $("#ai-test-subject").value,
        chapter: $("#ai-test-chapter").value, selectedAnswer: selected == null ? "Not answered" : question.options[selected],
        correctAnswer: question.options[question.correctIndex], explanation: question.explanation,
        difficulty: question.difficulty || "Mixed", source: "VECTRA"
      });
      card.querySelector(".ai-test-explanation").classList.remove("hidden");
    });
    submit.disabled = true;
    const percentage = currentAITest.questions.length
      ? Math.round((correct / currentAITest.questions.length) * 100)
      : 0;
    score.innerHTML = `<strong>${correct}/${currentAITest.questions.length}</strong><span> marks · ${percentage}% · ${percentage}% accuracy</span>`;
    const weakTopics = new Set();
    currentAITest.questions.forEach((question, index) => {
      if (aiTestAnswers[index] !== question.correctIndex) {
        weakTopics.add(question.topic || $("#ai-test-chapter").value || "Selected chapter");
      }
    });
    const insight = document.createElement("p");
    insight.className = "ai-test-insight muted";
    insight.textContent = weakTopics.size
      ? `Review these topics: ${Array.from(weakTopics).join(", ")}. Explanations are shown with each question.`
      : "Excellent work. No weak topics found in this attempt.";
    actions.append(insight);
    submit.hidden = true;
    renderMathIfAvailable(form);
  });

  content.replaceChildren(title, form);
  renderMathIfAvailable(content);
}

async function generateAITest() {
  if (aiTestRequestInFlight) return;
  const status = $("#ai-test-status");
  const button = $("#ai-test-generate");
  const content = $("#ai-test-content");
  if (!navigator.onLine) {
    if (status) status.textContent = "You are offline. Check your connection and try again.";
    return;
  }

  aiTestRequestInFlight = true;
  button.disabled = true;
  if (status) status.textContent = "VECTRA is building your assessment...";
  if (content) {
    content.innerHTML = `
      <div class="ai-generating-state" role="status" aria-live="polite">
        <div class="ai-generating-orbit" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <h2>VECTRA is creating your test</h2>
        <p class="muted">Preparing questions, options, marks and explanations...</p>
        <div class="ai-generating-progress"><span></span></div>
      </div>`;
  }

  let userId;
  try {
    userId = localStorage.getItem(DOUBT_USER_KEY) || createDoubtId("user");
    localStorage.setItem(DOUBT_USER_KEY, userId);
  } catch {
    userId = createDoubtId("user");
  }

  try {
    const response = await fetch("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: userId.slice(0, 80),
        subject: $("#ai-test-subject").value,
        chapter: $("#ai-test-chapter").value,
        difficulty: $("#ai-test-difficulty").value,
        count: Number($("#ai-test-count").value)
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "The AI test request failed.");
    currentAITest = data;
    aiTestAnswers = {};
    status.textContent = `VECTRA assessment generated by ${data.provider || "the configured AI provider"}. Each question is worth 1 mark.`;
    renderAITest();
  } catch (error) {
    status.textContent = error.message;
    if (content && !currentAITest) {
      content.innerHTML = `
        <div class="ai-test-empty">
          <span>!</span>
          <h2>VECTRA generation stopped</h2>
          <p class="muted">${escapeDoubtHtml(error.message)}</p>
        </div>`;
    }
  } finally {
    aiTestRequestInFlight = false;
    button.disabled = false;
  }
}

$("#ai-test-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  generateAITest();
});

$("#ai-test-reset")?.addEventListener("click", () => {
  currentAITest = null;
  aiTestAnswers = {};
  const content = $("#ai-test-content");
  if (content) {
    content.innerHTML = `
      <div class="ai-test-empty">
        <span>✦</span>
        <h2>Build a focused VECTRA assessment</h2>
        <p class="muted">Choose a chapter and difficulty, then generate your test.</p>
      </div>`;
  }
  $("#ai-test-status").textContent = "";
});

// ---------- Focus timer ----------

const timerDisplay = $("#timer-display");
const startButton = $("#timer-start");
const resetButton = $("#timer-reset");
const FOCUS_SESSIONS_KEY = "studyos-focus-sessions";

let timerDuration = 25 * 60;
let timerRemaining = timerDuration;
let timerRunning = false;
let timerDeadline = null;
let timerInterval = null;
let timerCompletionKey = null;

let focusSessions = [];

try {
  const savedSessions = localStorage.getItem(FOCUS_SESSIONS_KEY);
  focusSessions = savedSessions ? JSON.parse(savedSessions) : [];
  if (!Array.isArray(focusSessions)) focusSessions = [];
} catch {
  focusSessions = [];
}

function saveFocusSessions() {
  try {
    localStorage.setItem(FOCUS_SESSIONS_KEY, JSON.stringify(focusSessions));
  } catch {
    // Keep the timer usable if browser storage is unavailable.
  }
}

function localDateKey(dateValue) {
  const date = new Date(dateValue);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function recordCompletedFocusSession() {
  if (!timerCompletionKey) return;
  if (focusSessions.some((session) => session.id === timerCompletionKey)) return;

  focusSessions.push({
    id: timerCompletionKey,
    completedAt: new Date().toISOString(),
    durationMinutes: Math.max(1, Math.round(timerDuration / 60))
  });

  saveFocusSessions();
  timerCompletionKey = null;
}

function renderTimer() {
  const minutes = Math.floor(timerRemaining / 60);
  const seconds = timerRemaining % 60;

  timerDisplay.textContent =
    `${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")}`;

  startButton.textContent = timerRunning ? "Pause" : "Start";
}

function stopTimerInterval() {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function finishTimer() {
  stopTimerInterval();
  timerRunning = false;
  timerRemaining = 0;
  timerDeadline = null;

  renderTimer();
  recordCompletedFocusSession();
  renderHomeAnalytics();
  renderAnalytics();

  alert("Focus session finished! Take a moment to record what you learned.");
}

function updateTimer() {
  if (!timerRunning || timerDeadline === null) return;

  timerRemaining = Math.max(
    0,
    Math.ceil((timerDeadline - Date.now()) / 1000)
  );

  renderTimer();

  if (timerRemaining <= 0) {
    finishTimer();
  }
}

function startTimer() {
  timerRunning = true;
  timerDeadline = Date.now() + timerRemaining * 1000;
  timerCompletionKey = `focus-${timerDeadline}-${timerDuration}`;

  stopTimerInterval();
  timerInterval = setInterval(updateTimer, 250);

  renderTimer();
}

function pauseTimer() {
  updateTimer();

  if (!timerRunning) return;

  timerRunning = false;
  timerDeadline = null;

  stopTimerInterval();
  renderTimer();
}

startButton.addEventListener("click", () => {
  if (timerRunning) {
    pauseTimer();
  } else if (timerRemaining > 0) {
    startTimer();
  }
});

resetButton.addEventListener("click", () => {
  stopTimerInterval();

  timerRunning = false;
  timerDeadline = null;
  timerRemaining = timerDuration;
  timerCompletionKey = null;

  renderTimer();
});

function setTimerMinutes(minutes) {
  if (timerRunning) {
    const confirmed = window.confirm(
      "Replace the running timer with a new duration?"
    );

    if (!confirmed) return;
  }

  stopTimerInterval();

  timerDuration = minutes * 60;
  timerRemaining = timerDuration;
  timerRunning = false;
  timerDeadline = null;
  timerCompletionKey = null;

  renderTimer();
}

// Recover the display after returning from another Safari tab.
// Cloud session persistence will be implemented later.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    updateTimer();
  }
});

renderTimer();

// ---------- Subject Corner ----------

/* StudyOS chapter library */
const libraryData = {
  Physics: [
    {
      name: "Units, Dimensions and Measurements",
      chapterId: "physics-units-dimensions-and-measurements",
      notes: "CHAPTER 1: UNITS, DIMENSIONS AND MEASUREMENTS\n\n1. MEASUREMENT AND PHYSICAL QUANTITIES\n\nA physical quantity is a measurable property expressed as a numerical value and a unit.\n\nPhysical quantity = numerical value × unit.\n\nExamples: Length = 5 m; mass = 2 kg; time = 3 s.\n\nFundamental quantities are independent base quantities in a chosen system. Derived quantities are expressed using other quantities, such as velocity, force, density, and energy.\n\n2. SI BASE QUANTITIES\n\n| Base quantity | SI unit | Symbol |\n| Length | metre | m |\n| Mass | kilogram | kg |\n| Time | second | s |\n| Electric current | ampere | A |\n| Thermodynamic temperature | kelvin | K |\n| Amount of substance | mole | mol |\n| Luminous intensity | candela | cd |\n\nCommon prefixes:\n\n| Prefix | Symbol | Factor |\n| kilo | k | 10^3 |\n| mega | M | 10^6 |\n| giga | G | 10^9 |\n| centi | c | 10^-2 |\n| milli | m | 10^-3 |\n| micro | μ | 10^-6 |\n| nano | n | 10^-9 |\n| pico | p | 10^-12 |\n\nUnit symbols are case-sensitive. Write 5 kg, not 5 kgs. Leave a space between a numerical value and its unit.\n\n3. IMPORTANT DERIVED UNITS\n\nVelocity: v = displacement/time; SI unit: m s^-1.\n\nAcceleration: a = change in velocity/time; SI unit: m s^-2.\n\nForce: F = ma; newton (N) = kg m s^-2.\n\nWork and energy: W = force × displacement; joule (J) = kg m² s^-2.\n\nPower: P = work/time; watt (W) = kg m² s^-3.\n\nPressure: force/area; pascal (Pa) = kg m^-1 s^-2.\n\nDensity: mass/volume; SI unit: kg m^-3.\n\nFrequency: f = 1/time; hertz (Hz) = s^-1.\n\n4. DIMENSIONS AND DIMENSIONAL FORMULAE\n\nUse M for mass, L for length, T for time, I for electric current, and Θ for temperature.\n\nVelocity: [LT^-1]\n\nAcceleration: [LT^-2]\n\nArea: [L²]\n\nVolume: [L³]\n\nDensity: [ML^-3]\n\nMomentum: [MLT^-1]\n\nForce: [MLT^-2]\n\nWork and energy: [ML²T^-2]\n\nPower: [ML²T^-3]\n\nPressure: [ML^-1T^-2]\n\nFrequency: [T^-1]\n\nGravitational constant: [M^-1L³T^-2]\n\nSpring constant: [MT^-2]\n\nSurface tension: [MT^-2]\n\nDynamic viscosity: [ML^-1T^-1]\n\nPlanck constant: [ML²T^-1]\n\nElectric charge: [IT]\n\nPotential difference: [ML²T^-3I^-1]\n\n5. FINDING DIMENSIONAL FORMULAE\n\nMethod:\n\n1. Write the defining equation.\n2. Substitute dimensions.\n3. Simplify powers.\n\nExample 1: Force\n\nF = ma\n\n[F] = M × LT^-2 = [MLT^-2].\n\nExample 2: Gravitational constant\n\nFrom Newton's law of gravitation:\n\nF = Gm₁m₂/r²\n\nG = Fr²/(m₁m₂)\n\n[G] = (MLT^-2)(L²)/(M²) = [M^-1L³T^-2].\n\nExample 3: Spring constant\n\nFrom Hooke's law F = kx:\n\n[k] = [F]/[x] = [MT^-2].\n\n6. PRINCIPLE OF DIMENSIONAL HOMOGENEITY\n\nA physically valid equation must have compatible dimensions on both sides. Terms added or subtracted must also have the same dimensions.\n\nFor s = ut + ½at²:\n\n[s] = L\n\n[ut] = (LT^-1)(T) = L\n\n[at²] = (LT^-2)(T²) = L\n\nThe equation is dimensionally homogeneous.\n\nDimensional consistency is necessary but not sufficient to prove an equation physically correct. It cannot determine dimensionless constants such as ½ or π.\n\n7. USES AND LIMITATIONS OF DIMENSIONAL ANALYSIS\n\nUses:\n\n- Check dimensional consistency.\n- Derive possible proportional relationships.\n- Convert between unit systems.\n- Find dimensions of constants.\n\nLimitations:\n\n- Cannot determine pure numerical constants.\n- Cannot distinguish physically different quantities with identical dimensions, such as work and torque.\n- Cannot establish a complete physical law.\n- Cannot determine dependence on dimensionless parameters without extra information.\n- Cannot independently determine whether a relation involving sums, trigonometric functions, or exponentials is physically correct.\n\n8. DERIVING A RELATION BY DIMENSIONS\n\nSuppose a simple pendulum's period T depends on length l and gravitational acceleration g.\n\nAssume T = C l^a g^b, where C is dimensionless.\n\n[T] = [L]^a[LT^-2]^b = L^(a+b)T^(-2b).\n\nComparing powers:\n\nFor time: 1 = -2b, so b = -½.\n\nFor length: 0 = a + b, so a = ½.\n\nTherefore T = C√(l/g).\n\nDimensional analysis cannot find C. For a simple pendulum undergoing small oscillations, the actual result is T = 2π√(l/g).\n\n9. SIGNIFICANT FIGURES\n\nRules:\n\n- Every non-zero digit is significant.\n- Zeros between non-zero digits are significant.\n- Leading zeros are not significant.\n- Trailing zeros after a decimal point are significant.\n- Use scientific notation to remove ambiguity in trailing zeros.\n\nExamples:\n\n245: 3 significant figures.\n\n2005: 4 significant figures.\n\n0.0045: 2 significant figures.\n\n2.500: 4 significant figures.\n\n6.02 × 10^23: 3 significant figures.\n\nMultiplication/division: round according to the least number of significant figures in the measured inputs.\n\nAddition/subtraction: round to the least precise decimal place.\n\nExamples:\n\n2.5 × 3.42 = 8.55, rounded to 2 significant figures gives 8.6.\n\n12.11 + 18.0 = 30.11, rounded to one decimal place gives 30.1.\n\nExact counted values and defined conversion factors do not limit significant figures like measured values do.\n\n10. ERRORS AND UNCERTAINTIES\n\nFor a reference value x_ref and measurement x, absolute error = |x - x_ref|.\n\nFor repeated measurements x₁, x₂, …, xₙ, the mean is:\n\nx_mean = (x₁ + x₂ + … + xₙ)/n.\n\nMean absolute deviation:\n\nΔx = Σ|xᵢ - x_mean|/n.\n\nRelative uncertainty = Δx/|x_mean|.\n\nPercentage uncertainty = 100 × Δx/|x_mean|.\n\nRandom errors vary unpredictably; systematic errors cause consistent bias; gross errors arise from mistakes in observation or recording.\n\n11. PROPAGATION OF UNCERTAINTY\n\nFor maximum-error estimates with small uncertainties:\n\nIf z = x ± y, then Δz ≈ Δx + Δy.\n\nIf z = xy or z = x/y, then Δz/|z| ≈ Δx/|x| + Δy/|y|.\n\nIf z = x^n, then Δz/|z| ≈ |n|Δx/|x|.\n\nFor z = x^a y^b/w^c:\n\nΔz/|z| ≈ |a|Δx/|x| + |b|Δy/|y| + |c|Δw/|w|.\n\nThese are maximum-error estimates. Statistical uncertainty propagation can differ depending on independence and error distributions.\n\nExample:\n\nl = 10.0 ± 0.1 cm and b = 5.0 ± 0.1 cm.\n\nArea A = lb = 50.0 cm².\n\nFractional uncertainty ≈ 0.1/10.0 + 0.1/5.0 = 0.03.\n\nTherefore ΔA ≈ 1.5 cm² and A ≈ 50.0 ± 1.5 cm² under this convention.\n\n12. VERNIER CALIPERS AND SCREW GAUGE\n\nVernier calipers measure external dimensions, internal dimensions, and depth.\n\nFor a common direct vernier:\n\nLeast count = 1 main-scale division - 1 vernier-scale division.\n\nReading = main-scale reading + coinciding vernier division × least count, with zero correction applied.\n\nFor a screw gauge:\n\nPitch = distance moved in one complete rotation.\n\nLeast count = pitch/number of circular-scale divisions.\n\nReading = sleeve-scale reading + circular-scale reading × least count, with zero correction applied.\n\nZero correction is the negative of zero error. Always apply its sign correctly.\n\n13. SOLVED EXAMPLES\n\nExample 1: Dimensions of pressure.\n\nPressure = force/area.\n\n[Pressure] = [MLT^-2]/[L²] = [ML^-1T^-2].\n\nExample 2: Convert 72 km/h into m/s.\n\n72 × 1000/3600 = 20 m/s.\n\nExample 3: Significant figures in 0.005060.\n\nLeading zeros do not count. The digits 5, 0, 6, and the final 0 count: 4 significant figures.\n\nExample 4: Check s = ut + at² dimensionally.\n\nEvery term has dimensions of length, so the equation is dimensionally homogeneous. This does not prove that the equation describes the physical motion correctly.\n\nExample 5: Dimensions of energy.\n\nEnergy = force × displacement.\n\n[Energy] = [MLT^-2][L] = [ML²T^-2].\n\nExample 6: Dimensions of frequency.\n\nFrequency = 1/time, so [f] = [T^-1].\n\n14. COMMON MISTAKES\n\n- Confusing units with dimensions.\n- Assuming dimensional consistency proves an equation correct.\n- Forgetting that dimensional analysis cannot find dimensionless constants.\n- Using significant-figure rules for multiplication when adding values.\n- Counting leading zeros as significant.\n- Forgetting zero correction.\n- Confusing mass with weight.\n- Assuming equal dimensions mean identical physical quantities.\n- Treating all errors as random.\n\n15. QUICK REVISION SHEET\n\nVelocity: [LT^-1]\n\nAcceleration: [LT^-2]\n\nForce: [MLT^-2]\n\nMomentum: [MLT^-1]\n\nEnergy: [ML²T^-2]\n\nPower: [ML²T^-3]\n\nPressure: [ML^-1T^-2]\n\nDensity: [ML^-3]\n\nFrequency: [T^-1]\n\nGravitational constant: [M^-1L³T^-2]\n\nEvery term in a valid physical equation must have compatible dimensions.\n\nAddition/subtraction: add maximum absolute uncertainties.\n\nMultiplication/division: add fractional maximum uncertainties.\n\nPowers: multiply fractional uncertainty by the absolute exponent.",
      formulas: "UNITS, DIMENSIONS AND MEASUREMENTS FORMULA SHEET\n\nVelocity: v = displacement/time\nVelocity dimensions: [LT^-1]\nAcceleration: a = change in velocity/time\nAcceleration dimensions: [LT^-2]\nForce: F = ma\nForce dimensions: [MLT^-2]\nMomentum: p = mv\nMomentum dimensions: [MLT^-1]\nWork or energy: W = Fs cos(theta)\nEnergy dimensions: [ML²T^-2]\nPower: P = work/time\nPower dimensions: [ML²T^-3]\nPressure: P = force/area\nPressure dimensions: [ML^-1T^-2]\nDensity: rho = mass/volume\nDensity dimensions: [ML^-3]\nFrequency: f = 1/T\nFrequency dimensions: [T^-1]\nGravitational constant: [M^-1L³T^-2]\nSpring constant: [MT^-2]\nSurface tension: [MT^-2]\nDynamic viscosity: [ML^-1T^-1]\nPlanck constant: [ML²T^-1]\nElectric charge dimensions: [IT]\nPotential difference dimensions: [ML²T^-3I^-1]\nPendulum period: T = 2π√(l/g)\nAddition uncertainty: Δz = Δx + Δy\nFractional uncertainty for products or quotients: Δz/|z| = Δx/|x| + Δy/|y|\nPower uncertainty: Δz/|z| = |n|Δx/|x|"
    },
    {
      name: "Vectors",
      chapterId: "physics-vectors",
      notes: "CHAPTER 2: VECTORS AND VECTOR ALGEBRA\n\n==================================================\n\n1. SCALARS AND VECTORS\n\n==================================================\n\nA scalar quantity has magnitude only. Examples: mass, time, temperature, distance, speed, energy.\n\nA vector quantity has magnitude and direction and obeys vector addition laws. Examples: displacement, velocity, acceleration, force, momentum.\n\nImportant distinctions:\n\n- Distance is scalar; displacement is vector.\n- Speed is scalar; velocity is vector.\n- Mass is scalar; force is vector.\n- Work is scalar; torque is a vector.\n\nA vector is represented by a directed line segment. Its length represents magnitude under a chosen scale, and its arrow indicates direction.\n\nThe magnitude of vector A is written |A| or simply A when there is no ambiguity.\n\nA unit vector has magnitude 1 and indicates direction.\n\nThe zero vector has magnitude zero; its direction is undefined.\n\n==================================================\n\n2. TYPES OF VECTORS\n\nEqual vectors: same magnitude and direction, even if their starting points differ.\n\nNegative vectors: same magnitude but opposite directions.\n\nParallel vectors: their directions are parallel; they may point in the same or opposite senses.\n\nCollinear vectors: vectors along the same line of action or parallel lines, depending on context.\n\nCoplanar vectors: vectors that lie in the same plane.\n\nPosition vector: locates a point relative to an origin.\n\nDisplacement vector: change in position.\n\nUnit vector: vector divided by its non-zero magnitude.\n\n==================================================\n\n3. VECTOR REPRESENTATION IN CARTESIAN COORDINATES\n\nIn two dimensions:\n\nA = Aₓ î + Aᵧ ĵ\n\nIn three dimensions:\n\nA = Aₓ î + Aᵧ ĵ + Aᶻ k̂\n\nHere î, ĵ, k̂ are unit vectors along the positive x, y, z axes.\n\nMagnitude in two dimensions:\n\n|A| = √(Aₓ² + Aᵧ²)\n\nMagnitude in three dimensions:\n\n|A| = √(Aₓ² + Aᵧ² + Aᶻ²)\n\nIf A makes an angle θ measured anticlockwise from the positive x-axis in a 2D plane:\n\nAₓ = A cos θ\n\nAᵧ = A sin θ\n\nTherefore:\n\nA = A cos θ î + A sin θ ĵ\n\nThe angle must be interpreted according to the chosen reference axis and sign convention.\n\nExample:\n\nA vector of magnitude 10 makes an angle of 30° with the positive x-axis.\n\nAₓ = 10 cos 30° = 5√3\n\nAᵧ = 10 sin 30° = 5\n\nThus A = 5√3 î + 5 ĵ.\n\n==================================================\n\n4. FINDING A UNIT VECTOR\n\nFor a non-zero vector A:\n\nÂ = A/|A|\n\nIf A = 3î + 4ĵ, then:\n\n|A| = √(9 + 16) = 5\n\nTherefore:\n\nÂ = (3/5)î + (4/5)ĵ.\n\nThe unit vector has magnitude 1.\n\n==================================================\n\n5. VECTOR ADDITION\n\nGraphical methods:\n\n- Triangle law\n- Parallelogram law\n- Polygon law for several vectors\n\nIf two vectors A and B have an angle θ between them, the resultant R = A + B has magnitude:\n\nR = √(A² + B² + 2AB cos θ)\n\nSpecial cases:\n\nSame direction, θ = 0°:\n\nR = A + B.\n\nOpposite directions, θ = 180°:\n\nR = |A − B|.\n\nPerpendicular vectors, θ = 90°:\n\nR = √(A² + B²).\n\nIf A and B are perpendicular, the direction angle α of R measured from A toward B satisfies:\n\ntan α = B/A.\n\nFor vectors at arbitrary angles, use components:\n\nRₓ = Aₓ + Bₓ\n\nRᵧ = Aᵧ + Bᵧ\n\nRᶻ = Aᶻ + Bᶻ\n\nThen calculate the magnitude and direction from the resultant components.\n\nExample:\n\nA = 3î + 2ĵ and B = î − 5ĵ.\n\nA + B = 4î − 3ĵ.\n\nMagnitude = √(16 + 9) = 5.\n\n==================================================\n\n6. VECTOR SUBTRACTION\n\nA − B = A + (−B).\n\nThe vector −B has the same magnitude as B but opposite direction.\n\nIn components:\n\nA − B = (Aₓ − Bₓ)î + (Aᵧ − Bᵧ)ĵ + (Aᶻ − Bᶻ)k̂.\n\nExample:\n\nA = 5î + 2ĵ, B = 2î − ĵ.\n\nA − B = 3î + 3ĵ.\n\nMagnitude = √18 = 3√2.\n\n==================================================\n\n7. RESOLUTION OF VECTORS\n\nA vector can be resolved into perpendicular components.\n\nIf A makes angle θ with the positive x-axis:\n\nAₓ = A cos θ\n\nAᵧ = A sin θ.\n\nThe signs depend on the quadrant:\n\n- Quadrant I: x positive, y positive.\n- Quadrant II: x negative, y positive.\n- Quadrant III: x negative, y negative.\n- Quadrant IV: x positive, y negative.\n\nFor several vectors:\n\nRₓ = ΣAₓ\n\nRᵧ = ΣAᵧ\n\nMagnitude:\n\nR = √(Rₓ² + Rᵧ²)\n\nDirection:\n\ntan θ = Rᵧ/Rₓ.\n\nUse the signs of both components to identify the correct quadrant; inverse tangent alone may return an angle in the wrong quadrant.\n\n==================================================\n\n8. POSITION AND DISPLACEMENT VECTORS\n\nFor a point P(x, y, z), its position vector relative to the origin is:\n\nr = x î + y ĵ + z k̂.\n\nFor initial position r₁ and final position r₂:\n\nDisplacement Δr = r₂ − r₁.\n\nIf P₁(x₁,y₁,z₁) and P₂(x₂,y₂,z₂):\n\nΔr = (x₂ − x₁)î + (y₂ − y₁)ĵ + (z₂ − z₁)k̂.\n\nMagnitude:\n\n|Δr| = √[(x₂ − x₁)² + (y₂ − y₁)² + (z₂ − z₁)²].\n\nExample:\n\nA particle moves from (1,2) to (4,6).\n\nΔr = 3î + 4ĵ.\n\nDisplacement magnitude = 5 units.\n\n==================================================\n\n9. DOT PRODUCT (SCALAR PRODUCT)\n\nThe dot product of A and B is:\n\nA · B = AB cos θ.\n\nIt produces a scalar.\n\nIn Cartesian components:\n\nA · B = AₓBₓ + AᵧBᵧ + AᶻBᶻ.\n\nProperties:\n\n- A · B = B · A.\n- A · (B + C) = A · B + A · C.\n- A · A = |A|².\n- î · î = ĵ · ĵ = k̂ · k̂ = 1.\n- î · ĵ = ĵ · k̂ = k̂ · î = 0.\n\nFor non-zero vectors:\n\n- Parallel and same direction: A · B = AB.\n- Perpendicular: A · B = 0.\n- Opposite directions: A · B = −AB.\n\nThe angle between non-zero vectors is found from:\n\ncos θ = (A · B)/(|A||B|).\n\nApplications:\n\nWork W = F · s = Fs cos θ for constant force and displacement.\n\nExample:\n\nA = 2î + 3ĵ and B = 4î − ĵ.\n\nA · B = 2(4) + 3(−1) = 5.\n\n==================================================\n\n10. CROSS PRODUCT (VECTOR PRODUCT)\n\nThe cross product is:\n\nA × B = AB sin θ n̂,\n\nwhere n̂ is perpendicular to the plane containing A and B, with direction given by the right-hand rule.\n\nIts magnitude is AB sin θ.\n\nIn Cartesian components:\n\nA × B =\n\n(AᵧBᶻ − AᶻBᵧ)î\n\n- (AᶻBₓ − AₓBᶻ)ĵ\n- (AₓBᵧ − AᵧBₓ)k̂.\n\nProperties:\n\n- A × B = −(B × A).\n- A × A = 0.\n- A × (B + C) = A × B + A × C.\n- The cross product is not commutative.\n\nUnit-vector identities:\n\nî × ĵ = k̂\n\nĵ × k̂ = î\n\nk̂ × î = ĵ\n\nReversing the order changes the sign.\n\nFor parallel or antiparallel vectors, the cross product is zero.\n\nFor perpendicular vectors, its magnitude is AB.\n\nApplications:\n\n- Torque: τ = r × F.\n- Angular momentum: L = r × p.\n- Area of a parallelogram: |A × B|.\n- Area of a triangle: |A × B|/2.\n\nExample:\n\nA = î + 2ĵ and B = 3î + k̂.\n\nA × B = 2î − k̂ − 6ĵ.\n\nIn standard component order, A × B = 2î − 6ĵ − k̂.\n\n==================================================\n\n11. PROJECTION OF A VECTOR\n\nThe scalar projection of A onto non-zero B is:\n\nA · B̂ = A cos θ.\n\nThe vector projection of A onto B is:\n\n[(A · B)/|B|²] B.\n\nThe component perpendicular to B is:\n\nA_perp = A − A_parallel.\n\nApplications include resolving forces and finding parallel/perpendicular components.\n\n==================================================\n\n12. EQUILIBRIUM OF CONCURRENT FORCES\n\nFor a particle in equilibrium, the vector sum of all forces is zero:\n\nΣF = 0.\n\nIn two dimensions:\n\nΣFₓ = 0\n\nΣFᵧ = 0.\n\nIn three dimensions:\n\nΣFₓ = ΣFᵧ = ΣFᶻ = 0.\n\nResolve every force into components and use a consistent sign convention.\n\n==================================================\n\n13. SOLVED EXAMPLES\n\nExample 1: Magnitude\n\nA = 6î + 8ĵ.\n\n|A| = √(36 + 64) = 10.\n\nExample 2: Unit vector\n\nFor A = 6î + 8ĵ:\n\nÂ = (3/5)î + (4/5)ĵ.\n\nExample 3: Resultant of perpendicular vectors\n\nA = 5 units east, B = 12 units north.\n\nR = √(25 + 144) = 13 units.\n\nDirection from east:\n\ntan θ = 12/5.\n\nExample 4: Dot product\n\nA = 2î + ĵ, B = î + 3ĵ.\n\nA · B = 2(1) + 1(3) = 5.\n\nExample 5: Cross product\n\nA = î, B = ĵ.\n\nA × B = k̂.\n\nExample 6: Displacement\n\nInitial position (2,1), final position (5,5).\n\nΔr = 3î + 4ĵ.\n\nMagnitude = 5 units.\n\nExample 7: Angle between vectors\n\nA = î + ĵ, B = î − ĵ.\n\nA · B = 1 − 1 = 0.\n\nThe vectors are perpendicular.\n\n==================================================\n\n14. JEE ADVANCED CONCEPTS AND COMMON TRAPS\n\n1. A · B = 0 means vectors are perpendicular only when both vectors are non-zero. A zero vector has zero dot product with every vector.\n2. A × B = 0 means vectors are parallel or one vector is zero.\n3. Equal magnitudes do not imply equal vectors; directions must also match.\n4. Vector addition is commutative and associative. Cross product is not commutative.\n5. Dot product gives a scalar; cross product gives a vector.\n6. The magnitude of A + B is not generally A + B. Equality holds when the vectors point in the same direction.\n7. For a triangle with sides represented by vectors A and B from the same starting point, the included angle matters when calculating the resultant.\n8. Components are signed quantities. Never discard negative signs before summing components.\n9. The angle calculated from tan θ = Rᵧ/Rₓ must be placed in the correct quadrant.\n10. The dot product can be negative when the angle between vectors is obtuse.\n11. Cross-product direction depends on the order of the vectors.\n12. The scalar projection can be negative, whereas the magnitude of a projection is non-negative.\n\n==================================================\n\n15. QUICK REVISION SHEET\n\nA = Aₓî + Aᵧĵ + Aᶻk̂\n\n|A| = √(Aₓ² + Aᵧ² + Aᶻ²)\n\nÂ = A/|A|\n\nAₓ = A cos θ\n\nAᵧ = A sin θ\n\n|A + B| = √(A² + B² + 2AB cos θ)\n\nA · B = AB cos θ\n\nA · B = AₓBₓ + AᵧBᵧ + AᶻBᶻ\n\n|A × B| = AB sin θ\n\nA × B =\n\n(AᵧBᶻ − AᶻBᵧ)î\n\n- (AᶻBₓ − AₓBᶻ)ĵ\n- (AₓBᵧ − AᵧBₓ)k̂\n\nDisplacement: Δr = r₂ − r₁\n\nEquilibrium: ΣF = 0\n\nWork: W = F · s\n\nTorque: τ = r × F",
      formulas: "VECTOR FORMULA SHEET\n\nA = Aₓî + Aᵧĵ + Aᶻk̂\n\n|A| = √(Aₓ² + Aᵧ² + Aᶻ²)\n\nÂ = A/|A|\n\nAₓ = A cos θ\n\nAᵧ = A sin θ\n\n|A + B| = √(A² + B² + 2AB cos θ)\n\nA · B = AB cos θ\n\nA · B = AₓBₓ + AᵧBᵧ + AᶻBᶻ\n\n|A × B| = AB sin θ\n\nA × B =\n\n(AᵧBᶻ − AᶻBᵧ)î\n\n- (AᶻBₓ − AₓBᶻ)ĵ\n- (AₓBᵧ − AᵧBₓ)k̂\n\nDisplacement: Δr = r₂ − r₁\n\nEquilibrium: ΣF = 0\n\nWork: W = F · s\n\nTorque: τ = r × F"
    },

    {
      name: "Motion in a Straight Line",
      chapterId: "physics-motion-straight-line",
      notes: "CHAPTER 3: MOTION IN A STRAIGHT LINE\n\n1. FRAME OF REFERENCE AND POSITION\n\nMotion describes a change in position with time relative to a chosen frame of reference.\n\nA particle model treats an object as a point when its dimensions are unimportant for the problem.\n\nChoose an origin and a positive direction along the straight line. The position coordinate x may be positive, negative, or zero.\n\nDisplacement:\n\n$\\Delta x=x_2-x_1$\n\nDisplacement depends only on initial and final positions.\n\nDistance is the total length of the path travelled. It is non-negative and is always greater than or equal to the magnitude of displacement.\n\nExample: A particle moves from x = 2 m to x = 8 m, then returns to x = 5 m.\n\nDistance = 6 + 3 = 9 m.\n\nDisplacement = 5 - 2 = +3 m.\n\nAverage speed = total distance / total time.\n\nAverage velocity = total displacement / total time.\n\n2. AVERAGE AND INSTANTANEOUS VELOCITY\n\nAverage velocity over a time interval:\n\n$v_{avg}=\\frac{\\Delta x}{\\Delta t}$\n\nAverage speed:\n\n$speed_{avg}=\\frac{total\\ distance}{total\\ time}$\n\nInstantaneous velocity is the limiting value of average velocity as the time interval approaches zero:\n\n$v=\\frac{dx}{dt}$\n\nInstantaneous speed is the magnitude of instantaneous velocity:\n\n$speed=|v|$\n\nVelocity is positive when position increases with time and negative when position decreases with time, according to the chosen positive direction. Speed is never negative.\n\n3. ACCELERATION\n\nAverage acceleration:\n\n$a_{avg}=\\frac{\\Delta v}{\\Delta t}$\n\nInstantaneous acceleration:\n\n$a=\\frac{dv}{dt}=\\frac{d^2x}{dt^2}$\n\nAcceleration describes how velocity changes with time. It may be positive, negative, or zero.\n\nPositive acceleration does not always mean an object is speeding up. An object speeds up when velocity and acceleration have the same sign, and slows down when they have opposite signs.\n\n4. UNIFORM MOTION\n\nUniform motion in a straight line means constant velocity.\n\nPosition equation:\n\n$x=x_0+vt$\n\nThe position-time graph is a straight line. Its slope is velocity. A horizontal position-time graph represents rest.\n\n5. CONSTANT-ACCELERATION EQUATIONS\n\nFor constant acceleration a, initial velocity u, final velocity v, elapsed time t, and displacement s:\n\n$v=u+at$\n\n$s=ut+\\frac12at^2$\n\n$v^2=u^2+2as$\n\n$s=\\frac{u+v}{2}t$\n\nThese equations apply only when acceleration is constant.\n\nThe average velocity for constant acceleration is:\n\n$v_{avg}=\\frac{u+v}{2}$\n\nThe equations use signed velocity, acceleration, and displacement. Choose a consistent positive direction.\n\n6. FREE FALL AND VERTICAL MOTION\n\nNear Earth's surface, neglecting air resistance, objects have approximately constant downward acceleration g.\n\nTake upward as positive:\n\n$a=-g$\n\nFor an object launched vertically upward with initial velocity u:\n\n$v=u-gt$\n\n$y=y_0+ut-\\frac12gt^2$\n\n$v^2=u^2-2g(y-y_0)$\n\nAt the highest point, instantaneous velocity is zero, but acceleration remains -g.\n\nTime to reach the highest point:\n\n$t_{up}=\\frac{u}{g}$\n\nMaximum rise above the launch point:\n\n$H=\\frac{u^2}{2g}$\n\nFor a return to the launch height, total flight time:\n\n$T=\\frac{2u}{g}$\n\nThese results assume negligible air resistance and the same launch and landing height.\n\n7. GRAPHS OF MOTION\n\nPosition-time graph:\n\n- Slope gives instantaneous velocity.\n- A straight-line graph has constant velocity.\n- A curved graph indicates changing velocity.\n\nVelocity-time graph:\n\n- Slope gives acceleration.\n- Signed area under the graph gives displacement.\n- Area calculated using speed gives distance only when direction changes are handled correctly.\n\nAcceleration-time graph:\n\n- Signed area gives change in velocity.\n\nImportant distinction: A negative velocity-time graph area represents negative displacement, not negative distance.\n\n8. RELATIVE VELOCITY IN ONE DIMENSION\n\nVelocity of A relative to B:\n\n$v_{AB}=v_A-v_B$\n\nIf both move in the same direction, relative speed is the magnitude of their velocity difference.\n\nIf they move in opposite directions, relative speed is the magnitude of their velocity sum, with signs assigned consistently.\n\nFor separation d:\n\n- If they approach each other at relative speed v_rel, meeting time = d/v_rel.\n- If they move apart at relative speed v_rel, separation increases at that rate.\n\n9. NON-UNIFORM ACCELERATION\n\nWhen velocity depends on time, acceleration is:\n\n$a(t)=\\frac{dv}{dt}$\n\nDisplacement between times t1 and t2:\n\n$\\Delta x=\\int_{t_1}^{t_2}v(t)\\,dt$\n\nChange in velocity:\n\n$\\Delta v=\\int_{t_1}^{t_2}a(t)\\,dt$\n\nIf acceleration depends on position:\n\n$a=\\frac{dv}{dt}=\\frac{dv}{dx}\\frac{dx}{dt}=v\\frac{dv}{dx}$\n\nThus:\n\n$a=v\\frac{dv}{dx}$\n\nThis relation is useful when acceleration is specified as a function of position rather than time.\n\n10. SOLVED EXAMPLES\n\nExample 1: Distance and displacement\n\nA person moves 10 m east and then 4 m west.\n\nDistance = 10 + 4 = 14 m.\n\nTaking east as positive:\n\nDisplacement = +10 - 4 = +6 m.\n\nExample 2: Constant acceleration\n\nA car starts with u = 5 m/s and accelerates at 2 m/s^2 for 4 s.\n\n$v=u+at=5+2(4)=13\\ m\\,s^{-1}$\n\n$s=ut+\\frac12at^2=5(4)+\\frac12(2)(16)=36\\ m$\n\nExample 3: Object released from rest\n\nAn object falls from rest for 3 s. Take g = 9.8 m/s^2.\n\nDistance fallen = 1/2 gt^2 = 1/2(9.8)(9) = 44.1 m.\n\nSpeed after 3 s = gt = 29.4 m/s downward.\n\nExample 4: Average speed for equal distances\n\nA vehicle travels equal distances at speeds v1 and v2.\n\nLet each distance be d.\n\nTotal distance = 2d.\n\nTotal time = d/v1 + d/v2.\n\nTherefore:\n\n$v_{avg}=\\frac{2v_1v_2}{v_1+v_2}$\n\nFor speeds 20 m/s and 30 m/s:\n\n$v_{avg}=\\frac{2(20)(30)}{20+30}=24\\ m\\,s^{-1}$\n\nExample 5: Velocity-time graph\n\nVelocity increases linearly from 0 to 12 m/s over 4 s.\n\nAcceleration = slope = 12/4 = 3 m/s^2.\n\nDisplacement = area under the graph = 1/2(4)(12) = 24 m.\n\nExample 6: Relative motion\n\nTwo cars travel in the same direction at 25 m/s and 17 m/s.\n\nRelative velocity of the faster car with respect to the slower car = 25 - 17 = 8 m/s.\n\nIf the gap is 120 m and speeds remain constant, catching time = 120/8 = 15 s.\n\n11. JEE ADVANCED CONCEPTS\n\n1. Average speed is not generally the arithmetic mean of initial and final speeds. The arithmetic mean of velocities gives average velocity only for constant acceleration over the interval.\n2. A particle can have zero displacement but non-zero distance.\n3. A particle can have zero instantaneous velocity while acceleration is non-zero, as at the highest point of vertical motion.\n4. Negative acceleration does not necessarily mean slowing down; compare signs of velocity and acceleration.\n5. In a velocity-time graph, signed area gives displacement. To find distance, add the absolute areas of intervals with constant direction separately.\n6. The slope of a position-time graph is velocity, not speed. Speed is the magnitude of the slope.\n7. The equations of constant-acceleration motion must not be applied when acceleration varies with time or position without justification.\n8. At the turning point of one-dimensional motion, velocity changes sign. Acceleration need not be zero.\n9. Two particles meet when their positions are equal at the same time, not merely when their distances travelled are equal.\n10. Relative velocity must use a consistent sign convention.\n\n12. QUICK REVISION SHEET\n\nDisplacement: $\\Delta x=x_2-x_1$\n\nAverage velocity: $v_{avg}=\\frac{\\Delta x}{\\Delta t}$\n\nAverage speed = total distance / total time\n\nInstantaneous velocity: $v=\\frac{dx}{dt}$\n\nAcceleration: $a=\\frac{dv}{dt}=\\frac{d^2x}{dt^2}$\n\nConstant acceleration:\n\n$v=u+at$\n\n$s=ut+\\frac12at^2$\n\n$v^2=u^2+2as$\n\n$s=\\frac{u+v}{2}t$\n\nGraph rules:\n\n| Quantity graph | Slope | Signed area |\n| x-t | velocity | Not used |\n| v-t | acceleration | displacement |\n| a-t | jerk | change in velocity |\n\nVertical launch upward:\n\n$t_{up}=\\frac{u}{g}$\n\n$H=\\frac{u^2}{2g}$\n\n$T=\\frac{2u}{g}$ for return to launch height.\n\nRelative velocity: $v_{AB}=v_A-v_B$\n\nVariable acceleration: $a=v\\frac{dv}{dx}$\n\n13. CHAPTER INTEGRATION CHECKLIST\n\n- Formulas and units checked.\n- Worked-example arithmetic checked.\n- Equations prepared for KaTeX rendering.\n- Chapter available in Library navigation and search.\n- Existing Library progress and feature data remain unchanged.",
      topics: [
        "Frame of reference",
        "Displacement and velocity",
        "Acceleration",
        "Constant acceleration",
        "Free fall",
        "Motion graphs",
        "Relative velocity",
        "Variable acceleration"
      ],
      formulas: "Displacement: Δx = x₂ - x₁; Average velocity: v_avg = Δx/Δt; Instantaneous velocity: v = dx/dt; Acceleration: a = dv/dt = d²x/dt²; v = u + at; s = ut + ½at²; v² = u² + 2as; s = (u + v)t/2; Free fall upward positive: a = -g; t_up = u/g; H = u²/(2g); T = 2u/g; Relative velocity: v_AB = v_A - v_B; Variable acceleration: a = v dv/dx"
    },
    {
      name: "Motion in a Plane",
      chapterId: "physics-motion-plane-projectile",
      notes: `CHAPTER 4: MOTION IN A PLANE AND PROJECTILE MOTION

1. Learning objectives

By the end of this chapter, a beginner should be able to:

- Describe motion in two dimensions using vectors.
- Resolve vectors into horizontal and vertical components.
- Calculate position, displacement, velocity, and acceleration in component form.
- Understand the assumptions and equations of projectile motion.
- Derive time of flight, maximum height, range, and trajectory.
- Solve horizontal-projection and different-height problems.
- Identify common JEE Main and JEE Advanced traps.

2. Motion in two dimensions

An object moves in a plane when its position changes along two perpendicular directions.

Its position vector is:

$\\vec r=x\\hat i+y\\hat j$

Here, $x$ and $y$ are coordinates, while $\hat i$ and $\hat j$ are unit vectors along the positive x- and y-axes.

Displacement

If the initial position is $(x_1,y_1)$ and the final position is $(x_2,y_2)$:

$\Delta\vec r=(x_2-x_1)\hat i+(y_2-y_1)\hat j$

$|\Delta\vec r|=\sqrt{(x_2-x_1)^2+(y_2-y_1)^2}$

Displacement depends only on the initial and final positions. Distance depends on the complete path followed.

Velocity

$\vec v_{avg}=\frac{\Delta\vec r}{\Delta t}
=\frac{\Delta x}{\Delta t}\hat i+\frac{\Delta y}{\Delta t}\hat j$

Instantaneous velocity is:

$\vec v=\frac{d\vec r}{dt}=v_x\hat i+v_y\hat j$

$v_x=\frac{dx}{dt},\qquad v_y=\frac{dy}{dt}$

Speed is the magnitude of velocity:

$v=\sqrt{v_x^2+v_y^2}$

Speed is a scalar; velocity is a vector.

Acceleration

$\vec a_{avg}=\frac{\Delta\vec v}{\Delta t}$

$\vec a=\frac{d\vec v}{dt}=a_x\hat i+a_y\hat j$

$a_x=\frac{dv_x}{dt},\qquad a_y=\frac{dv_y}{dt}$

$a=\sqrt{a_x^2+a_y^2}$

Acceleration can change the magnitude of velocity, its direction, or both.

3. Resolving vectors into components

For a vector $\vec A$ of magnitude $A$ making angle $\theta$ with the positive x-axis:

$A_x=A\cos\theta,\qquad A_y=A\sin\theta$

$A=\sqrt{A_x^2+A_y^2}$

$\tan\theta=A_y/A_x$

The signs of the components depend on the quadrant. The magnitude formulas do not determine signs automatically.

Quadrant signs

| Quadrant | $A_x$ | $A_y$ |
| I | positive | positive |
| II | negative | positive |
| III | negative | negative |
| IV | positive | negative |

Worked example

A vector of magnitude 10 units makes an angle of 30 degrees above the positive x-axis.

$A_x=10\cos30^\circ=5\sqrt3,\qquad A_y=10\sin30^\circ=5$

$\vec A=5\sqrt3\hat i+5\hat j$

Its magnitude is $\sqrt{75+25}=10$ units.

4. Independence of perpendicular motions

In ideal projectile motion near Earth's surface, horizontal and vertical motions are independent in effect while sharing the same time variable.

With air resistance neglected:

- Horizontal acceleration: $a_x=0$
- Vertical acceleration: $a_y=-g$, when upward is positive
- Horizontal velocity remains constant.
- Vertical velocity changes under gravity.

The motions do not occur at different times. Both components describe the same object simultaneously.

5. Introduction to projectile motion

A projectile is an object launched with an initial velocity and then moves under gravity alone, neglecting air resistance.

Standard assumptions

- Gravitational acceleration is constant and vertically downward.
- Air resistance is neglected.
- Earth’s curvature and rotation are ignored.
- The object stays close enough to Earth that $g$ is constant.

Let the launch speed be $u$ at angle $\theta$ above the horizontal.

$u_x=u\cos\theta,\qquad u_y=u\sin\theta$

Taking the launch point as the origin and upward as positive:

$x_0=0,\qquad y_0=0,\qquad a_x=0,\qquad a_y=-g$

Horizontal motion

$x=u\cos\theta\,t,\qquad v_x=u\cos\theta$

Vertical motion

$y=u\sin\theta\,t-\frac12gt^2,\qquad v_y=u\sin\theta-gt$

6. Time of flight for same-level landing

For a projectile landing at the same vertical height from which it was launched, set $y=0$:

$0=u\sin\theta\,T-\frac12gT^2$

The solutions are $T=0$ at launch and:

$T=\frac{2u\sin\theta}{g}$

This formula applies only when launch and landing heights are equal.

7. Maximum height

At the highest point, the vertical velocity is zero. The horizontal velocity is generally not zero.

Using $v_y^2=u_y^2+2a_y y$ at $v_y=0$:

$0=u^2\sin^2\theta-2gH$

$H=\frac{u^2\sin^2\theta}{2g}$

Maximum height is measured vertically above the launch point.

At the highest point, $v_y=0$ and $v_x=u\cos\theta$. Therefore the speed is $u|\cos\theta|$.

The time to the highest point is:

$t_{up}=\frac{u\sin\theta}{g}$

8. Horizontal range for same-level landing

$R=u\cos\theta\times T
=u\cos\theta\left(\frac{2u\sin\theta}{g}\right)
=\frac{u^2\sin2\theta}{g}$

For fixed $u$ and $g$, the range is maximum when $\sin2\theta=1$, giving $\theta=45^\circ$:

$R_{max}=\frac{u^2}{g}$

Complementary angles $\theta$ and $90^\circ-\theta$ give equal range under equal-height and no-air-resistance conditions. They generally have different flight times and maximum heights.

At $\theta=0^\circ$, the same-level ideal formula gives zero range because the projectile is launched directly toward the landing level with zero upward flight time.

9. Equation of trajectory

From $x=u\cos\theta\,t$:

$t=\frac{x}{u\cos\theta},\qquad \cos\theta\ne0$

Substitution gives:

$y=x\tan\theta-\frac{gx^2}{2u^2\cos^2\theta}$

This parabola separates position from time. The first term describes the initial upward geometric slope, while the negative quadratic term is the effect of gravity.

Trajectory sketch

Launch point $(0,0)$

|         *                 * |
|       *                       * |
|      *            H            * |
|     *                          * |
|----O--------------------------R----|
O = launch, $\theta$ = launch angle, H = maximum height, R = range

10. Velocity and speed at any time

$v_x=u\cos\theta$

$v_y=u\sin\theta-gt$

$\vec v=(u\cos\theta)\hat i+(u\sin\theta-gt)\hat j$

$v=\sqrt{(u\cos\theta)^2+(u\sin\theta-gt)^2}$

Direction relative to the horizontal:

$\tan\phi=\frac{v_y}{v_x}$

Use the signs of $v_x$ and $v_y$ to choose the correct quadrant. At equal heights on ascending and descending parts, $v_y$ has equal magnitude and opposite sign.

11. Horizontal projection from a height

For projection horizontally at speed $u$ from height $h$:

$u_y=0,\qquad x=ut,\qquad y=-\frac12gt^2$

At ground level $y=-h$:

$-h=-\frac12gT^2$

$T=\sqrt{\frac{2h}{g}},\qquad R=u\sqrt{\frac{2h}{g}}$

Vertical impact speed:

$|v_y|=gT=\sqrt{2gh}$

Resultant impact speed:

$v=\sqrt{u^2+2gh}$

For fixed height, flight time is independent of horizontal projection speed in ideal motion.

12. Projectile landing at a different height

If the landing point is vertically below the launch point by height $h$, put $y=-h$:

$-h=u\sin\theta\,t-\frac12gt^2$

$\frac12gt^2-u\sin\theta\,t-h=0$

The physically meaningful positive solution is:

$t=\frac{u\sin\theta+\sqrt{u^2\sin^2\theta+2gh}}{g}$

$x=u\cos\theta\,t$

The negative root does not represent a future landing time for this setup.

Do not reuse same-level formulas without checking the launch and landing heights.

13. Worked examples

Example 1: Basic projectile

A ball is projected at 20 m/s at 30 degrees above the horizontal. Take $g=10\ m\,s^{-2}$ and equal launch and landing heights.

$u_x=20\cos30^\circ=10\sqrt3\ m\,s^{-1}$

$u_y=20\sin30^\circ=10\ m\,s^{-1}$

$T=\frac{2u_y}{g}=2\ s$

$H=\frac{u_y^2}{2g}=5\ m$

$R=u_xT=20\sqrt3\approx34.64\ m$

Example 2: Time to maximum height

A projectile is launched at 25 m/s at 53 degrees, with $\sin53^\circ\approx0.8$ and $g=10\ m\,s^{-2}$.

$u_y=25(0.8)=20\ m\,s^{-1}$

$t_{up}=20/10=2\ s$

$H=20^2/(2(10))=20\ m$

Example 3: Horizontal projection

An object is projected horizontally at 15 m/s from 20 m height with $g=10\ m\,s^{-2}$.

$T=\sqrt{2(20)/10}=2\ s$

$R=15(2)=30\ m$

$|v_y|=10(2)=20\ m\,s^{-1}$

$v=\sqrt{15^2+20^2}=25\ m\,s^{-1}$

Example 4: Complementary angles

Projectiles launched at 30 degrees and 60 degrees with the same speed from the same point and landing at the same height have equal ranges:

$\sin60^\circ=\sin120^\circ,\qquad \sin120^\circ=\sin(2(60^\circ))$

Thus both use complementary launch angles and satisfy $R(30^\circ)=R(60^\circ)$. The 60-degree projectile has greater maximum height and longer flight time.

Example 5: Position after one second

A projectile is launched at 20 m/s at 30 degrees. Take $g=10\ m\,s^{-2}$.

$u_x=10\sqrt3\ m\,s^{-1},\qquad u_y=10\ m\,s^{-1}$

At $t=1\ s$:

$x=10\sqrt3\ m$

$y=10(1)-5(1)^2=5\ m$

$v_x=10\sqrt3\ m\,s^{-1}$

$v_y=10-10(1)=0\ m\,s^{-1}$

This is exactly the highest point for these numerical values.

Example 6: Different landing height

A projectile launches 5 m above level ground with $u_x=8\ m\,s^{-1}$ and $u_y=6\ m\,s^{-1}$; $g=10\ m\,s^{-2}$.

$-5=6t-5t^2$

$5t^2-6t-5=0$

$t=\frac{6+\sqrt{36+100}}{10}
=\frac{3+\sqrt34}{5}\approx\frac{3+5.83095}{5}=1.766\ s$

$x=8t=\frac{8(3+\sqrt34)}{5}\approx14.13\ m$

14. JEE-level practice

Question 1

Why is horizontal velocity constant in ideal projectile motion?

Answer: Horizontal acceleration is zero because gravity is vertical and air resistance is neglected.

Question 2

Is acceleration zero at the highest point?

Answer: No. Vertical velocity is zero, but acceleration is still $-g$ when upward is positive.

Question 3

Why is velocity not generally zero at the highest point?

Answer: Only $v_y$ is zero. The horizontal component $v_x=u\cos\theta$ is usually non-zero.

Question 4

How does range vary with launch angle at fixed speed?

Answer: For same-level landing, $R=u^2\sin2\theta/g$, so it is maximum at 45 degrees and symmetric for complementary angles.

Question 5

Which quantities are independent of horizontal speed in horizontal projection from fixed height?

Answer: Flight time and vertical impact speed are independent of horizontal speed.

Question 6

An object is launched at 20 m/s at 30 degrees. What are its velocity components after 1 s with $g=10\ m\,s^{-2}$?

Answer: $v_x=10\sqrt3\ m\,s^{-1}$ and $v_y=10-10=0\ m\,s^{-1}$.

Question 7

Does equal range imply equal flight time?

Answer: No. Complementary angles can have equal range but different times of flight and maximum heights.

Question 8

A projectile is at the top of its trajectory. What is its acceleration?

Answer: $a=g$ downward, with vector components $(0,-g)$ if upward is positive.

Numerical question 9

What is the range of a projectile launched at 10 m/s at 45 degrees with $g=10\ m\,s^{-2}$, if launch and landing heights are equal?

Answer: $R=u^2/g=100/10=10\ m$.

Numerical question 10

A projectile is thrown horizontally at 8 m/s from height 10 m with $g=10\ m\,s^{-2}$. Find its horizontal range.

Answer: $T=\sqrt{20/10}=\sqrt2\ s$, so $R=8\sqrt2\approx11.31\ m$.

15. Common mistakes and JEE traps

- Assuming acceleration is zero at the highest point: acceleration remains vertically downward with magnitude $g$.
- Assuming the whole velocity is zero at the highest point: only its vertical component is zero.
- Confusing speed with a velocity component.
- Using degrees and radians inconsistently in calculations and calculator settings.
- Forgetting the sign of vertical displacement when upward is positive.
- Blindly using $T=2u\sin\theta/g$ when heights differ.
- Blindly using $R=u^2\sin2\theta/g$ without checking equal-height assumptions.
- Forgetting that horizontal and vertical motion share the same time.
- Assuming equal ranges imply equal flight times or heights.
- Treating vector component magnitudes as signed components without considering quadrant.
- Rounding intermediate values too early.
- Omitting units from numerical answers.

16. Formula revision sheet

Vector components

$A_x=A\cos\theta$

$A_y=A\sin\theta$

$A=\sqrt{A_x^2+A_y^2}$

Projectile motion

$u_x=u\cos\theta,\qquad u_y=u\sin\theta$

$x=u\cos\theta\,t$

$y=u\sin\theta\,t-\frac12gt^2$

$v_x=u\cos\theta,\qquad v_y=u\sin\theta-gt$

$v=\sqrt{v_x^2+v_y^2}$

Same-level landing

$T=\frac{2u\sin\theta}{g}$

$H=\frac{u^2\sin^2\theta}{2g}$

$R=\frac{u^2\sin2\theta}{g}$

$R_{max}=\frac{u^2}{g}$ at $\theta=45^\circ$

$y=x\tan\theta-\frac{gx^2}{2u^2\cos^2\theta}$

Horizontal projection from height $h$

$T=\sqrt{\frac{2h}{g}}$

$R=u\sqrt{\frac{2h}{g}}$

$|v_y|_{impact}=\sqrt{2gh}$

$v_{impact}=\sqrt{u^2+2gh}$

Important note: A formula is valid only when its stated assumptions are satisfied.

17. Chapter completion checklist

Use this checklist while studying:

- Can I resolve a vector and interpret quadrant signs?
- Can I calculate position, velocity, and acceleration components?
- Do I know why perpendicular components are independent?
- Can I derive time of flight, maximum height, range, and trajectory?
- Can I distinguish same-level from different-height problems?
- Can I solve horizontal projection without mixing $x$ and $y$ formulas?
- Can I identify the common traps listed above?`,
      topics: [
        "Motion in two dimensions",
        "Vector resolution",
        "Projectile motion",
        "Trajectory and range",
        "Horizontal projection",
        "Relative height problems"
      ],
      formulas: "Vector components: A_x = A cos θ; A_y = A sin θ; A = √(A_x² + A_y²); Projectile: u_x = u cos θ; u_y = u sin θ; x = u cos θ t; y = u sin θ t − ½gt²; v_x = u cos θ; v_y = u sin θ − gt; Same-level landing: T = 2u sin θ/g; H = u² sin² θ/(2g); R = u² sin 2θ/g; R_max = u²/g at 45°; Trajectory: y = x tan θ − gx²/(2u² cos² θ); Horizontal projection from height h: T = √(2h/g); R = u√(2h/g); |v_y| = √(2gh); impact speed = √(u² + 2gh)"
    },
    {
      name: "Laws of Motion",
      notes: "Practise Newton's laws, free-body diagrams and friction.",
      formulas: "F = ma; f ≤ μsN"
    },
    {
      name: "Work, Energy and Power",
      notes: "Understand work, kinetic energy, potential energy and conservation of energy.",
      formulas: "W = Fs cos θ; K = ½mv²; P = W/t"
    }
  ],
  Chemistry: [
    {
      name: "Some Basic Concepts of Chemistry",
      notes: "Revise the mole concept, molar mass, stoichiometry and concentration.",
      formulas: "n = mass / molar mass"
    },
    {
      name: "Structure of Atom",
      notes: "Study atomic models, quantum numbers, orbitals and electronic configuration.",
      formulas: "Eₙ = −13.6 Z²/n² eV"
    },
    {
      name: "Classification of Elements",
      notes: "Understand periodic trends in atomic radius, ionisation energy and electronegativity.",
      formulas: "Compare trends across periods and down groups."
    },
    {
      name: "Chemical Bonding",
      notes: "Revise Lewis structures, VSEPR, hybridisation, bond polarity and hydrogen bonding.",
      formulas: "Formal charge = valence e⁻ − nonbonding e⁻ − ½(bonding e⁻)"
    },
    {
      name: "Chemical Thermodynamics",
      notes: "Learn system and surroundings, enthalpy, internal energy and Hess's law.",
      formulas: "ΔU = q + w"
    },
    {
      name: "Equilibrium",
      notes: "Study chemical equilibrium, equilibrium constants and ionic equilibrium.",
      formulas: "Kc = [products]ᵖ / [reactants]ʳ"
    }
  ],
  Maths: [
    {
      name: "Sets",
      notes: "Study set notation, subsets, intervals, union and intersection.",
      formulas: "n(A ∪ B) = n(A) + n(B) − n(A ∩ B)"
    },
    {
      name: "Trigonometric Functions",
      notes: "Revise identities, radians, graphs and trigonometric equations.",
      formulas: "sin²x + cos²x = 1"
    },
    {
      name: "Quadratic Equations",
      notes: "Practise roots, discriminants, relations between roots and inequalities.",
      formulas: "x = (−b ± √(b² − 4ac)) / 2a"
    },
    {
      name: "Straight Lines",
      notes: "Learn slope, line equations, angle between lines and distances.",
      formulas: "y − y₁ = m(x − x₁)"
    },
    {
      name: "Permutations and Combinations",
      notes: "Practise counting principles, arrangements and selections.",
      formulas: "nCr = n! / (r!(n−r)!)"
    },
    {
      name: "Sequences and Series",
      notes: "Revise arithmetic and geometric progressions and their sums.",
      formulas: "AP: an = a + (n−1)d"
    }
  ]
};

// Merge the existing Library entries with the Class 11 syllabus inventory.
// Existing notes are never replaced or duplicated.
const LIBRARY_PROGRESS_KEY = "studyos-library-chapter-progress";

function readLibraryProgress() {
  try {
    return JSON.parse(localStorage.getItem(LIBRARY_PROGRESS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveLibraryProgress(progress) {
  try {
    localStorage.setItem(LIBRARY_PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Progress remains usable for this session if browser storage is unavailable.
  }
}

const chapterAliasGroups = [
  ["Classification of Elements", "Classification of Elements and Periodicity"],
  ["Chemical Bonding", "Chemical Bonding and Molecular Structure"],
  ["Chemical Thermodynamics", "Thermodynamics"],
  ["Kinetic Theory", "Kinetic Theory of Gases"],
  ["Relations and Functions"],
  ["Units and Measurements", "Units, Dimensions and Measurements"]
];

function chapterNamesMatch(a, b) {
  const left = a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const right = b.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (left === right) return true;
  return chapterAliasGroups.some((group) =>
    group.some((name) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === left) &&
    group.some((name) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === right)
  );
}

function libraryChapterId(subject, chapterName, chapterId) {
  if (chapterId) return chapterId;
  return `${subject}:${chapterName}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function mergeLibraryInventory() {
  const inventory = window.StudyOSJEE11Inventory || {};
  Object.entries(inventory).forEach(([subject, entries]) => {
    if (!libraryData[subject]) return;
    entries.forEach((entry) => {
      const existing = libraryData[subject].find((chapter) =>
        chapterNamesMatch(chapter.name, entry.name)
      );
      if (existing) {
        existing.syllabusScope = entry.scope;
        existing.topics = entry.topics;
        existing.contentStatus = existing.notes && existing.notes.trim()
          ? "written"
          : "not-yet-written";
      } else {
        libraryData[subject].push({
          name: entry.name,
          notes: "",
          formulas: "",
          topics: entry.topics,
          syllabusScope: entry.scope,
          contentStatus: entry.scope === "out-of-syllabus"
            ? "out-of-syllabus"
            : "not-yet-written"
        });
      }
    });
  });
}

mergeLibraryInventory();

// Import complete Physics chapter notes without replacing existing Library entries.
function mergePhysicsChapterNotes() {
  const chapterNotes = window.StudyOSPhysicsChapterNotes || [];
  chapterNotes.forEach((entry) => {
    const existing = libraryData.Physics?.find((chapter) =>
      libraryChapterId("Physics", chapter.name, chapter.chapterId) === entry.chapterId ||
      chapterNamesMatch(chapter.name, entry.name)
    );

    if (existing) {
      existing.chapterId = entry.chapterId;
      existing.notes = entry.notes;
      existing.formulas = entry.formulas;
      existing.topics = entry.topics;
      existing.syllabusScope = "included";
      existing.contentStatus = "written";
    } else {
      libraryData.Physics.push({
        name: entry.name,
        chapterId: entry.chapterId,
        notes: entry.notes,
        formulas: entry.formulas,
        topics: entry.topics,
        syllabusScope: "included",
        contentStatus: "written"
      });
    }
  });

  libraryData.Physics = libraryData.Physics.filter((chapter) =>
    chapter.name !== "System of Particles and Rotational Motion"
  );

  const physicsOrder = [
    "Units, Dimensions and Measurements",
    "Vectors",
    "Motion in a Straight Line",
    "Motion in a Plane",
    "Laws of Motion",
    "Work, Energy and Power",
    "Centre of Mass and System of Particles",
    "Rotational Motion",
    "System of Particles and Rotational Motion",
    "Gravitation",
    "Mechanical Properties of Solids",
    "Mechanical Properties of Fluids",
    "Thermal Properties of Matter",
    "Thermodynamics",
    "Kinetic Theory",
    "Oscillations",
    "Waves"
  ];

  libraryData.Physics.sort((left, right) => {
    const indexOfLeft = physicsOrder.findIndex((name) => chapterNamesMatch(left.name, name));
    const indexOfRight = physicsOrder.findIndex((name) => chapterNamesMatch(right.name, name));
    const safeLeft = indexOfLeft === -1 ? physicsOrder.length : indexOfLeft;
    const safeRight = indexOfRight === -1 ? physicsOrder.length : indexOfRight;
    return safeLeft - safeRight;
  });
}

mergePhysicsChapterNotes();

function renderChapterNotes(container, text) {
  const lines = text.split("\n");
  let paragraph = [];
  let tableRows = [];
  let bulletItems = [];
  let mathBlock = null;

  const appendBoldInlineLabel = (element, line) => {
    const labelMatch = line.match(/^((?:Definition|Law|Principle|Formula|Important|Worked example[^:]*|Common mistake[^:]*|JEE tip|JEE trap|Note|Warning))\s*:\s*(.*)$/i);
    if (!labelMatch) {
      const inlineMathPattern = /\(([^()\n]*(?:\\[A-Za-z]+|[_^])[^()\n]*)\)/g;
      let lastIndex = 0;
      let match;
      while ((match = inlineMathPattern.exec(line)) !== null) {
        if (match.index > lastIndex) {
          element.append(document.createTextNode(line.slice(lastIndex, match.index)));
        }
        element.append(document.createTextNode(`\\(${match[1]}\\)`));
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < line.length) {
        element.append(document.createTextNode(line.slice(lastIndex)));
      }
      return;
    }
    const label = document.createElement("strong");
    label.textContent = `${labelMatch[1]}:`;
    element.append(label);
    if (labelMatch[2]) element.append(document.createTextNode(` ${labelMatch[2]}`));
  };

  const flushParagraph = () => {
    if (paragraph.length === 0) return;

    const element = document.createElement("p");
    paragraph.forEach((line, index) => {
      if (index > 0) element.append(document.createElement("br"));
      appendBoldInlineLabel(element, line);
    });
    container.append(element);
    paragraph = [];
  };

  const flushBullets = () => {
    if (bulletItems.length === 0) return;
    const list = document.createElement("ul");
    list.className = "chapter-list";
    bulletItems.forEach((item) => {
      const listItem = document.createElement("li");
      appendBoldInlineLabel(listItem, item);
      list.append(listItem);
    });
    container.append(list);
    bulletItems = [];
  };

  const flushTable = () => {
    if (tableRows.length === 0) return;
    const wrapper = document.createElement("div");
    wrapper.className = "chapter-table-wrap";
    const table = document.createElement("table");
    table.className = "chapter-table";
    tableRows.forEach((cells, rowIndex) => {
      const row = document.createElement("tr");
      cells.forEach((cellText) => {
        const cell = document.createElement(rowIndex === 0 ? "th" : "td");
        cell.textContent = cellText;
        row.append(cell);
      });
      table.append(row);
    });
    wrapper.append(table);
    container.append(wrapper);
    tableRows = [];
  };

  lines.forEach((rawLine) => {
    const line = rawLine.trim();

    if (mathBlock) {
      if (line === "]" || line === "\\]") {
        const formula = document.createElement("p");
        formula.className = "chapter-formula";
        formula.textContent = `\\[${mathBlock.join("\n").trim()}\\]`;
        container.append(formula);
        mathBlock = null;
      } else {
        mathBlock.push(line);
      }
      return;
    }

    if (line === "[" || line === "\\[") {
      flushParagraph();
      flushBullets();
      flushTable();
      mathBlock = [];
      return;
    }

    if (!line) {
      flushParagraph();
      flushBullets();
      return;
    }

    if (/^={5,}$/.test(line)) {
      flushParagraph();
      flushBullets();
      flushTable();
      return;
    }

    if (line.startsWith("|")) {
      flushParagraph();
      flushBullets();
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      const isSeparator = cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
      if (cells.length && !isSeparator) tableRows.push(cells);
      return;
    }

    flushTable();

    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      bulletItems.push(line.replace(/^[-*]\s+/, ""));
      return;
    }

    if (/^SECTION\s+|^CHAPTER\s+\d+\s*:/.test(line)) {
      flushParagraph();
      flushBullets();
      const heading = document.createElement("h2");
      heading.textContent = line;
      container.append(heading);
      return;
    }

    if (/^JEE SHORT NOTES/.test(line) ||
        /^\d+\.\s/.test(line) ||
        /^(Worked example|Solved example|Solved problem|Case [A-Z]|Common mistakes|JEE (?:tip|trap|warning))/i.test(line)) {
      flushParagraph();
      flushBullets();
      const heading = document.createElement("h3");
      heading.textContent = line;
      container.append(heading);
      return;
    }

    if (/^(Definition|State the law|Law|Principle|Important|Formula|Note|Warning)\b/i.test(line) &&
        /^.{1,90}$/.test(line)) {
      flushParagraph();
      flushBullets();
      const heading = document.createElement("h4");
      heading.textContent = line.replace(/:$/, "");
      container.append(heading);
      return;
    }

    const standaloneMath = /^\$\$[\s\S]+\$\$$/.test(line) ||
      /^\$[^$]+\$$/.test(line) ||
      /^\\?\[[\s\S]+\\?\]$/.test(line) ||
      /^\\\([\s\S]+\\\)$/.test(line);
    const isFormula = standaloneMath ||
      /^[^:]*\b(?:=|≤|≥|≈|\+|−)[^.:]*$/.test(line) ||
      /^(?:\[[MLITNΘJ]+(?:[MLITNΘJ0±±²³⁻¹₂₃⁻⁴]*[^\]]*)\]|(?:[FvGNTaHzR]\b)|(?:i|j|k)[×·])/i.test(line) ||
      /(?:sqrt|\\(?:frac|sqrt|sum|int|alpha|omega|lambda|Delta|gamma)\b)/i.test(line);

    if (isFormula) {
      flushParagraph();
      flushBullets();
      const formula = document.createElement("p");
      formula.className = "chapter-formula";
      const bracketMath = line.match(/^\\?\[([\s\S]+)\\?\]$/);
      if (bracketMath) {
        formula.textContent = `\\[${bracketMath[1].trim()}\\]`;
      } else if (standaloneMath) {
        formula.textContent = line;
      } else {
        formula.textContent = `$$${line}$$`;
      }
      container.append(formula);
    } else {
      paragraph.push(line);
    }
  });

  if (mathBlock && mathBlock.length) {
    const formula = document.createElement("p");
    formula.className = "chapter-formula";
    formula.textContent = `\\[${mathBlock.join("\n").trim()}\\]`;
    container.append(formula);
  }
  flushTable();
  flushBullets();
  flushParagraph();
}

function renderFormulaSheet(container, text) {
  const lines = text.split("\n");

  lines.forEach((rawLine, lineIndex) => {
    const line = rawLine.trim();

    if (!line) return;

    if (lineIndex === 0 && (/^[A-Z][A-Z\s]+(?:SHEET)?$/.test(line) ||
        /FORMULA SHEET$/i.test(line))) {
      const heading = document.createElement("h4");
      heading.className = "formula-sheet-heading";
      heading.textContent = line;
      container.append(heading);
      return;
    }

    const formulaParts = line.includes(";")
      ? line.split(";").map((part) => part.trim()).filter(Boolean)
      : [line];

    formulaParts.forEach((formulaPart) => {
      const row = document.createElement("div");
      row.className = "formula-row";

      const separatorIndex = formulaPart.indexOf(":");
      if (separatorIndex > 0) {
        const label = document.createElement("span");
        label.className = "formula-label";
        label.textContent = formulaPart.slice(0, separatorIndex + 1);

        const expression = document.createElement("span");
        expression.className = "formula-expression";
        expression.textContent = formulaPart.slice(separatorIndex + 1).trim();

        row.append(label, expression);
      } else {
        const expression = document.createElement("span");
        expression.className = "formula-expression";
        expression.textContent = formulaPart;
        row.append(expression);
      }

      container.append(row);
    });
  });
}

function renderLibraryChapterCards(output, subject, chapters) {
  const progress = readLibraryProgress();

  chapters.forEach((chapter, index) => {
    const card = document.createElement("article");
    card.className = "panel library-chapter-card";

    const headingRow = document.createElement("div");
    headingRow.className = "library-chapter-heading";

    const title = document.createElement("h3");
    const titleButton = document.createElement("button");
    titleButton.type = "button";
    titleButton.className = "library-chapter-title";
    titleButton.textContent = `${subject} · ${index + 1}. ${chapter.name}`;
    titleButton.setAttribute("aria-expanded", "false");
    title.append(titleButton);
    headingRow.append(title);

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "secondary-button library-open-chapter";
    openButton.textContent = "Open";
    openButton.setAttribute("aria-expanded", "false");

    const badges = document.createElement("div");
    badges.className = "library-badges";
    const syllabusBadge = document.createElement("span");
    syllabusBadge.className = `library-badge scope-${chapter.syllabusScope || "included"}`;
    syllabusBadge.textContent = chapter.syllabusScope === "out-of-syllabus"
      ? "Out of syllabus"
      : "Class 11 JEE";
    badges.append(syllabusBadge);
    badges.append(openButton);
    headingRow.append(badges);

    const progressRow = document.createElement("div");
    progressRow.className = "library-progress-row";
    const progressLabel = document.createElement("label");
    const progressSelect = document.createElement("select");
    progressLabel.textContent = "Chapter progress";
    ["Not started", "In progress", "Completed"].forEach((status) => {
      progressSelect.append(new Option(status, status));
    });
    const chapterId = libraryChapterId(subject, chapter.name, chapter.chapterId);
    progressSelect.value = progress[chapterId] || "Not started";
    progressSelect.addEventListener("change", () => {
      const latest = readLibraryProgress();
      latest[chapterId] = progressSelect.value;
      saveLibraryProgress(latest);
    });
    progressLabel.append(progressSelect);
    progressRow.append(progressLabel);

    if (chapter.topics?.length) {
      const topics = document.createElement("div");
      topics.className = "library-topic-list";
      chapter.topics.forEach((topic) => {
        const topicBadge = document.createElement("span");
        topicBadge.textContent = topic;
        topics.append(topicBadge);
      });
      card.append(headingRow, progressRow, topics);
    } else {
      card.append(headingRow, progressRow);
    }

    const details = document.createElement("div");
    details.className = "library-chapter-details";
    details.hidden = true;

    if (chapter.contentStatus === "written" && chapter.notes) {
      const notes = document.createElement("div");
      notes.className = "muted chapter-notes";
      renderChapterNotes(notes, chapter.notes);
      details.append(notes);

      if (chapter.formulas) {
        const formulaButton = document.createElement("button");
        formulaButton.type = "button";
        formulaButton.className = "secondary-button";
        formulaButton.textContent = "⚡ Open Formula Sheet";

        const formulaSheet = document.createElement("div");
        formulaSheet.className = "panel formula-sheet";
        formulaSheet.hidden = true;
        formulaSheet.style.marginTop = "10px";

        const sheetTitle = document.createElement("h3");
        sheetTitle.textContent = "JEE Formula Sheet";
        const sheetFormula = document.createElement("div");
        sheetFormula.className = "formula-sheet-content";
        renderFormulaSheet(sheetFormula, chapter.formulas);

        const copyButton = document.createElement("button");
        copyButton.type = "button";
        copyButton.className = "secondary-button";
        copyButton.textContent = "Copy formula";
        copyButton.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(chapter.formulas);
            copyButton.textContent = "Copied!";
          } catch {
            copyButton.textContent = "Copy unavailable";
          }
        });

        formulaSheet.append(sheetTitle, sheetFormula, copyButton);
        formulaButton.addEventListener("click", () => {
          formulaSheet.hidden = !formulaSheet.hidden;
          formulaButton.textContent = formulaSheet.hidden
            ? "⚡ Open Formula Sheet"
            : "Hide Formula Sheet";
          if (!formulaSheet.hidden) renderMathIfAvailable(formulaSheet);
        });
        details.append(formulaButton, formulaSheet);
      }
      renderMathIfAvailable(details);
    } else {
      const empty = document.createElement("div");
      empty.className = "library-empty-state";
      empty.innerHTML = chapter.syllabusScope === "out-of-syllabus"
        ? "<strong>Out of syllabus</strong><p>Listed for inventory only; no notes are scheduled here.</p>"
        : "<strong>Not yet written</strong><p>This chapter is part of the inventory. High-quality notes will be added chapter by chapter.</p>";
      details.append(empty);
    }

    const toggleChapter = () => {
      const willOpen = details.hidden;
      details.hidden = !willOpen;
      titleButton.setAttribute("aria-expanded", String(willOpen));
      openButton.setAttribute("aria-expanded", String(willOpen));
      openButton.textContent = willOpen ? "Close" : "Open";
      card.classList.toggle("chapter-open", willOpen);
    };

    titleButton.addEventListener("click", toggleChapter);
    openButton.addEventListener("click", toggleChapter);

    card.append(details);
    output.append(card);
  });
}

function filterLibraryResults() {
  const search = ($("#library-search")?.value || "").trim().toLowerCase();
  const scopeFilter = $("#library-scope")?.value || "all";
  const output = $("#subject-content");
  if (!output) return;
  output.replaceChildren();

  let count = 0;
  ["Physics", "Chemistry", "Maths"].forEach((subject) => {
    const subjectChapters = libraryData[subject].filter((chapter) => {
      const matchesScope = scopeFilter === "all"
        || (scopeFilter === "included" && chapter.syllabusScope === "included")
        || (scopeFilter === "out-of-syllabus" && chapter.syllabusScope === "out-of-syllabus")
        || (scopeFilter === "not-yet-created" && chapter.contentStatus === "not-yet-written");
      if (!matchesScope) return false;
      if (!search) return true;
      const searchable = [
        subject,
        chapter.name,
        chapter.notes || "",
        chapter.formulas || "",
        ...(chapter.topics || [])
      ].join(" ").toLowerCase();
      return searchable.includes(search);
    });
    if (!subjectChapters.length) return;
    count += subjectChapters.length;
    const heading = document.createElement("h2");
    heading.textContent = subject === "Maths" ? "Mathematics Chapters" : `${subject} Chapters`;
    output.append(heading);
    renderLibraryChapterCards(output, subject, subjectChapters);
  });

  const status = $("#library-search-status");
  if (status) {
    status.textContent = search || scopeFilter !== "all"
      ? `${count} chapter${count === 1 ? "" : "s"} matched.`
      : `${count} chapters in inventory.`;
  }
}

$$(".subject-card").forEach((button) => {
  button.addEventListener("click", () => {
    const subject = button.dataset.subject;
    const output = $("#subject-content");
    if (!output) return;

    const heading = document.createElement("h2");
    heading.textContent = subject === "Maths" ? "Mathematics Chapters" : `${subject} Chapters`;
    output.replaceChildren();
    output.append(heading);
    renderLibraryChapterCards(output, subject, libraryData[subject] || []);
    output.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

$("#library-search")?.addEventListener("input", filterLibraryResults);
$("#library-scope")?.addEventListener("change", filterLibraryResults);


// ---------- Theme preference ----------

const themeButton = $("#theme-button");

function applyStudyOSAppearance(settings) {
  const glass = settings.glass !== false;
  const intensity = Math.max(0, Math.min(100, Number(settings.intensity ?? 72)));
  const corners = ["soft", "round", "compact"].includes(settings.corners) ? settings.corners : "soft";
  const reduced = settings.reducedMotion === true;
  document.documentElement.dataset.glass = String(glass);
  document.documentElement.dataset.corners = corners;
  document.documentElement.dataset.motion = reduced ? "reduced" : "full";
  document.documentElement.style.setProperty("--glass-opacity", (0.28 + intensity * 0.0064).toFixed(2));
  document.documentElement.style.setProperty("--glass-blur", `${Math.round(8 + intensity * 0.24)}px`);
}

function loadStudyOSAppearance() {
  let settings = {};
  try {
    settings = JSON.parse(localStorage.getItem("studyos-appearance") || "{}");
  } catch {
    settings = {};
  }
  applyStudyOSAppearance(settings);

  const glassToggle = $("#glass-toggle");
  const intensityInput = $("#glass-intensity");
  const cornerInput = $("#corner-style");
  const motionInput = $("#reduced-motion");
  if (glassToggle) glassToggle.checked = settings.glass !== false;
  if (intensityInput) intensityInput.value = String(Math.max(0, Math.min(100, Number(settings.intensity ?? 72))));
  if (cornerInput) cornerInput.value = ["soft", "round", "compact"].includes(settings.corners) ? settings.corners : "soft";
  if (motionInput) motionInput.checked = settings.reducedMotion === true;

  const saveAppearance = () => {
    const next = {
      glass: glassToggle?.checked !== false,
      intensity: Number(intensityInput?.value ?? 72),
      corners: cornerInput?.value || "soft",
      reducedMotion: motionInput?.checked === true
    };
    localStorage.setItem("studyos-appearance", JSON.stringify(next));
    localStorage.setItem("studyos-glass-intensity", String(next.intensity));
    localStorage.setItem("studyos-corner-style", next.corners);
    localStorage.setItem("studyos-motion", next.reducedMotion ? "reduced" : "full");
    applyStudyOSAppearance(next);
    syncStudyOSAccount();
  };

  glassToggle?.addEventListener("change", saveAppearance);
  intensityInput?.addEventListener("input", saveAppearance);
  cornerInput?.addEventListener("change", saveAppearance);
  motionInput?.addEventListener("change", saveAppearance);
}

loadStudyOSAppearance();

themeButton?.addEventListener("click", () => {
  showScreen("settings");
});

console.log("StudyOS initialized successfully.");

/* StudyOS VECTRA Practice */
const TEST_ATTEMPTS_KEY = "studyos-test-attempts";

const testBank = [
  {
    id: "vectors-basics",
    subject: "Physics",
    chapter: "Vectors",
    difficulty: "Easy",
    title: "Vectors Fundamentals",
    description: "Original StudyOS practice on components, dot products, and cross products.",
    questions: [
      {
        prompt: "Which quantity has both magnitude and direction?",
        options: ["Mass", "Velocity", "Temperature", "Time"],
        correctIndex: 1,
        explanation: "Velocity describes both how fast an object moves and its direction. Mass, temperature, and time are scalar quantities in this context."
      },
      {
        prompt: "For two perpendicular nonzero vectors A and B, what is A dot B?",
        options: ["|A||B|", "0", "1", "−|A||B|"],
        correctIndex: 1,
        explanation: "The dot product is A·B = AB cos(theta). When theta is 90 degrees, cos(theta) = 0, so the dot product is zero."
      },
      {
        prompt: "Which expression gives the unit vector along vector A?",
        options: ["A|A|", "A/|A|", "|A|/A", "A squared"],
        correctIndex: 1,
        explanation: "A unit vector is obtained by dividing vector A by its nonzero magnitude |A|."
      },
      {
        prompt: "What is the direction of i hat cross j hat?",
        options: ["i hat", "j hat", "k hat", "Negative k hat"],
        correctIndex: 2,
        explanation: "In the standard right-handed Cartesian system, i×j = k."
      },
      {
        prompt: "A vector has components Ax = 3 and Ay = 4. What is its magnitude?",
        options: ["1", "5", "7", "12"],
        correctIndex: 1,
        explanation: "The two-dimensional magnitude is sqrt(Ax² + Ay²) = sqrt(3² + 4²) = 5."
      }
    ]
  },
  {
    id: "chemistry-basics",
    subject: "Chemistry",
    chapter: "Some Basic Concepts of Chemistry",
    difficulty: "Easy",
    title: "Chemical Concepts Basics",
    description: "Original StudyOS practice covering core equations and definitions.",
    questions: [
      {
        prompt: "Which expression gives the amount of substance from mass and molar mass?",
        options: ["n = mass × molar mass", "n = mass / molar mass", "n = molar mass / mass", "n = mass + molar mass"],
        correctIndex: 1,
        explanation: "The amount in moles is calculated as n = mass / molar mass."
      },
      {
        prompt: "The relationship ΔU = q + w uses which sign convention?",
        options: ["Work done by the system is positive", "Heat lost by the system is positive", "Work done on the system and heat added are positive", "No sign convention is needed"],
        correctIndex: 2,
        explanation: "Under the chemistry convention used here, heat added to the system and work done on the system contribute positively to internal energy."
      },
      {
        prompt: "In the ideal gas law, PV = nRT, which quantity is temperature?",
        options: ["P", "V", "n", "T"],
        correctIndex: 3,
        explanation: "In PV = nRT, T denotes absolute temperature, normally in kelvin."
      },
      {
        prompt: "Which formula represents formal charge?",
        options: ["Valence electrons + bonding electrons", "Valence − nonbonding − 1/2 bonding", "Atomic number − valence", "Nonbonding + 1/2 bonding"],
        correctIndex: 1,
        explanation: "Formal charge is calculated as valence electrons minus nonbonding electrons minus one-half of the bonding electrons."
      }
    ]
  },
  {
    id: "maths-basics",
    subject: "Mathematics",
    chapter: "Basic Mathematics",
    difficulty: "Easy",
    title: "Foundation Formula Practice",
    description: "Original StudyOS practice on quadratics, trigonometry, and straight lines.",
    questions: [
      {
        prompt: "Which identity is always true for real x?",
        options: ["sin²x + cos²x = 1", "sin²x − cos²x = 1", "sin x + cos x = 0", "sin x = cos x"],
        correctIndex: 0,
        explanation: "The Pythagorean trigonometric identity states that sin²x + cos²x = 1."
      },
      {
        prompt: "The quadratic formula gives roots of ax² + bx + c = 0 as:",
        options: ["x = (−b ± sqrt(b² − 4ac)) / 2a", "x = (b ± sqrt(b² − 4ac)) / 2a", "x = (−b ± sqrt(b² + 4ac)) / a", "x = −b / c"],
        correctIndex: 0,
        explanation: "For a nonzero a, the standard quadratic formula is x = (−b ± sqrt(b² − 4ac)) / 2a."
      },
      {
        prompt: "A line through (x1, y1) with slope m is written as:",
        options: ["y = mx + x1", "y − y1 = m(x − x1)", "x − y1 = m(y − x1)", "x + y = m"],
        correctIndex: 1,
        explanation: "The point-slope equation of a line is y − y1 = m(x − x1)."
      },
      {
        prompt: "The discriminant of ax² + bx + c = 0 is:",
        options: ["b² + 4ac", "b² − 4ac", "a² − 4bc", "b − 4ac"],
        correctIndex: 1,
        explanation: "The discriminant used to describe the nature of the roots is b² − 4ac."
      }
    ]
  }
];

const WEP_BANK_ID = "physics-wep-jee-advanced-50";
let wepBankLoadPromise = null;

const JEE_CLASS_11_CHAPTERS = {
  Physics: {
    Mechanics: [
      "Vectors",
      "Units and Measurements",
      "Motion in a Straight Line",
      "Motion in a Plane",
      "Laws of Motion",
      "Work, Energy and Power",
      "System of Particles and Rotational Motion",
      "Gravitation"
    ],
    Properties: [
      "Mechanical Properties of Solids",
      "Mechanical Properties of Fluids"
    ],
    Thermodynamics: [
      "Thermal Properties of Matter",
      "Thermodynamics",
      "Kinetic Theory"
    ],
    Waves: [
      "Oscillations",
      "Waves"
    ]
  },
  Chemistry: {
    Foundation: [
      "Some Basic Concepts of Chemistry",
      "Structure of Atom",
      "Classification of Elements and Periodicity in Properties",
      "Chemical Bonding and Molecular Structure"
    ],
    "States and Thermodynamics": [
      "States of Matter",
      "Thermodynamics",
      "Equilibrium",
      "Redox Reactions"
    ],
    "Hydrogen and s/p-block": [
      "Hydrogen",
      "The s-Block Element",
      "Some p-Block Elements",
      "Environmental Chemistry"
    ],
    Organic: [
      "Organic Chemistry: Some Basic Principles and Techniques",
      "Hydrocarbons"
    ]
  },
  Mathematics: {
    "Sets and Algebra": [
      "Sets",
      "Relations and Functions",
      "Trigonometric Functions",
      "Principle of Mathematical Induction",
      "Complex Numbers and Quadratic Equations",
      "Linear Inequalities",
      "Permutations and Combinations",
      "Binomial Theorem",
      "Sequences and Series"
    ],
    Coordinate: [
      "Straight Lines",
      "Conic Sections",
      "Introduction to Three-dimensional Geometry"
    ],
    Calculus: [
      "Limits and Derivatives"
    ],
    Statistics: [
      "Statistics",
      "Probability"
    ]
  }
};

function parseNumericalValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;

  let value = String(rawValue).trim()
    .replace(/−/g, "-")
    .replace(/\u2212/g, "-")
    .replace(/\s+/g, "");

  if (!value) return null;

  const approximateMatch = value.match(/≈(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i);
  if (approximateMatch) value = approximateMatch[1];

  const coefficientFractionSurd = value.match(/^(-?\d+(?:\.\d+)?)√(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/);
  if (coefficientFractionSurd) {
    return Number(coefficientFractionSurd[1]) *
      Math.sqrt(Number(coefficientFractionSurd[2])) /
      Number(coefficientFractionSurd[3]);
  }

  const coefficientSurd = value.match(/^(-?\d+(?:\.\d+)?)√(\d+(?:\.\d+)?)/);
  if (coefficientSurd) {
    return Number(coefficientSurd[1]) * Math.sqrt(Number(coefficientSurd[2]));
  }

  const pureSurd = value.match(/^√(\d+(?:\.\d+)?)/);
  if (pureSurd) return Math.sqrt(Number(pureSurd[1]));

  const decimalMatch = value.match(/^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i);
  if (/^(?:-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:\(|$)/i.test(value)) {
    const coefficient = Number(decimalMatch[1]);
    if (!Number.isNaN(coefficient) &&
        (/approx\.?\)/i.test(value) || decimalMatch[1].length === value.length)) {
      return coefficient;
    }
  }

  let expression = value
    .replace(/\(approx\.?\)/gi, "")
    .replace(/approx\.?/gi, "")
    .replace(/[^\d.+\-\/√()*eE]/g, "");

  expression = expression
    .replace(/(\d+(?:\.\d+)?)√(\d+(?:\.\d+)?)/g, "$1*Math.sqrt($2)")
    .replace(/√(\d+(?:\.\d+)?)/g, "Math.sqrt($1)")
    .replace(/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/g, "($1/$2)");

  if (/[{}[\];"'`]/.test(expression)) return null;
  try {
    const parsed = Function(`"use strict"; return (${expression});`)();
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function numericalAnswersMatch(answer, expected, approximate = false) {
  const actualValue = parseNumericalValue(answer);
  const expectedValue = parseNumericalValue(expected);
  if (actualValue === null || expectedValue === null) return false;

  const tolerance = approximate
    ? Math.max(0.005, Math.abs(expectedValue) * 0.01)
    : Math.max(0.000001, Math.abs(expectedValue) * 0.000001);
  return Math.abs(actualValue - expectedValue) <= tolerance;
}

function isTestAnswerCorrect(question, answer) {
  if (question.type === "numerical") {
    const approximate = /\bapprox(?:\.|\))/i.test(String(question.correctAnswer));
    return numericalAnswersMatch(answer, question.correctAnswer, approximate);
  }
  return answer === question.correctIndex;
}

async function loadWepQuestionBank() {
  if (wepBankLoadPromise) return wepBankLoadPromise;

  wepBankLoadPromise = fetch("./studyos_wep_jee_advanced_50.json", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((data) => {
      if (!data || !Array.isArray(data.questions) || data.questions.length !== 50) {
        throw new Error("WEP bank must contain exactly 50 questions.");
      }

      const ids = new Set();
      const questions = data.questions.map((question) => {
        if (!question.id || ids.has(question.id)) {
          throw new Error(`Invalid or duplicate WEP question ID: ${question.id || "(missing)"}`);
        }
        ids.add(question.id);

        return {
          id: question.id,
          type: question.type,
          prompt: question.question,
          options: Array.isArray(question.options) ? question.options : [],
          correctAnswer: question.correct_answer,
          marks: Number(question.marks ?? data.default_marking?.correct ?? 4),
          negativeMarks: Number(question.negative_marks ?? data.default_marking?.incorrect ?? 0),
          explanation: question.solution
        };
      });

      const existingIndex = testBank.findIndex((test) => test.id === WEP_BANK_ID);
      const adaptedTest = {
        id: WEP_BANK_ID,
        subject: data.subject === "Maths" ? "Mathematics" : (data.subject || "Physics"),
        title: data.chapter || "Work, Energy and Power",
        description: data.title || "Original Work, Energy and Power practice numericals.",
        chapter: data.chapter || "Work, Energy and Power",
        difficulty: "Advanced",
        questions
      };

      if (existingIndex >= 0) {
        testBank[existingIndex] = adaptedTest;
      } else {
        testBank.push(adaptedTest);
      }
    })
    .catch((error) => {
      console.error("Unable to load Work, Energy and Power question bank:", error);
    });

  return wepBankLoadPromise;
}

let testAttempts = [];
let activeTest = null;
let activeQuestionIndex = 0;
let activeAnswers = [];
let activeMarkedForReview = [];
let activeTestMode = "chapter";
let activeTestStartedAt = null;
let activeTestDeadline = null;
let activeTestTimerInterval = null;
let activeTestRemainingSeconds = 0;
let selectedTestSubject = "Physics";
let selectedTestChapter = "Work, Energy and Power";
let activeRetakeConfig = null;

try {
  const savedAttempts = localStorage.getItem(TEST_ATTEMPTS_KEY);
  testAttempts = savedAttempts ? JSON.parse(savedAttempts) : [];
  if (!Array.isArray(testAttempts)) testAttempts = [];
} catch {
  testAttempts = [];
}

function saveTestAttempts() {
  try {
    localStorage.setItem(TEST_ATTEMPTS_KEY, JSON.stringify(testAttempts));
  } catch {
    // Attempts remain available for the current session if storage is unavailable.
  }
}

$("#testlab-back")?.addEventListener("click", () => {
  showScreen("library");
});

async function renderTestLabSelection() {
  const content = $("#testlab-content");
  if (!content) return;

  content.replaceChildren();
  activeTest = null;
  activeQuestionIndex = 0;
  activeAnswers = [];
  stopTestTimer();

  const intro = document.createElement("p");
  intro.className = "muted";
  intro.textContent = "Choose an original StudyOS practice test. These sets are not official JEE papers.";

  await loadWepQuestionBank();

  const catalog = document.createElement("div");
  catalog.className = "test-catalog";

  const subjectPanel = document.createElement("section");
  subjectPanel.className = "panel";
  const subjectTitle = document.createElement("h2");
  subjectTitle.textContent = "Subject";
  const subjectSelector = document.createElement("div");
  subjectSelector.className = "test-subject-selector";

  ["Physics", "Chemistry", "Mathematics"].forEach((subject) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `secondary-button${selectedTestSubject === subject ? " selected" : ""}`;
    button.textContent = subject;
    button.setAttribute("aria-pressed", String(selectedTestSubject === subject));
    button.addEventListener("click", () => {
      selectedTestSubject = subject;
      const firstCategory = Object.keys(JEE_CLASS_11_CHAPTERS[subject])[0];
      selectedTestChapter = JEE_CLASS_11_CHAPTERS[subject][firstCategory][0];
      renderTestLabSelection();
    });
    subjectSelector.append(button);
  });
  subjectPanel.append(subjectTitle, subjectSelector);

  const chapterPanel = document.createElement("section");
  chapterPanel.className = "panel";
  const chapterTitle = document.createElement("h2");
  chapterTitle.textContent = `${selectedTestSubject} Class 11 chapters`;
  chapterPanel.append(chapterTitle);

  Object.entries(JEE_CLASS_11_CHAPTERS[selectedTestSubject]).forEach(([category, chapters]) => {
    const categoryHeading = document.createElement("h3");
    categoryHeading.textContent = category;
    chapterPanel.append(categoryHeading);

    const chapterGrid = document.createElement("div");
    chapterGrid.className = "test-chapter-grid";

    chapters.forEach((chapter) => {
      const available = testBank.filter((test) =>
        normalizeTestSubject(test.subject) === selectedTestSubject &&
        test.chapter === chapter
      );
      const questionCount = available.reduce((total, test) => total + test.questions.length, 0);
      const card = document.createElement("button");
      card.type = "button";
      card.className = `test-chapter-card${selectedTestChapter === chapter ? " selected" : ""}`;
      card.setAttribute("aria-pressed", String(selectedTestChapter === chapter));

      const name = document.createElement("strong");
      name.textContent = chapter;
      const status = document.createElement("span");
      status.textContent = questionCount > 0 ? `${questionCount} questions` : "Coming soon";
      card.append(name, status);

      card.addEventListener("click", () => {
        selectedTestChapter = chapter;
        renderTestLabSelection();
      });
      chapterGrid.append(card);
    });
    chapterPanel.append(chapterGrid);
  });

  const selectedAvailable = testBank.filter((test) =>
    normalizeTestSubject(test.subject) === selectedTestSubject &&
    test.chapter === selectedTestChapter
  );
  const selectedQuestionCount = selectedAvailable.reduce((total, test) => total + test.questions.length, 0);

  const actionPanel = document.createElement("section");
  actionPanel.className = "panel test-config-panel";
  const actionTitle = document.createElement("h2");
  actionTitle.textContent = selectedTestChapter;
  actionPanel.append(actionTitle);

  if (selectedQuestionCount === 0) {
    const empty = document.createElement("p");
    empty.className = "analytics-empty";
    empty.textContent = "No questions available yet. Verified banks will appear here when imported.";
    actionPanel.append(empty);
  } else {
    const countLabel = document.createElement("label");
    countLabel.textContent = "Number of questions";
    const countInput = document.createElement("input");
    countInput.type = "number";
    countInput.min = "1";
    countInput.max = String(selectedQuestionCount);
    countInput.value = String(Math.min(selectedQuestionCount, 10));
    countInput.className = "test-config-input";
    countLabel.append(countInput);

    const difficultyLabel = document.createElement("label");
    difficultyLabel.textContent = "Difficulty";
    const difficultySelect = document.createElement("select");
    difficultySelect.className = "test-config-input";
    ["All", "Easy", "Moderate", "Advanced"].forEach((difficulty) => {
      const option = document.createElement("option");
      option.value = difficulty;
      option.textContent = difficulty;
      difficultySelect.append(option);
    });
    difficultyLabel.append(difficultySelect);

    const startButton = document.createElement("button");
    startButton.type = "button";
    startButton.className = "primary-button";
    startButton.textContent = "Start chapter test";
    startButton.addEventListener("click", () => {
      const count = Math.max(1, Math.min(selectedQuestionCount, Number(countInput.value) || 1));
      startChapterTest(selectedTestSubject, selectedTestChapter, count, difficultySelect.value);
    });
    actionPanel.append(countLabel, difficultyLabel, startButton);
  }

  const customPanel = document.createElement("section");
  customPanel.className = "panel test-config-panel";
  const customTitle = document.createElement("h2");
  customTitle.textContent = "Custom mixed test";
  const customCount = document.createElement("input");
  customCount.type = "number";
  customCount.min = "1";
  customCount.max = String(testBank.reduce((total, test) => total + test.questions.length, 0));
  customCount.value = "10";
  customCount.className = "test-config-input";
  customPanel.append(customTitle);

  const customCountLabel = document.createElement("label");
  customCountLabel.textContent = "Number of available questions";
  customCountLabel.append(customCount);

  const customSubjects = document.createElement("div");
  customSubjects.className = "test-mixed-subjects";
  ["Physics", "Chemistry", "Mathematics"].forEach((subject) => {
    const label = document.createElement("label");
    label.className = "test-mixed-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = subject;
    checkbox.checked = subject === selectedTestSubject;
    const text = document.createElement("span");
    text.textContent = subject;
    label.append(checkbox, text);
    customSubjects.append(label);
  });

    const customDifficultyLabel = document.createElement("label");
    customDifficultyLabel.textContent = "Difficulty";
    const customDifficulty = document.createElement("select");
    customDifficulty.className = "test-config-input";
    ["All", "Easy", "Moderate", "Advanced"].forEach((difficulty) => {
      const option = document.createElement("option");
      option.value = difficulty;
      option.textContent = difficulty;
      customDifficulty.append(option);
    });
    customDifficultyLabel.append(customDifficulty);

  const customStart = document.createElement("button");
  customStart.type = "button";
  customStart.className = "secondary-button";
  customStart.textContent = "Create mixed test";
  customStart.addEventListener("click", () => {
    const subjects = [...customSubjects.querySelectorAll("input:checked")]
      .map((input) => input.value);
    const count = Number(customCount.value) || 1;
    startMixedTest(subjects, count, "mixed", 0, customDifficulty.value);
  });
  customPanel.append(customCountLabel, customSubjects, customDifficultyLabel, customStart);

  const mockPanel = document.createElement("section");
  mockPanel.className = "panel test-config-panel";
  mockPanel.innerHTML = "<h2>Full mock configuration</h2><p class=\"muted\">Uses only currently imported verified questions.</p>";
  const mockCount = document.createElement("input");
  mockCount.type = "number";
  mockCount.min = "1";
  mockCount.max = String(testBank.reduce((total, test) => total + test.questions.length, 0));
  mockCount.value = String(Math.min(75, testBank.reduce((total, test) => total + test.questions.length, 0)));
  mockCount.className = "test-config-input";
  const mockMinutes = document.createElement("input");
  mockMinutes.type = "number";
  mockMinutes.min = "1";
  mockMinutes.value = "180";
  mockMinutes.className = "test-config-input";
  const mockCountLabel = document.createElement("label");
  mockCountLabel.textContent = "Questions available now";
  mockCountLabel.append(mockCount);
  const mockTimeLabel = document.createElement("label");
  mockTimeLabel.textContent = "Duration (minutes)";
  mockTimeLabel.append(mockMinutes);
  const mockStart = document.createElement("button");
  mockStart.type = "button";
  mockStart.className = "secondary-button";
  mockStart.textContent = "Start full mock";
  mockStart.addEventListener("click", () => {
    startMixedTest(["Physics", "Chemistry", "Mathematics"], Number(mockCount.value) || 1, "mock", Number(mockMinutes.value) || 180);
  });
  mockPanel.append(mockCountLabel, mockTimeLabel, mockStart);

  catalog.append(subjectPanel, chapterPanel, actionPanel, customPanel, mockPanel);
  content.append(intro, catalog);
}

function normalizeTestSubject(subject) {
  return subject === "Maths" ? "Mathematics" : subject;
}

function buildQuestionId(testId, question, index) {
  return String(question.id || `${testId}-q${index + 1}`);
}

function startChapterTest(subject, chapter, count, difficulty) {
  const sourceTests = testBank.filter((test) =>
    normalizeTestSubject(test.subject) === subject &&
    test.chapter === chapter
  );
  const questions = sourceTests
    .flatMap((test) => test.questions.map((question, index) => ({
      ...question,
      id: buildQuestionId(test.id, question, index),
      subject,
      chapter: test.chapter || chapter,
      difficulty: question.difficulty || test.difficulty || "Moderate"
    })))
    .filter((question) => difficulty === "All" || question.difficulty === difficulty);
  const limitedQuestions = questions.slice(0, Math.max(1, Math.min(count, questions.length)));
  if (limitedQuestions.length === 0) return;

  startTestConfig({
    id: `${subject.toLowerCase()}-${chapter.toLowerCase().replace(/[^a-z0-9]+/gi, "-")}-practice`,
    subject,
    chapter,
    title: chapter,
    description: "Chapter-wise original StudyOS practice.",
    mode: "chapter",
    questions: limitedQuestions
  });
}

function startMixedTest(subjects, count, mode = "mixed", durationMinutes = 0, difficulty = "All") {
  const subjectSet = new Set(subjects.map(normalizeTestSubject));
  const pool = testBank
    .filter((test) => subjectSet.has(normalizeTestSubject(test.subject)))
    .flatMap((test) => test.questions.map((question, index) => ({
      ...question,
      id: buildQuestionId(test.id, question, index),
      subject: normalizeTestSubject(test.subject),
      chapter: test.chapter || test.title,
      difficulty: question.difficulty || test.difficulty || "Moderate"
    })));
  const availablePool = difficulty === "All"
    ? pool
    : pool.filter((question) => question.difficulty === difficulty);
  const uniquePool = [];
  const ids = new Set();
  availablePool.forEach((question) => {
    if (!ids.has(question.id)) {
      ids.add(question.id);
      uniquePool.push(question);
    }
  });
  const selected = uniquePool.slice(0, Math.max(1, Math.min(count, uniquePool.length)));
  if (selected.length === 0) return;

  startTestConfig({
    id: mode === "mock" ? `jee-mock-${Date.now()}` : `jee-mixed-${Date.now()}`,
    subject: subjects.length === 1 ? normalizeTestSubject(subjects[0]) : "Mixed",
    chapter: mode === "mock" ? "Full JEE Class 11 Mock" : "Custom mixed chapters",
    title: mode === "mock" ? "Full JEE mock" : "Custom mixed test",
    description: "Built only from currently imported verified StudyOS questions.",
    mode,
    questions: selected
  }, durationMinutes);
}

function startTestConfig(testConfig, durationMinutes = 0) {
  activeTest = testConfig;
  activeRetakeConfig = {
    testConfig: {
      ...testConfig,
      questions: testConfig.questions.map((question) => ({ ...question }))
    },
    durationMinutes
  };
  activeTestMode = testConfig.mode || "chapter";
  activeQuestionIndex = 0;
  activeAnswers = new Array(activeTest.questions.length).fill(null);
  activeMarkedForReview = new Array(activeTest.questions.length).fill(false);
  activeTestStartedAt = Date.now();

  const ids = new Set();
  activeTest.questions = activeTest.questions.filter((question, index) => {
    const id = buildQuestionId(activeTest.id, question, index);
    if (ids.has(id)) return false;
    ids.add(id);
    question.id = id;
    return true;
  });
  activeAnswers = new Array(activeTest.questions.length).fill(null);

  startTestTimer(durationMinutes);
  renderTestQuestion();
}

function startTest(testId, durationMinutes = 0) {
  activeTest = testBank.find((test) => test.id === testId);
  if (!activeTest) return;
  startTestConfig({
    ...activeTest,
    subject: normalizeTestSubject(activeTest.subject),
    mode: "chapter",
    questions: activeTest.questions.map((question, index) => ({
      ...question,
      id: buildQuestionId(activeTest.id, question, index),
      subject: normalizeTestSubject(activeTest.subject),
      chapter: activeTest.chapter || activeTest.title,
      difficulty: question.difficulty || activeTest.difficulty || "Moderate"
    }))
  }, durationMinutes);
}

function stopTestTimer() {
  if (activeTestTimerInterval !== null) {
    clearInterval(activeTestTimerInterval);
    activeTestTimerInterval = null;
  }
  activeTestDeadline = null;
}

function startTestTimer(durationMinutes) {
  stopTestTimer();
  activeTestRemainingSeconds = Math.max(0, Math.round(durationMinutes * 60));
  if (activeTestRemainingSeconds === 0) return;
  activeTestDeadline = Date.now() + activeTestRemainingSeconds * 1000;
  activeTestTimerInterval = setInterval(() => {
    activeTestRemainingSeconds = activeTestDeadline === null
      ? 0
      : Math.max(0, Math.ceil((activeTestDeadline - Date.now()) / 1000));
    const display = $("#test-timer");
    if (display) {
      const minutes = Math.floor(activeTestRemainingSeconds / 60);
      const seconds = activeTestRemainingSeconds % 60;
      display.textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
    }
    if (activeTestRemainingSeconds <= 0) {
      stopTestTimer();
      submitTest();
    }
  }, 250);
}

function renderTestQuestion() {
  const content = $("#testlab-content");
  if (!content || !activeTest) return;

  content.replaceChildren();
  const question = activeTest.questions[activeQuestionIndex];
  const totalAnswered = activeAnswers.filter((answer) => answer !== null).length;

  const progress = document.createElement("div");
  progress.className = "test-progress";
  progress.textContent =
    `Question ${activeQuestionIndex + 1} of ${activeTest.questions.length} · ${totalAnswered} answered`;
  progress.setAttribute("role", "status");

  const topBar = document.createElement("div");
  topBar.className = "test-question-topbar";
  if (activeTestRemainingSeconds > 0) {
    const timer = document.createElement("span");
    timer.id = "test-timer";
    timer.className = "test-timer";
    const minutes = Math.floor(activeTestRemainingSeconds / 60);
    const seconds = activeTestRemainingSeconds % 60;
    timer.textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
    topBar.append(timer);
  }

  const navigator = document.createElement("div");
  navigator.className = "test-question-navigator";
  navigator.setAttribute("aria-label", "Question navigation");
  activeTest.questions.forEach((question, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      `test-question-dot${index === activeQuestionIndex ? " current" : ""}` +
      `${activeAnswers[index] !== null ? " answered" : ""}` +
      `${activeMarkedForReview[index] ? " marked" : ""}`;
    button.textContent = String(index + 1);
    button.setAttribute("aria-label", `Go to question ${index + 1}`);
    button.addEventListener("click", () => {
      activeQuestionIndex = index;
      renderTestQuestion();
    });
    navigator.append(button);
  });

  const card = document.createElement("article");
  card.className = "panel test-question-card";

  const heading = document.createElement("h2");
  heading.textContent = question.prompt;

  let answerInput = null;
  if (question.type === "numerical") {
    answerInput = document.createElement("div");
    answerInput.className = "test-numerical-answer";

    const label = document.createElement("label");
    label.htmlFor = "test-numerical-input";
    label.textContent = "Your numerical answer";

    const input = document.createElement("input");
    input.type = "text";
    input.id = "test-numerical-input";
    input.className = "test-numerical-input";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.value = typeof activeAnswers[activeQuestionIndex] === "string"
      ? activeAnswers[activeQuestionIndex]
      : "";
    input.placeholder = "Enter a number, fraction, or surd";
    input.addEventListener("input", () => {
      const value = input.value.trim();
      activeAnswers[activeQuestionIndex] = value === "" ? null : value;
    });

    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "Units are not required. Examples: 20/3, 3√2, 1.27, or √46.";
    answerInput.append(label, input, hint);
  } else {
    answerInput = document.createElement("fieldset");
    answerInput.className = "test-options";
    const legend = document.createElement("legend");
    legend.className = "hidden";
    legend.textContent = "Choose one answer";
    answerInput.append(legend);

    question.options.forEach((option, optionIndex) => {
      const label = document.createElement("label");
      label.className = "test-option";

      const input = document.createElement("input");
      input.type = "radio";
      input.name = "test-answer";
      input.checked = activeAnswers[activeQuestionIndex] === optionIndex;
      input.value = String(optionIndex);
      input.addEventListener("change", () => {
        activeAnswers[activeQuestionIndex] = optionIndex;
        renderTestQuestion();
      });

      const text = document.createElement("span");
      text.textContent = option;
      label.append(input, text);
      answerInput.append(label);
    });
  }

  const actions = document.createElement("div");
  actions.className = "test-actions";

  const reviewButton = document.createElement("button");
  reviewButton.type = "button";
  reviewButton.className = "secondary-button";
  reviewButton.textContent = activeMarkedForReview[activeQuestionIndex]
    ? "Unmark for review"
    : "Mark for review";
  reviewButton.addEventListener("click", () => {
    activeMarkedForReview[activeQuestionIndex] = !activeMarkedForReview[activeQuestionIndex];
    renderTestQuestion();
  });

  const previousButton = document.createElement("button");
  previousButton.type = "button";
  previousButton.className = "secondary-button";
  previousButton.textContent = "Previous";
  previousButton.disabled = activeQuestionIndex === 0;
  previousButton.addEventListener("click", () => {
    if (activeQuestionIndex > 0) {
      activeQuestionIndex--;
      renderTestQuestion();
    }
  });

  const nextButton = document.createElement("button");
  nextButton.type = "button";
  nextButton.className = "secondary-button";
  nextButton.textContent =
    activeQuestionIndex === activeTest.questions.length - 1 ? "Review results" : "Next";
  nextButton.addEventListener("click", () => {
    if (activeQuestionIndex < activeTest.questions.length - 1) {
      activeQuestionIndex++;
      renderTestQuestion();
    } else {
      submitTest();
    }
  });

  actions.append(reviewButton, previousButton, nextButton);
  card.append(heading, answerInput, actions);
  content.append(progress, topBar, navigator, card);
}

function submitTest() {
  if (!activeTest) return;
  stopTestTimer();

  const attempted = activeAnswers.filter((answer) => answer !== null).length;
  const results = activeAnswers.reduce((totals, answer, index) => {
    const question = activeTest.questions[index];
    if (answer === null) return totals;
    if (isTestAnswerCorrect(question, answer)) {
      totals.correct += 1;
      totals.score += Number(question.marks ?? 1);
    } else {
      totals.score -= Number(question.negativeMarks ?? 0);
    }
    return totals;
  }, { correct: 0, score: 0 });
  const correct = results.correct;
  const maxScore = activeTest.questions.reduce((total, question) => {
    return total + Number(question.marks ?? 1);
  }, 0);
  const percentage = maxScore === 0
    ? 0
    : Math.max(0, Math.round((results.score / maxScore) * 100));
  const total = activeTest.questions.length;
  const completedAt = new Date().toISOString();
  const attemptId = `${activeTest.id}-${Date.now()}`;
  const elapsedSeconds = activeTestStartedAt
    ? Math.max(0, Math.round((Date.now() - activeTestStartedAt) / 1000))
    : 0;
  const accuracy = attempted === 0 ? 0 : Math.round((correct / attempted) * 100);
  activeTest.questions.forEach((question, index) => {
    const answer = activeAnswers[index];
    if (!isTestAnswerCorrect(question, answer)) saveStudyMistake({
      question: question.prompt, subject: normalizeTestSubject(question.subject || activeTest.subject || "Mixed"),
      chapter: question.chapter || activeTest.chapter || "Uncategorized",
      selectedAnswer: answer == null ? "Not answered" : question.type === "numerical" ? String(answer) : question.options[answer],
      correctAnswer: question.type === "numerical" ? String(question.correctAnswer) : question.options[question.correctIndex],
      explanation: question.explanation || "No explanation was included in this item.",
      difficulty: question.difficulty || "Mixed", source: activeTest.mode === "mock" ? "Mock Exam" : "VECTRA Practice"
    });
  });
  const chapters = [...new Set(activeTest.questions.map((question) =>
    question.chapter || activeTest.chapter || "Uncategorized"
  ))];
  const subjects = [...new Set(activeTest.questions.map((question) =>
    normalizeTestSubject(question.subject || activeTest.subject || "Mixed")
  ))];

  testAttempts.unshift({
    id: attemptId,
    testId: activeTest.id,
    title: activeTest.title,
    subject: activeTest.subject,
    subjects,
    chapter: activeTest.chapter || chapters[0] || "Uncategorized",
    chapters,
    mode: activeTestMode,
    completedAt,
    correct,
    attempted,
    total,
    score: results.score,
    maxScore,
    accuracy,
    timeSpentSeconds: elapsedSeconds,
    percentage
  });
  saveTestAttempts();
  renderTestResults(correct, attempted, total, percentage, results.score, maxScore, accuracy);
  renderAnalytics();
}

function renderTestResults(correct, attempted, total, percentage, marks, maxScore, accuracy) {
  const content = $("#testlab-content");
  if (!content || !activeTest) return;

  content.replaceChildren();

  const summary = document.createElement("section");
  summary.className = "panel test-results-summary";

  const heading = document.createElement("h2");
  heading.textContent = "Practice results";

  const score = document.createElement("p");
  score.className = "test-score";
  score.textContent = `${correct} / ${total}`;

  const details = document.createElement("p");
  details.className = "muted";
  details.textContent = `${marks ?? 0}/${maxScore ?? total} marks · ${percentage}% · ${accuracy ?? 0}% accuracy · ${attempted} attempted · ${total - attempted} unanswered`;
  summary.append(heading, score, details);

  const review = document.createElement("div");
  review.className = "test-review";

  activeTest.questions.forEach((question, index) => {
    const answer = activeAnswers[index];
    const isCorrect = isTestAnswerCorrect(question, answer);
    const item = document.createElement("article");
    item.className = `panel test-review-item${isCorrect ? " correct" : answer === null ? " unanswered" : " incorrect"}`;

    const title = document.createElement("h3");
    title.textContent = `${index + 1}. ${question.prompt}`;

    const selected = document.createElement("p");
    selected.className = "test-review-answer";
    if (answer === null) {
      selected.textContent = "Your answer: Not answered";
    } else if (question.type === "numerical") {
      selected.textContent = `Your answer: ${answer}`;
    } else {
      selected.textContent = `Your answer: ${question.options[answer]}`;
    }

    const key = document.createElement("p");
    key.className = "test-review-key";
    key.textContent = question.type === "numerical"
      ? `Correct answer: ${question.correctAnswer}`
      : `Correct answer: ${question.options[question.correctIndex]}`;

    const explanation = document.createElement("p");
    explanation.className = "muted";
    explanation.textContent = question.explanation;

    item.append(title, selected, key, explanation);
    review.append(item);
  });

  const actions = document.createElement("div");
  actions.className = "test-results-actions";

  const againButton = document.createElement("button");
  againButton.type = "button";
  againButton.className = "secondary-button";
  againButton.textContent = "Retake test";
  againButton.addEventListener("click", () => {
    if (activeRetakeConfig) {
      startTestConfig(
        {
          ...activeRetakeConfig.testConfig,
          questions: activeRetakeConfig.testConfig.questions.map((question) => ({ ...question }))
        },
        activeRetakeConfig.durationMinutes
      );
    } else {
      startTest(activeTest.id);
    }
  });

  const selectionButton = document.createElement("button");
  selectionButton.type = "button";
  selectionButton.className = "primary-button";
  selectionButton.textContent = "Choose another test";
  selectionButton.addEventListener("click", renderTestLabSelection);

  actions.append(againButton, selectionButton);
  content.append(summary, review, actions);
}

/* StudyOS task manager */
const taskForm = $("#task-form");
const taskTitleInput = $("#task-title");
const taskSubjectInput = $("#task-subject");
const taskPriorityInput = $("#task-priority");
const taskMessage = $("#task-message");
const taskContent = $("#task-content");
const taskFilters = $$(".task-filter");

let studyTasks = [];

try {
  const savedTasks = localStorage.getItem("studyos-tasks");
  studyTasks = savedTasks ? JSON.parse(savedTasks) : [];

  if (!Array.isArray(studyTasks)) studyTasks = [];
} catch {
  studyTasks = [];
}

let currentTaskFilter = "all";

function saveStudyTasks() {
  try {
    localStorage.setItem("studyos-tasks", JSON.stringify(studyTasks));
  } catch {
    if (taskMessage) {
      taskMessage.textContent =
        "Couldn't save tasks on this device. Check browser storage.";
    }
  }
}

function updateTaskStats() {
  const totalElement = $("#tasks-total");
  if (totalElement) {
    totalElement.textContent = studyTasks.filter(
      (task) => task.completed
    ).length;
  }

  renderHomeAnalytics();
}

function renderHomeAnalytics() {
  const focusElement = $("#focus-total");
  if (!focusElement) return;

  const todayKey = localDateKey(new Date());
  const todayMinutes = focusSessions
    .filter((session) => localDateKey(session.completedAt) === todayKey)
    .reduce((total, session) => total + Number(session.durationMinutes || 0), 0);

  focusElement.textContent = `${todayMinutes} min`;
}

function renderAnalytics() {
  const container = $("#analytics-content");
  if (!container) return;

  container.replaceChildren();

  const todayKey = localDateKey(new Date());
  const todayMinutes = focusSessions
    .filter((session) => localDateKey(session.completedAt) === todayKey)
    .reduce((total, session) => total + Number(session.durationMinutes || 0), 0);
  const totalMinutes = focusSessions
    .reduce((total, session) => total + Number(session.durationMinutes || 0), 0);
  const completedTasks = studyTasks.filter((task) => task.completed).length;
  const pendingTasks = studyTasks.length - completedTasks;
  const completionRate = studyTasks.length === 0
    ? 0
    : Math.round((completedTasks / studyTasks.length) * 100);

  const summary = document.createElement("div");
  summary.className = "analytics-summary";

  const metrics = [
    ["Focused today", `${todayMinutes} min`],
    ["Total focus time", `${totalMinutes} min`],
    ["Tasks completed", String(completedTasks)],
    ["Task completion", `${completionRate}%`]
  ];

  metrics.forEach(([label, value]) => {
    const card = document.createElement("article");
    card.className = "analytics-card";

    const labelElement = document.createElement("span");
    labelElement.className = "analytics-label";
    labelElement.textContent = label;

    const valueElement = document.createElement("strong");
    valueElement.className = "analytics-value";
    valueElement.textContent = value;

    card.append(labelElement, valueElement);
    summary.append(card);
  });

  const weekPanel = document.createElement("section");
  weekPanel.className = "panel analytics-panel";

  const weekTitle = document.createElement("h2");
  weekTitle.textContent = "Last 7 days";
  weekPanel.append(weekTitle);

  const week = document.createElement("div");
  week.className = "analytics-week";
  const dayValues = [];
  let weekHasSessions = false;

  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const key = localDateKey(date);
    const minutes = focusSessions
      .filter((session) => localDateKey(session.completedAt) === key)
      .reduce((total, session) => total + Number(session.durationMinutes || 0), 0);
    if (minutes > 0) weekHasSessions = true;
    dayValues.push({ date, minutes });
  }

  const maxMinutes = Math.max(25, ...dayValues.map((day) => day.minutes));

  dayValues.forEach(({ date, minutes }) => {
    const day = document.createElement("div");
    day.className = "analytics-day";

    const bar = document.createElement("div");
    bar.className = "analytics-bar-track";
    const fill = document.createElement("div");
    fill.className = "analytics-bar-fill";
    fill.style.height = `${minutes === 0 ? 0 : Math.max(8, (minutes / maxMinutes) * 100)}%`;
    bar.append(fill);

    const label = document.createElement("span");
    label.textContent = date.toLocaleDateString(undefined, { weekday: "short" });
    const value = document.createElement("small");
    value.textContent = `${minutes}m`;

    day.append(bar, label, value);
    week.append(day);
  });

  weekPanel.append(week);

  if (!weekHasSessions) {
    const empty = document.createElement("p");
    empty.className = "analytics-empty";
    empty.textContent = "No focus sessions recorded yet.";
    weekPanel.append(empty);
  }

  const taskPanel = document.createElement("section");
  taskPanel.className = "panel analytics-panel";
  const taskTitle = document.createElement("h2");
  taskTitle.textContent = "Task progress";
  taskPanel.append(taskTitle);

  const taskStats = document.createElement("div");
  taskStats.className = "analytics-task-stats";

  const taskRows = [
    ["Completed", completedTasks],
    ["Pending", pendingTasks]
  ];

  taskRows.forEach(([label, count]) => {
    const row = document.createElement("div");
    row.className = "analytics-task-row";
    row.textContent = `${label}: ${count}`;
    taskStats.append(row);
  });

  const progressTrack = document.createElement("div");
  progressTrack.className = "analytics-progress-track";
  const progressFill = document.createElement("div");
  progressFill.className = "analytics-progress-fill";
  progressFill.style.width = `${completionRate}%`;
  progressTrack.append(progressFill);
  taskStats.append(progressTrack);

  const subjectCounts = {};
  studyTasks.forEach((task) => {
    if (!task.completed) return;
    const subject = task.subject || "Other";
    subjectCounts[subject] = (subjectCounts[subject] || 0) + 1;
  });

  const subjectTitle = document.createElement("h3");
  subjectTitle.textContent = "Completed by subject";
  taskStats.append(subjectTitle);

  if (Object.keys(subjectCounts).length === 0) {
    const noTasks = document.createElement("p");
    noTasks.className = "analytics-empty";
    noTasks.textContent = "Complete a task to see subject progress.";
    taskStats.append(noTasks);
  } else {
    Object.entries(subjectCounts).forEach(([subject, count]) => {
      const row = document.createElement("div");
      row.className = "analytics-task-row";
      row.textContent = `${subject}: ${count}`;
      taskStats.append(row);
    });
  }

  taskPanel.append(taskStats);
  container.append(summary, weekPanel, taskPanel);

  const testPanel = document.createElement("section");
  testPanel.className = "panel analytics-panel test-analytics-panel";

  const testTitle = document.createElement("h2");
  testTitle.textContent = "VECTRA Practice";
  testPanel.append(testTitle);

  if (testAttempts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "analytics-empty";
    empty.textContent = "No practice attempts recorded yet.";
    testPanel.append(empty);
  } else {
    const average = Math.round(
      testAttempts.reduce((total, attempt) =>
        total + Number(attempt.percentage || 0), 0) / testAttempts.length
    );
    const best = Math.max(
      ...testAttempts.map((attempt) => Number(attempt.percentage || 0))
    );

    const testStats = document.createElement("div");
    testStats.className = "test-analytics-stats";

    const attemptRow = document.createElement("div");
    attemptRow.className = "analytics-task-row";
    attemptRow.textContent = `Practice attempts: ${testAttempts.length}`;

    const averageRow = document.createElement("div");
    averageRow.className = "analytics-task-row";
    averageRow.textContent = `Average score: ${average}%`;

    const bestRow = document.createElement("div");
    bestRow.className = "analytics-task-row";
    bestRow.textContent = `Best score: ${best}%`;

    const accuracy = testAttempts.reduce((total, attempt) =>
      total + Number(attempt.accuracy ?? (attempt.attempted
        ? (attempt.correct / attempt.attempted) * 100
        : 0)), 0) / testAttempts.length;
    const accuracyRow = document.createElement("div");
    accuracyRow.className = "analytics-task-row";
    accuracyRow.textContent = `Average accuracy: ${Math.round(accuracy)}%`;

    const totalSeconds = testAttempts.reduce((total, attempt) =>
      total + Number(attempt.timeSpentSeconds || 0), 0);
    const timeRow = document.createElement("div");
    timeRow.className = "analytics-task-row";
    timeRow.textContent = `Time in VECTRA Practice: ${Math.round(totalSeconds / 60)} min`;

    testStats.append(attemptRow, averageRow, bestRow, accuracyRow, timeRow);

    const subjectCounts = {};
    const chapterCounts = {};
    testAttempts.forEach((attempt) => {
      const subjects = attempt.subjects && attempt.subjects.length
        ? attempt.subjects
        : [normalizeTestSubject(attempt.subject || "Mixed")];
      subjects.forEach((subject) => {
        subjectCounts[subject] = (subjectCounts[subject] || 0) + 1;
      });
      const chapters = attempt.chapters && attempt.chapters.length
        ? attempt.chapters
        : [attempt.chapter || "Uncategorized"];
      chapters.forEach((chapter) => {
        chapterCounts[chapter] = (chapterCounts[chapter] || 0) + 1;
      });
    });

    const breakdownTitle = document.createElement("h3");
    breakdownTitle.textContent = "Attempts by subject";
    testStats.append(breakdownTitle);
    Object.entries(subjectCounts).forEach(([subject, count]) => {
      const row = document.createElement("div");
      row.className = "analytics-task-row";
      row.textContent = `${subject}: ${count}`;
      testStats.append(row);
    });

    const chapterTitle = document.createElement("h3");
    chapterTitle.textContent = "Attempts by chapter";
    testStats.append(chapterTitle);
    Object.entries(chapterCounts).forEach(([chapter, count]) => {
      const row = document.createElement("div");
      row.className = "analytics-task-row";
      row.textContent = `${chapter}: ${count}`;
      testStats.append(row);
    });

    testAttempts.slice(0, 3).forEach((attempt) => {
      const recent = document.createElement("p");
      recent.className = "test-attempt-row";
      const date = new Date(attempt.completedAt);
      const dateLabel = Number.isNaN(date.getTime())
        ? "Unknown date"
        : date.toLocaleDateString();
      recent.textContent =
        `${attempt.title} · ${attempt.correct}/${attempt.total} correct · ` +
        `${Number(attempt.accuracy || 0)}% accuracy · ${Math.round(Number(attempt.timeSpentSeconds || 0) / 60)} min · ${dateLabel}`;
      testStats.append(recent);
    });

    testPanel.append(testStats);
  }

  container.append(testPanel);
}

function renderStudyTasks() {
  if (!taskContent) return;

  taskContent.replaceChildren();

  const visibleTasks = studyTasks.filter((task) => {
    if (currentTaskFilter === "pending") return !task.completed;
    if (currentTaskFilter === "completed") return task.completed;
    return true;
  });

  if (visibleTasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent =
      currentTaskFilter === "completed"
        ? "No completed tasks yet. Keep going!"
        : currentTaskFilter === "pending"
          ? "You're all caught up! Add a new task when ready."
          : "No tasks yet. Add your first study task above.";
    taskContent.append(empty);
    updateTaskStats();
    return;
  }

  visibleTasks.forEach((task) => {
    const item = document.createElement("article");
    item.className = `task-item${task.completed ? " completed" : ""}`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.completed;
    checkbox.setAttribute("aria-label", `Complete ${task.title}`);

    checkbox.addEventListener("change", () => {
      task.completed = checkbox.checked;
      if (task.completed) {
        task.completedAt = task.completedAt || new Date().toISOString();
      } else {
        delete task.completedAt;
      }
      saveStudyTasks();
      renderStudyTasks();
      renderHomeAnalytics();
      renderAnalytics();
    });

    const details = document.createElement("div");
    details.className = "task-details";

    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = task.title;

    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent =
      `${task.subject} · ${task.priority === "high" ? "High priority" : "Normal priority"}`;

    details.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "task-actions";

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.setAttribute("aria-label", `Delete ${task.title}`);

    deleteButton.addEventListener("click", () => {
      studyTasks = studyTasks.filter((item) => item.id !== task.id);
      saveStudyTasks();
      renderStudyTasks();
      renderAnalytics();
    });

    actions.append(deleteButton);
    item.append(checkbox, details, actions);
    taskContent.append(item);
  });

  updateTaskStats();
}

// ---------- StudyOS rewards, achievements, rankings, and theme studio ----------
      const STUDYOS_DATA_KEY = "studyos-progress-v1";
      const STUDYOS_THEME_KEY = "studyos-active-theme";
      const STUDYOS_SAVED_THEMES_KEY = "studyos-saved-themes";
      const STUDYOS_AI_TEST_HISTORY_KEY = "studyos-ai-test-history";

      function safeJsonStorage(key, fallback) {
        try {
          const value = JSON.parse(localStorage.getItem(key) || "null");
          return value ?? fallback;
        } catch {
          return fallback;
        }
      }

      function getStudyProgress() {
        const saved = safeJsonStorage(STUDYOS_DATA_KEY, {});
        return {
          profile: { name: saved.profile?.name || "StudyOS User", avatar: saved.profile?.avatar || "🎓" },
          xp: Number(saved.xp || 0),
          awarded: Array.isArray(saved.awarded) ? saved.awarded : [],
          libraryVisits: Array.isArray(saved.libraryVisits) ? saved.libraryVisits : [],
          libraryVisitCount: Number(saved.libraryVisitCount || 0),
          updatedAt: saved.updatedAt || null
        };
      }

      function saveStudyProgress(progress) {
        progress.updatedAt = new Date().toISOString();
        try { localStorage.setItem(STUDYOS_DATA_KEY, JSON.stringify(progress)); } catch {}
        syncStudyOSAccount();
        syncSharedLeaderboard();
      }

      function xpLevel(xp) {
        let level = 1;
        let remaining = xp;
        while (remaining >= level * 500) {
          remaining -= level * 500;
          level += 1;
        }
        const required = level * 500;
        return { level, progress: remaining, required, percent: Math.min(100, Math.round((remaining / required) * 100)) };
      }

      function awardXP(eventId, amount) {
        const progress = getStudyProgress();
        if (!eventId || progress.awarded.includes(eventId)) return false;
        progress.awarded.push(eventId);
        progress.xp += amount;
        saveStudyProgress(progress);
        renderXPAndAchievements();
        return true;
      }

      const achievementDefinitions = [
        { id:"task-1", icon:"✓", title:"First step", description:"Complete your first task.", max:1, get: p => studyTasks.filter(t=>t.completed).length },
        { id:"task-10", icon:"★", title:"Task master", description:"Complete 10 tasks.", max:10, get: () => studyTasks.filter(t=>t.completed).length },
        { id:"focus-1", icon:"◷", title:"Focus beginner", description:"Finish one focus session.", max:1, get: () => focusSessions.length },
        { id:"focus-10", icon:"◉", title:"Deep focus", description:"Finish 10 focus sessions.", max:10, get: () => focusSessions.length },
        { id:"library-1", icon:"▤", title:"Library explorer", description:"Open a library subject.", max:1, get: p => p.libraryVisitCount },
        { id:"library-5", icon:"📚", title:"Knowledge seeker", description:"Use 5 library subjects or chapters.", max:5, get: p => p.libraryVisitCount },
        { id:"streak-3", icon:"🔥", title:"Three-day streak", description:"Study on 3 consecutive days.", max:3, get: () => getStudyStreak() }
      ];

      function getStudyStreak() {
        const days = new Set([
          ...focusSessions.map(s => localDateKey(s.completedAt)),
          ...studyTasks.filter(t=>t.completedAt).map(t => localDateKey(t.completedAt)),
          ...testAttempts.map(t => localDateKey(t.completedAt))
        ]);
        let streak = 0;
        const cursor = new Date();
        for (;;) {
          const key = localDateKey(cursor);
          if (!days.has(key)) break;
          streak += 1;
          cursor.setDate(cursor.getDate()-1);
        }
        return streak;
      }

      function renderXPAndAchievements() {
        const progress = getStudyProgress();
        const level = xpLevel(progress.xp);
        const summary = $("#xp-summary");
        if (summary) {
          summary.innerHTML = `<div class="xp-avatar">${escapeDoubtHtml(progress.profile.avatar)}</div><div><div class="xp-level-row"><strong>Level ${level.level}</strong><span>${progress.xp} XP</span></div><div class="xp-progress"><span style="width:${level.percent}%"></span></div><small class="muted">${level.progress} / ${level.required} XP to next level</small></div>`;
        }
        const levelCard = $("#achievement-level-card");
        if (levelCard) levelCard.innerHTML = `<section class="panel level-card"><div><p class="eyebrow">CURRENT LEVEL</p><h2>Level ${level.level}</h2></div><div style="min-width:180px"><strong>${progress.xp} XP</strong><div class="xp-progress"><span style="width:${level.percent}%"></span></div></div></section>`;
        const grid = $("#achievement-grid");
        if (grid) {
          grid.replaceChildren();
          achievementDefinitions.forEach(def => {
            const value = Math.min(def.max, def.get(progress));
            const unlocked = value >= def.max;
            const card = document.createElement("article");
            card.className = `achievement-card${unlocked?" unlocked":""}`;
            card.innerHTML = `<span class="achievement-icon">${def.icon}</span><h3>${escapeDoubtHtml(def.title)}</h3><p>${escapeDoubtHtml(def.description)}</p><div class="achievement-progress"><span style="width:${Math.round(value/def.max*100)}%"></span></div><small class="muted">${unlocked?"Unlocked":`${value} / ${def.max}`}</small>`;
            grid.append(card);
          });
        }
      }

      // Scan completed browser records and grant server-independent local event XP exactly once.
      setInterval(() => {
        const progress = getStudyProgress();
        let changed = false;
        studyTasks.filter(t=>t.completed && t.id).forEach(task => changed = awardXP(`task-${task.id}`, 20) || changed);
        focusSessions.forEach(session => { changed = awardXP(`focus-${session.id}`, 50) || changed; });
        testAttempts.forEach(attempt => { changed = awardXP(`test-${attempt.id}`, Math.max(20, Math.round(attempt.percentage/4))) || changed; });
        achievementDefinitions.forEach((definition, index) => {
          if (definition.get(getStudyProgress()) >= definition.max) {
            changed = awardXP(`achievement-${definition.id}`, index === 1 || index === 3 || index === 5 || index === 6 ? 100 : 50) || changed;
          }
        });
        if (changed) renderLeaderboard();
      }, 1500);

      document.addEventListener("change", event => {
        if (event.target?.matches("#task-content input[type=checkbox]") && event.target.checked) {
          const item = event.target.closest(".task-item");
          const title = item?.querySelector(".task-title")?.textContent || "";
          const task = studyTasks.find(t=>t.title === title && t.completed);
          if (task) awardXP(`task-${task.id}`, 20);
        }
      });

      document.addEventListener("click", event => {
        const subject = event.target.closest(".subject-card")?.dataset.subject;
        if (subject) {
          const progress = getStudyProgress();
          progress.libraryVisitCount = Number(progress.libraryVisitCount || 0) + 1;
          if (!progress.libraryVisits.includes(subject)) {
            progress.libraryVisits.push(subject);
            saveStudyProgress(progress);
            awardXP(`library-${subject}-${localDateKey(new Date())}`, 10);
            renderXPAndAchievements();
          }
        }
      });

      // Timer progress ring and custom modes.
      function updateTimerRing() {
        const ring = $("#timer-ring");
        if (!ring) return;
        const match = /^(\d{2}):(\d{2})$/.exec(timerDisplay?.textContent || "");
        if (!match) return;
        const remaining = Number(match[1])*60+Number(match[2]);
        const percent = timerDuration ? Math.max(0, 1-(remaining/timerDuration)) : 0;
        ring.style.setProperty("--timer-progress", `${percent*360}deg`);
        $("#timer-state").textContent = timerRunning ? "Focusing" : remaining === timerDuration ? "Ready" : "Paused";
      }
      setInterval(updateTimerRing, 250);

      document.querySelectorAll(".timer-mode").forEach(button => button.addEventListener("click", () => {
        const minutes = Number(button.dataset.minutes);
        document.querySelectorAll(".timer-mode").forEach(item=>item.classList.toggle("active",item===button));
        if (typeof setTimerMinutes==="function") setTimerMinutes(minutes);
        $("#timer-custom").value = minutes;
        updateTimerRing();
      }));
      $("#timer-custom")?.addEventListener("change", event => {
        const minutes = Math.max(1,Math.min(180,Number(event.target.value)||25));
        event.target.value = minutes;
        document.querySelectorAll(".timer-mode").forEach(item=>item.classList.remove("active"));
        if (typeof setTimerMinutes==="function") setTimerMinutes(minutes);
      });

      // Suggested prompts.
      document.querySelectorAll(".doubt-suggestions button").forEach(button => button.addEventListener("click", () => {
        const input=$("#doubt-input");
        if (input) { input.value=button.dataset.prompt; input.focus(); }
      }));

      let sharedLeaderboardUsers = [];

      async function syncSharedLeaderboard() {
        let userId = "";
        try {
          userId = localStorage.getItem(DOUBT_USER_KEY) || "";
        } catch {}
        if (!/^[A-Za-z0-9_-]{8,80}$/.test(userId)) return;

        const progress = getStudyProgress();
        const aiHistory = safeJsonStorage(STUDYOS_AI_TEST_HISTORY_KEY, []);
        const tests = [
          ...(Array.isArray(testAttempts) ? testAttempts : []),
          ...(Array.isArray(aiHistory) ? aiHistory : [])
        ].filter((attempt) => attempt.completedAt && Number.isFinite(Number(attempt.maxScore)));

        try {
          await fetch("/api/leaderboard/sync", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(localStorage.getItem(AUTH_TOKEN_KEY)
                ? { Authorization: `Bearer ${localStorage.getItem(AUTH_TOKEN_KEY)}` }
                : {})
            },
            body: JSON.stringify({
              userId,
              name: progress.profile.name,
              avatar: progress.profile.avatar,
              xp: progress.xp,
              tests
            })
          }).then((response) => response.ok ? response.json() : null);
          await refreshSharedLeaderboard();
        } catch {}
      }

      async function refreshSharedLeaderboard() {
        try {
          const response = await fetch("/api/leaderboard", { cache: "no-store" });
          if (!response.ok) return;
          const data = await response.json();
          sharedLeaderboardUsers = Array.isArray(data.users) ? data.users : [];
          renderLeaderboard();
        } catch {}
      }

      let currentLeaderboardTab = "xp";
      function renderLeaderboard() {
        const content=$("#leaderboard-content");
        if (!content) return;
        if (currentLeaderboardTab==="xp") {
          const progress=getStudyProgress();
          let userId = "";
          try { userId = localStorage.getItem(DOUBT_USER_KEY) || ""; } catch {}
          const users = (sharedLeaderboardUsers.length ? sharedLeaderboardUsers : [{
            id: "current",
            name: progress.profile.name,
            avatar: progress.profile.avatar,
            xp: progress.xp
          }]).map((user) => {
            const level=xpLevel(user.xp);
            return {...user,level:level.level,current:user.id === userId || user.id === "current"};
          }).sort((a,b)=>b.xp-a.xp);
          content.replaceChildren();
          const podium=document.createElement("div"); podium.className="podium";
          users.forEach((user,index)=>{
            const card=document.createElement("article");card.className=`podium-card${user.current?" current":""}`;
            card.innerHTML=`<div class="podium-avatar">${escapeDoubtHtml(user.avatar)}</div><strong>${index===0?"#1":`#${index+1}`} ${escapeDoubtHtml(user.name)}</strong><span>${user.xp} XP · Level ${user.level}</span>`;
            podium.append(card);
          });
          const list=document.createElement("div");list.className="leaderboard-list";
          users.forEach((user,index)=>{
            const row=document.createElement("article");row.className=`leaderboard-row${user.current?" current":""}`;
            row.innerHTML=`<strong>#${index+1}</strong><div class="leaderboard-avatar">${escapeDoubtHtml(user.avatar)}</div><div><strong>${escapeDoubtHtml(user.name)}${user.current?" (You)":""}</strong><br><small>Level ${user.level}</small></div><strong>${user.xp} XP</strong>`;
            list.append(row);
          });
          content.append(podium,list);
        } else {
          const aiHistory = safeJsonStorage(STUDYOS_AI_TEST_HISTORY_KEY, []);
          const completed = [
            ...(Array.isArray(testAttempts) ? testAttempts : []),
            ...(Array.isArray(aiHistory) ? aiHistory : [])
          ].filter(a => a.completedAt && Number.isFinite(Number(a.maxScore)));
          let userId = "";
          try { userId = localStorage.getItem(DOUBT_USER_KEY) || ""; } catch {}
          const progress=getStudyProgress();
          const rows=[];
          const people = sharedLeaderboardUsers.length ? sharedLeaderboardUsers.map((user) => ({
            id:user.id,
            name:user.name,
            avatar:user.avatar,
            tests:Array.isArray(user.tests)?user.tests:[]
          })) : [{
            id:userId || "current",
            name:progress.profile.name,
            avatar:progress.profile.avatar,
            tests:completed
          }];
          people.forEach((person)=>{
            const grouped={};
            person.tests.forEach(attempt=>{
              const max=Number(attempt.maxScore||0);
              const key=`${attempt.testId||attempt.title}|${max}`;
              grouped[key]=grouped[key]||[];
              grouped[key].push(attempt);
            });
            Object.values(grouped).forEach(items=>{
              const best=items.slice().sort((a,b)=>(b.percentage-a.percentage)||(b.accuracy-a.accuracy)||(a.timeSpentSeconds-b.timeSpentSeconds))[0];
              rows.push({attempt:best,name:person.name,avatar:person.avatar,current:person.id===userId,id:person.id});
            });
          });
          if (!rows.length) { content.innerHTML=`<div class="leaderboard-empty">No completed tests yet. Finish a test to appear in the rankings.</div>`; return; }
          rows.sort((a,b)=>(b.attempt.percentage-a.attempt.percentage)||(b.attempt.accuracy-a.attempt.accuracy)||(a.attempt.timeSpentSeconds-b.attempt.timeSpentSeconds));
          const list=document.createElement("div");list.className="leaderboard-list";
          rows.forEach((row,index)=>{
            const a=row.attempt;const el=document.createElement("article");el.className=`leaderboard-row${row.current?" current":""}`;
            el.innerHTML=`<strong>#${index+1}</strong><div class="leaderboard-avatar">${escapeDoubtHtml(row.avatar)}</div><div><strong>${escapeDoubtHtml(row.name)}${row.current?" (You)":""}</strong><br><small>${escapeDoubtHtml(a.title||"Practice test")} · ${a.accuracy}% accuracy · ${a.timeSpentSeconds||0}s</small></div><strong>${a.score}/${a.maxScore} · ${a.percentage}%</strong>`;
            list.append(el);
          });
          content.append(list);
        }
      }
      document.querySelectorAll(".leaderboard-tab").forEach(button=>button.addEventListener("click",()=>{
        currentLeaderboardTab=button.dataset.board;
        document.querySelectorAll(".leaderboard-tab").forEach(tab=>tab.classList.toggle("active",tab===button));
        renderLeaderboard();
      }));

      // Profile persistence.
      const profileInput=$("#profile-name");
      if (profileInput) profileInput.addEventListener("change",()=>{
        const progress=getStudyProgress();
        progress.profile.name=profileInput.value.trim().slice(0,30)||"StudyOS User";
        saveStudyProgress(progress);renderXPAndAchievements();renderLeaderboard();
      });
      document.querySelectorAll("#avatar-choice button").forEach(button=>button.addEventListener("click",()=>{
        document.querySelectorAll("#avatar-choice button").forEach(item=>item.classList.toggle("active",item===button));
        const progress=getStudyProgress();progress.profile.avatar=button.dataset.avatar;saveStudyProgress(progress);renderXPAndAchievements();renderLeaderboard();
      }));

      // Structured theme studio. All palettes are validated hex colors and only applied to CSS variables.
      const themeKeys=["background","surface","card","text","primary","secondary","accent","border","button"];
      const defaultTheme={background:"#090b12",surface:"#131620",card:"#181c28",text:"#f4f3ff",primary:"#7654dc",secondary:"#9b7aff",accent:"#b5a0ff",border:"#292f43",button:"#7654dc"};
      let draftTheme={...defaultTheme};
      function validHex(value){return /^#[0A-Fa-f]{0}$/i.test(value)?false:/^#[0-9A-Fa-f]{6}$/.test(value);}
      function applyThemeDraft(theme){
        const map={background:"--bg",surface:"--surface",card:"--surface-hover",text:"--text",primary:"--accent-strong",secondary:"--accent",accent:"--accent",border:"--border",button:"--accent-strong"};
        Object.entries(theme).forEach(([key,value])=>{ if(validHex(value)&&map[key]) document.documentElement.style.setProperty(map[key],value); });
      }
      function generateTheme(prompt){
        const text=String(prompt||"").toLowerCase();
        let seed=text.includes("sunset")||text.includes("orange")?"#e58a5a":text.includes("ocean")||text.includes("blue")?"#3aa7d9":text.includes("forest")||text.includes("green")?"#4dbb8a":text.includes("sakura")||text.includes("pink")?"#e98bac":text.includes("aurora")||text.includes("purple")?"#9b7aff":"#8f7cf7";
        const light=text.includes("light")||text.includes("daylight")||text.includes("white");
        return light?{background:"#f5f7fb",surface:"#ffffff",card:"#edf1f8",text:"#172033",primary:"#6042c7",secondary:seed,accent:seed,border:"#d9dfeb",button:"#6042c7"}:{background:"#090b12",surface:"#131620",card:"#181c28",text:"#f4f3ff",primary:"#7654dc",secondary:seed,accent:seed,border:"#292f43",button:"#7654dc"};
      }
      function renderThemeStudio(){
        const preview=$("#theme-preview");
        if(preview) preview.innerHTML=["background","surface","card","text","primary","secondary","accent","border","button"].map(key=>`<div class="theme-swatch" style="background:${validHex(draftTheme[key])?draftTheme[key]:defaultTheme[key]}">${escapeDoubtHtml(key)}</div>`).join("");
        const editor=$("#theme-editor");
        if(editor){editor.replaceChildren();themeKeys.forEach(key=>{const label=document.createElement("label");label.className="theme-color-field";label.innerHTML=`<span>${key}</span>`;const input=document.createElement("input");input.type="color";input.value=validHex(draftTheme[key])?draftTheme[key]:defaultTheme[key];input.addEventListener("input",()=>{draftTheme[key]=input.value;renderThemeStudio();applyThemeDraft(draftTheme);});label.append(input);editor.append(label);});}
        const saved=safeJsonStorage(STUDYOS_SAVED_THEMES_KEY,[]);
        const savedGrid=$("#saved-themes");
        if(savedGrid){savedGrid.replaceChildren();(Array.isArray(saved)?saved:[]).forEach((theme,index)=>{const card=document.createElement("article");card.className="saved-theme-card";card.innerHTML=`<div class="saved-theme-name"><strong>${escapeDoubtHtml(theme.name||"Custom theme")}</strong><button type="button" data-delete="${index}" aria-label="Delete theme">×</button></div><div class="saved-theme-strips">${["background","surface","primary","accent","text"].map(k=>`<span style="background:${validHex(theme.colors?.[k])?theme.colors[k]:defaultTheme[k]}"></span>`).join("")}</div><button type="button" data-apply="${index}">Apply</button>`;savedGrid.append(card);});}
        savedGrid?.querySelectorAll("[data-apply]").forEach(button=>button.addEventListener("click",()=>{const item=saved[Number(button.dataset.apply)];draftTheme={...item.colors};renderThemeStudio();applyThemeDraft(draftTheme);localStorage.setItem(STUDYOS_THEME_KEY,JSON.stringify(draftTheme));document.documentElement.removeAttribute("data-theme");}));
        savedGrid?.querySelectorAll("[data-delete]").forEach(button=>button.addEventListener("click",()=>{const next=saved.filter((_,index)=>index!==Number(button.dataset.delete));localStorage.setItem(STUDYOS_SAVED_THEMES_KEY,JSON.stringify(next));renderThemeStudio();}));
      }
      $("#theme-generate")?.addEventListener("click",()=>{draftTheme=generateTheme($("#theme-prompt").value);renderThemeStudio();applyThemeDraft(draftTheme);});
      $("#theme-random")?.addEventListener("click",()=>{const prompts=["ocean midnight","sakura light","forest aurora","sunset dark","lavender night"];$("#theme-prompt").value=prompts[Math.floor(Math.random()*prompts.length)];draftTheme=generateTheme($("#theme-prompt").value);renderThemeStudio();applyThemeDraft(draftTheme);});
      $("#theme-save")?.addEventListener("click",()=>{const saved=safeJsonStorage(STUDYOS_SAVED_THEMES_KEY,[]);const name=window.prompt("Name this theme","My custom theme");if(!name)return;const next=Array.isArray(saved)?saved:[];next.push({name:name.trim().slice(0,40)||"Custom theme",colors:{...draftTheme}});localStorage.setItem(STUDYOS_SAVED_THEMES_KEY,JSON.stringify(next));localStorage.setItem(STUDYOS_THEME_KEY,JSON.stringify(draftTheme));document.documentElement.removeAttribute("data-theme");applyThemeDraft(draftTheme);renderThemeStudio();});

      const savedActiveTheme=safeJsonStorage(STUDYOS_THEME_KEY,null);
      if(savedActiveTheme&&typeof savedActiveTheme==="object"){draftTheme={...defaultTheme,...savedActiveTheme};applyThemeDraft(draftTheme);document.documentElement.removeAttribute("data-theme");}
      else {const storedTheme=localStorage.getItem("studyos-theme");if(storedTheme)document.documentElement.dataset.theme=storedTheme;}

      const themePreset=$("#theme-presets");
      if(themePreset){
        const savedPreset=localStorage.getItem("studyos-theme")||"midnight";
        themePreset.value=savedPreset;
        themePreset.addEventListener("change",()=>{
          document.documentElement.dataset.theme=themePreset.value;
          document.documentElement.removeAttribute("style");
          localStorage.setItem("studyos-theme",themePreset.value);
          localStorage.removeItem(STUDYOS_THEME_KEY);
          draftTheme={...defaultTheme};
          renderThemeStudio();
        });
      }

      // AI test history and score rewards preserve the existing provider/scoring.
      document.addEventListener("submit",event=>{
        if(event.target?.id==="ai-test-questions-form"){
          setTimeout(()=>{
            const scoreText=$("#ai-test-score")?.textContent||"";
            const match=/(\d+)\/(\d+)/.exec(scoreText);
            if(!match||!currentAITest)return;
            const obtained=Number(match[1]);
            const maximum=Number(match[2]);
            const history=safeJsonStorage(STUDYOS_AI_TEST_HISTORY_KEY,[]);
            const id=`ai-${currentAITest.title}-${maximum}-${Date.now()}`;
            const record={id,title:currentAITest.title,subject:$("#ai-test-subject")?.value||"Mixed",completedAt:new Date().toISOString(),score:obtained,maxScore:maximum,percentage:maximum?Math.round(obtained/maximum*100):0,accuracy:maximum?Math.round(obtained/maximum*100):0,timeSpentSeconds:0};
            const next=Array.isArray(history)?[record,...history].slice(0,100):[record];
            localStorage.setItem(STUDYOS_AI_TEST_HISTORY_KEY,JSON.stringify(next));
            awardXP(id,Math.max(20,Math.round(record.percentage/4)));
            renderLeaderboard();
          },0);
        }
      });

      const originalRenderAITest = typeof renderAITest==="function"?renderAITest:null;

      renderThemeStudio();
      const progress=getStudyProgress();
      if(profileInput) profileInput.value=progress.profile.name;
      renderXPAndAchievements();
      renderLeaderboard();
      syncSharedLeaderboard();


taskForm?.addEventListener("submit", (event) => {
  event.preventDefault();

  const title = taskTitleInput.value.trim();

  if (!title) {
    taskMessage.textContent = "Please enter a task first.";
    taskTitleInput.focus();
    return;
  }

  studyTasks.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    subject: taskSubjectInput.value,
    priority: taskPriorityInput.value,
    completed: false,
    createdAt: new Date().toISOString()
  });

  saveStudyTasks();
  currentTaskFilter = "all";

  taskFilters.forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === "all");
  });

  taskForm.reset();
  taskMessage.textContent = "Task added successfully!";
  renderStudyTasks();
});

taskFilters.forEach((button) => {
  button.addEventListener("click", () => {
    currentTaskFilter = button.dataset.filter;

    taskFilters.forEach((filterButton) => {
      filterButton.classList.toggle("active", filterButton === button);
    });

    renderStudyTasks();
  });
});

renderStudyTasks();
renderHomeAnalytics();
renderAnalytics();

// ---------- Learning Studio: durable, account-synced study tools ----------
const STUDIO_KEY = "studyos-learning-studio-v1";
function studioRead() {
  try { return JSON.parse(localStorage.getItem(STUDIO_KEY) || "null") || {}; } catch { return {}; }
}
let studioData = studioRead();
function studioSave() { localStorage.setItem(STUDIO_KEY, JSON.stringify(studioData)); if (currentAuthAccount) syncStudyOSAccount(); }
function studioList(key) { return Array.isArray(studioData[key]) ? studioData[key] : (studioData[key] = []); }
function studioId() { return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`; }
function saveStudyMistake(item) {
  if (!item || !item.question) return;
  const list = studioList("mistakes");
  const normalized = String(item.question).trim().toLowerCase();
  const found = list.find((saved) => String(saved.question).trim().toLowerCase() === normalized);
  if (found) { found.repeated = (found.repeated || 1) + 1; found.lastSeen = new Date().toISOString(); }
  else list.unshift({ id: studioId(), ...item, repeated: 1, createdAt: new Date().toISOString(), lastSeen: new Date().toISOString(), retried: 0 });
  studioSave();
}
function studioEsc(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char])); }
function studioChapters(subject) { const key = subject === "Mathematics" ? "Maths" : subject; return (libraryData[key] || []).map((item) => item.name); }
function studioSubjectSelect(id = "studio-subject") { return `<select id="${id}"><option>Physics</option><option>Chemistry</option><option>Mathematics</option></select>`; }
function renderStudio(tab = document.querySelector(".studio-tab.active")?.dataset.studio || "pulse") {
  const out = $("#studio-content"); if (!out) return;
  document.querySelectorAll(".studio-tab").forEach((button) => button.classList.toggle("active", button.dataset.studio === tab));
  const dueCards = studioList("cards").filter((card) => !card.dueAt || Date.parse(card.dueAt) <= Date.now());
  if (tab === "pulse") {
    out.innerHTML = `<div class="studio-grid"><form id="pulse-form" class="panel studio-panel"><p class="eyebrow">PULSE · ACTIVE RECALL</p><h2>Create flashcards</h2><label>Subject ${studioSubjectSelect("pulse-subject")}</label><label>Chapter<input id="pulse-chapter" placeholder="e.g. Work, Energy and Power" maxlength="100"></label><label>Question<input id="pulse-question" required maxlength="500" placeholder="What does the work-energy theorem state?"></label><label>Answer<textarea id="pulse-answer" required maxlength="1500" rows="3" placeholder="The net work done equals the change in kinetic energy."></textarea></label><button class="primary-button">Add flashcard</button><p class="muted small">Add cards manually, or paste study notes to create draft cards from sentence pairs.</p></form><section class="panel studio-panel"><p class="eyebrow">DUE FOR REVIEW</p><h2>${dueCards.length} cards</h2><div id="pulse-review">${dueCards.length ? `<article class="flashcard" data-card="${studioEsc(dueCards[0].id)}"><p class="muted">${studioEsc(dueCards[0].subject)} · ${studioEsc(dueCards[0].chapter || "General")}</p><h3>${studioEsc(dueCards[0].question)}</h3><details><summary>Reveal answer</summary><p>${studioEsc(dueCards[0].answer)}</p></details><div class="button-row"><button class="secondary-button" data-rate="hard" data-id="${studioEsc(dueCards[0].id)}">Difficult</button><button class="secondary-button" data-rate="good" data-id="${studioEsc(dueCards[0].id)}">Got it</button><button class="secondary-button" data-bookmark="${studioEsc(dueCards[0].id)}">☆</button></div></article>` : `<p class="muted">No cards due. Add cards or take a break.</p>`}</div></section></div><form id="pulse-import" class="panel studio-panel"><h3>Draft cards from notes</h3><p class="muted">Paste notes below. StudyOS will turn complete sentences into editable recall prompts on this device.</p><textarea id="pulse-notes" rows="4" placeholder="Paste your notes…"></textarea><button class="secondary-button">Create draft cards</button></form><div class="studio-stats"><span>${studioList("cards").length} total</span><span>${studioList("cards").filter((card) => card.mastered).length} mastered</span><span>${studioList("cards").filter((card) => card.bookmarked).length} bookmarked</span></div>`;
  } else if (tab === "orbit") {
    const pending = typeof studyTasks !== "undefined" ? studyTasks.filter((task) => !task.completed) : [];
    out.innerHTML = `<section class="panel studio-panel"><p class="eyebrow">ORBIT · SMART STUDY PLANNER</p><h2>Build a realistic study plan</h2><p class="muted">Uses your pending StudyOS tasks and the available time you set.</p><form id="orbit-form" class="studio-form"><label>Study hours available today<input id="orbit-hours" type="number" min="1" max="16" value="3" required></label><button class="primary-button">Generate today's plan</button></form><div id="orbit-plan">${(studioData.plan || []).map((entry, index) => `<label class="plan-row"><input type="checkbox" data-plan-done="${index}" ${entry.done ? "checked" : ""}><span><strong>${studioEsc(entry.title)}</strong><small>${studioEsc(entry.subject)} · ${entry.minutes} min</small></span><button type="button" class="secondary-button" data-plan-edit="${index}">Edit</button></label>`).join("") || `<p class="muted">Your generated plan will appear here.</p>`}</div></section>`;
  } else if (tab === "mistakes") {
    const mistakes = studioList("mistakes");
    out.innerHTML = `<section class="panel studio-panel"><p class="eyebrow">MISTAKE NOTEBOOK</p><h2>Learn from every attempt</h2><div class="studio-filters"><select id="mistake-subject"><option value="">All subjects</option><option>Physics</option><option>Chemistry</option><option>Mathematics</option></select><input id="mistake-chapter" placeholder="Filter by chapter"></div><div id="mistake-list">${mistakes.map((item) => `<article class="mistake-row"><h3>${studioEsc(item.question)}</h3><p class="muted">${studioEsc(item.subject)} · ${studioEsc(item.chapter)} · ${studioEsc(item.difficulty)} · ${studioEsc(item.source)} · repeated ${item.repeated}×</p><p>Your answer: ${studioEsc(item.selectedAnswer)}<br>Correct: ${studioEsc(item.correctAnswer)}</p><details><summary>Explanation</summary><p>${studioEsc(item.explanation)}</p></details><div class="button-row"><button class="secondary-button" data-retry="${studioEsc(item.id)}">Retry</button><button class="secondary-button" data-ask-mistake="${studioEsc(item.id)}">Ask NOVA</button></div></article>`).join("") || `<p class="muted">Incorrect answers from VECTRA and VECTRA Practice or Mock Exam sessions will be saved here.</p>`}</div></section>`;
  } else if (tab === "mastery") {
    const attempts = safeJsonStorage("studyos-test-attempts", []);
    const byChapter = new Map();
    attempts.forEach((attempt) => (attempt.chapters || [attempt.chapter]).filter(Boolean).forEach((chapter) => { const row = byChapter.get(chapter) || { count: 0, accuracy: 0 }; row.count++; row.accuracy += Number(attempt.accuracy || 0); byChapter.set(chapter, row); }));
    const rows = [...byChapter].sort((a,b) => a[1].accuracy / a[1].count - b[1].accuracy / b[1].count);
    out.innerHTML = `<section class="panel studio-panel"><p class="eyebrow">CHAPTER MASTERY</p><h2>Evidence from your real practice</h2><p class="muted">Based on completed VECTRA and practice attempts saved on this account.</p>${rows.map(([chapter, row]) => `<article class="mastery-row"><span><strong>${studioEsc(chapter)}</strong><small>${row.count} attempt${row.count === 1 ? "" : "s"}</small></span><strong>${Math.round(row.accuracy / row.count)}% accuracy</strong></article>`).join("") || `<p class="muted">Complete a practice or test attempt to begin chapter tracking.</p>`}</section>`;
  } else if (tab === "formulas") {
    const formulaEntries = [{subject:"Physics",chapter:"Work, Energy and Power",topic:"Work-energy theorem",formula:"Wₙₑₜ = ΔK"},{subject:"Physics",chapter:"Motion in a Straight Line",topic:"Uniform acceleration",formula:"v² = u² + 2as"},{subject:"Chemistry",chapter:"Some Basic Concepts of Chemistry",topic:"Amount of substance",formula:"n = m / M"},{subject:"Mathematics",chapter:"Quadratic Equations",topic:"Quadratic formula",formula:"x = (−b ± √(b² − 4ac)) / 2a"}];
    const query = (studioData.formulaQuery || "").toLowerCase(); const filtered = formulaEntries.filter((f) => `${f.subject} ${f.chapter} ${f.topic} ${f.formula}`.toLowerCase().includes(query));
    out.innerHTML = `<section class="panel studio-panel"><p class="eyebrow">FORMULA VAULT</p><h2>Find the relationship you need</h2><input id="formula-search" type="search" value="${studioEsc(studioData.formulaQuery || "")}" placeholder="Search formulas, topics or chapters">${filtered.map((formula) => `<article class="formula-row"><span><small>${studioEsc(formula.subject)} · ${studioEsc(formula.chapter)}</small><strong>${studioEsc(formula.topic)}</strong><code>${studioEsc(formula.formula)}</code></span><button class="secondary-button" data-formula-bookmark="${studioEsc(formula.topic)}">${(studioList("formulaBookmarks")).includes(formula.topic) ? "★" : "☆"}</button></article>`).join("") || `<p class="muted">No matching formulas in the starter library.</p>`}<p class="muted small">Starter entries are curated examples. Expand the vault with your own saved notes.</p></section>`;
  } else if (tab === "lumen") {
    out.innerHTML = `<section class="panel studio-panel"><p class="eyebrow">LUMEN · AI NOTES STUDIO</p><h2>Turn your notes into a study guide</h2><p class="muted">Uses the configured secure NOVA backend. Paste text from your notes or supported documents.</p><label>Notes or source text<textarea id="lumen-source" rows="8" maxlength="12000" placeholder="Paste your notes here…"></textarea></label><label>Output style<select id="lumen-mode"><option>Concise revision notes</option><option>Concept summary</option><option>Formula sheet</option><option>Mind map outline</option></select></label><div class="button-row"><button id="lumen-generate" class="primary-button" type="button">Generate with LUMEN</button><button id="lumen-save" class="secondary-button" type="button">Save result</button></div><div id="lumen-result" class="lumen-result">${studioEsc(studioData.lumenResult || "Your generated notes will appear here.")}</div><div id="lumen-saved">${studioList("notes").map((note) => `<article class="mastery-row"><strong>${studioEsc(note.title)}</strong><small>${studioEsc(note.savedAt)}</small></article>`).join("")}</div></section>`;
  } else if (tab === "nexus") {
    const chapters = Object.entries(libraryData).flatMap(([subject, items]) => items.filter((item) => item.syllabusScope === "included").map((item) => ({ subject: subject === "Maths" ? "Mathematics" : subject, chapter: item.name, topics: item.topics || [] })));
    const query = (studioData.nexusQuery || "").toLowerCase();
    const visible = chapters.filter((item) => `${item.subject} ${item.chapter} ${item.topics.join(" ")}`.toLowerCase().includes(query));
    out.innerHTML = `<section class="panel studio-panel"><p class="eyebrow">NEXUS · KNOWLEDGE MAP</p><h2>Explore your learning landscape</h2><p class="muted">Browse StudyOS chapters and listed topics. Chapter order follows the supplied syllabus inventory; it is not a verified prerequisite sequence.</p><input id="nexus-search" type="search" value="${studioEsc(studioData.nexusQuery || "")}" placeholder="Find a subject, chapter or concept"><div class="nexus-map">${visible.map((item) => `<article class="nexus-node"><small>${studioEsc(item.subject)}</small><h3>${studioEsc(item.chapter)}</h3><div class="nexus-topics">${item.topics.map((topic) => `<span>${studioEsc(topic)}</span>`).join("")}</div></article>`).join("") || `<p class="muted">No matching concepts found.</p>`}</div></section>`;
  } else if (tab === "exams") {
    const officialItems = testBank.flatMap((test) => (test.questions || []).map((question) => ({test, question}))).filter(({test, question}) => test.official === true && Number.isInteger(Number(test.year || question.year)) && test.source);
    out.innerHTML = `<section class="panel studio-panel"><p class="eyebrow">EXAM PREPARATION</p><h2>Verified questions and timed practice</h2><p class="muted">Items are identified as official PYQs only when the imported data includes a source and year.</p><div class="studio-grid"><article class="panel"><h3>PYQ Explorer</h3><p>${officialItems.length ? `${officialItems.length} sourced question(s) are available.` : "No verified official PYQs are present in the current question bank."}</p><p class="muted">The available Work, Energy and Power set identifies its items as original practice, so they are not shown as PYQs.</p></article><article class="panel"><h3>Mock Exam Simulator</h3><p>Use the existing VECTRA engine for timed exams, question navigation, marking and scoring.</p><button type="button" class="primary-button" id="studio-open-mock">Open mock exam setup</button></article></div></section>`;
  } else {
    out.innerHTML = `<section class="panel studio-panel"><p class="eyebrow">ECHO · VOICE LEARNING</p><h2>Ask aloud. Learn your way.</h2><p class="muted">Voice recognition and playback are provided by your browser. Your question goes to the secure NOVA endpoint; no API credentials are stored here.</p><label>Question<textarea id="echo-question" rows="3" placeholder="Your spoken or typed academic question"></textarea></label><div class="button-row"><button id="echo-listen" class="secondary-button" type="button">🎙 Start voice input</button><button id="echo-ask" class="primary-button" type="button">Ask ECHO</button><button id="echo-stop" class="secondary-button" type="button">Stop playback</button></div><div id="echo-answer" class="lumen-result">Text explanations will appear here.</div></section>`;
  }
}
function studioAsk(question, mode) {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  return fetch("/api/doubt", { method:"POST", headers:{"Content-Type":"application/json", ...(token ? {Authorization:`Bearer ${token}`} : {})}, body:JSON.stringify({userId:localStorage.getItem(DOUBT_USER_KEY) || "learning-studio", conversationId:"learning-studio", question, subject:"Physics", chapter:"", mode, history:[], images:[]}) }).then(async (response) => { const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || "AI request failed"); return data.answer; });
}
document.querySelectorAll(".studio-tab").forEach((button) => button.addEventListener("click", () => {
  renderStudio(button.dataset.studio);
  $$("#more-menu [data-studio]").forEach((item) => {
    item.classList.toggle("active", item.dataset.studio === button.dataset.studio);
  });
}));
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button"); if (!button) return;
  if (button.matches("[data-rate]")) { const card = studioList("cards").find((item) => item.id === button.dataset.id); if (card) { card.reviews = (card.reviews || 0) + 1; card.difficult = button.dataset.rate === "hard"; card.mastered = !card.difficult && card.reviews >= 3; card.dueAt = new Date(Date.now() + (card.difficult ? 1 : card.mastered ? 14 : 3) * 86400000).toISOString(); studioSave(); renderStudio("pulse"); } }
  if (button.matches("[data-bookmark]")) { const card = studioList("cards").find((item) => item.id === button.dataset.bookmark); if (card) { card.bookmarked = !card.bookmarked; studioSave(); renderStudio("pulse"); } }
  if (button.matches("[data-formula-bookmark]")) { const list = studioList("formulaBookmarks"), topic = button.dataset.formulaBookmark; studioData.formulaBookmarks = list.includes(topic) ? list.filter((item) => item !== topic) : [...list, topic]; studioSave(); renderStudio("formulas"); }
  if (button.matches("[data-retry]")) { const item = studioList("mistakes").find((mistake) => mistake.id === button.dataset.retry); if (item) { const answer = window.prompt(`${item.question}\n\nYour answer:`); if (answer !== null) { item.retried = (item.retried || 0) + 1; item.lastRetry = answer; studioSave(); } } }
  if (button.matches("[data-ask-mistake]")) { const item = studioList("mistakes").find((mistake) => mistake.id === button.dataset.askMistake); if (item) { localStorage.setItem("studyos-studio-nova-prompt", `Explain this saved mistake. Question: ${item.question}. My answer: ${item.selectedAnswer}. Correct answer: ${item.correctAnswer}. ${item.explanation}`); showScreen("ai-doubts"); setTimeout(() => { const input = $("#doubt-input"); if (input) input.value = localStorage.getItem("studyos-studio-nova-prompt"); localStorage.removeItem("studyos-studio-nova-prompt"); }, 100); } }
  if (button.matches("#lumen-generate")) { const source = $("#lumen-source").value.trim(), result = $("#lumen-result"); if (!source) { result.textContent = "Paste your notes first."; return; } button.disabled = true; result.textContent = "LUMEN is preparing your notes…"; try { const answer = await studioAsk(`Create ${$("#lumen-mode").value} from these student notes. Do not add unsupported facts.\n\n${source}`, "normal"); studioData.lumenResult = answer; studioSave(); result.textContent = answer; } catch (error) { result.textContent = error.message; } finally { button.disabled = false; } }
  if (button.matches("#lumen-save")) { const answer = studioData.lumenResult; if (answer) { studioList("notes").unshift({title:$("#lumen-mode").value, content:answer, savedAt:new Date().toLocaleString()}); studioSave(); renderStudio("lumen"); } }
  if (button.matches("#echo-ask")) { const question = $("#echo-question").value.trim(), answer = $("#echo-answer"); if (!question) { answer.textContent = "Ask a question first."; return; } button.disabled = true; answer.textContent = "ECHO is thinking…"; try { const response = await studioAsk(question, "normal"); answer.textContent = response; if ("speechSynthesis" in window) { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(response)); } } catch (error) { answer.textContent = error.message; } finally { button.disabled = false; } }
  if (button.matches("#echo-listen")) { const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition; if (!Recognition) { $("#echo-answer").textContent = "Voice input is not supported by this browser. Type your question instead."; return; } const recognition = new Recognition(); recognition.lang = "en-US"; recognition.onresult = (result) => { $("#echo-question").value = result.results[0][0].transcript; }; recognition.onerror = () => { $("#echo-answer").textContent = "Microphone access failed or was denied. Check browser permissions or type your question."; }; recognition.start(); }
  if (button.matches("#echo-stop")) window.speechSynthesis?.cancel();
  if (button.matches("#studio-open-mock")) showScreen("testlab");
  if (button.matches("[data-plan-edit]")) { const i = Number(button.dataset.planEdit), old = studioData.plan[i]; const title = window.prompt("Edit study session", old?.title || ""); if (title) { old.title = title; studioSave(); renderStudio("orbit"); } }
});
document.addEventListener("submit", (event) => {
  if (event.target.matches("#pulse-form")) { event.preventDefault(); studioList("cards").unshift({id:studioId(), subject:$("#pulse-subject").value, chapter:$("#pulse-chapter").value.trim(), question:$("#pulse-question").value.trim(), answer:$("#pulse-answer").value.trim(), reviews:0, mastered:false, bookmarked:false, dueAt:new Date().toISOString()}); studioSave(); renderStudio("pulse"); }
  if (event.target.matches("#pulse-import")) { event.preventDefault(); const subject = $("#pulse-subject")?.value || "Physics", lines = $("#pulse-notes").value.split(/[.!?\n]+/).map((line) => line.trim()).filter((line) => line.length > 35); lines.slice(0, 12).forEach((line) => studioList("cards").unshift({id:studioId(),subject,chapter:"Imported notes",question:`Recall: ${line.slice(0,90)}${line.length > 90 ? "…" : ""}`,answer:line,reviews:0,mastered:false,bookmarked:false,dueAt:new Date().toISOString()})); studioSave(); renderStudio("pulse"); }
  if (event.target.matches("#orbit-form")) { event.preventDefault(); const hours = Number($("#orbit-hours").value), available = Math.max(30, hours * 60), pending = (typeof studyTasks !== "undefined" ? studyTasks.filter((task) => !task.completed) : []); const plan = []; let remaining = available; pending.slice().sort((a,b) => (b.priority === "high") - (a.priority === "high")).forEach((task) => { if (remaining >= 25) { plan.push({title:task.title,subject:task.subject,minutes:Math.min(50,remaining),done:false}); remaining -= Math.min(50,remaining); } }); if (!plan.length) plan.push({title:"Review your weakest chapter",subject:"Physics",minutes:Math.min(45,remaining),done:false}); studioData.plan = plan; studioSave(); renderStudio("orbit"); }
});
document.addEventListener("change", (event) => {
  if (event.target.id === "formula-search") { studioData.formulaQuery = event.target.value; renderStudio("formulas"); const field = $("#formula-search"); field?.focus(); field?.setSelectionRange(field.value.length,field.value.length); }
  if (event.target.id === "nexus-search") { studioData.nexusQuery = event.target.value; renderStudio("nexus"); const field = $("#nexus-search"); field?.focus(); field?.setSelectionRange(field.value.length,field.value.length); }
  if (event.target.matches("[data-plan-done]")) { studioData.plan[Number(event.target.dataset.planDone)].done = event.target.checked; studioSave(); }
});
const previousShowScreen = showScreen;
showScreen = function(screenId) { previousShowScreen(screenId); if (screenId === "learning-studio") renderStudio(); };
