"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const DATA_DIR = process.env.STUDYOS_DATA_DIR
  ? path.resolve(process.env.STUDYOS_DATA_DIR)
  : path.join(ROOT, ".data");
const PORT = Number(process.env.PORT || 4173);
const MAX_REQUEST_BYTES = Number(process.env.AI_MAX_REQUEST_BYTES || 5 * 1024 * 1024);
const MAX_CONCURRENT_REQUESTS = Number(process.env.AI_MAX_CONCURRENT_REQUESTS || 8);
const MAX_CONCURRENT_PER_USER = Number(process.env.AI_MAX_CONCURRENT_PER_USER || 2);
const RATE_LIMIT_REQUESTS = Number(process.env.AI_RATE_LIMIT_REQUESTS || 20);
const RATE_LIMIT_WINDOW_MS = Number(process.env.AI_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS || 45 * 1000);
const AI_RETRY_COUNT = Number(process.env.AI_RETRY_COUNT || 2);
const AI_API_URL = process.env.AI_API_URL || "https://api.openai.com/v1/chat/completions";
const AI_API_KEY = process.env.AI_API_KEY || "";
const configuredModel = process.env.AI_MODEL || "gpt-4o-mini";
const AI_MODEL = configuredModel === "gemini-2.5-flash-lite"
  ? "gemini-3.5-flash-lite"
  : configuredModel;
const AI_PROVIDER_NAME = process.env.AI_PROVIDER_NAME || "OpenAI-compatible";

const userSlots = new Map();
const rateWindows = new Map();
let globalActiveRequests = 0;

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

function migrateRuntimeData(filename) {
  const legacyPath = path.join(ROOT, filename);
  const privatePath = path.join(DATA_DIR, filename);
  if (filename === "session-data.json") {
    if (!fs.existsSync(privatePath)) {
      fs.writeFileSync(privatePath, JSON.stringify({ sessions: [] }, null, 2), { mode: 0o600 });
    }
    fs.chmodSync(privatePath, 0o600);
    if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
    return;
  }
  if (filename === "device-data.json") {
    if (!fs.existsSync(privatePath)) {
      fs.writeFileSync(privatePath, JSON.stringify({ devices: [] }, null, 2), { mode: 0o600 });
    }
    fs.chmodSync(privatePath, 0o600);
    if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
    return;
  }
  if (fs.existsSync(legacyPath) && !fs.existsSync(privatePath)) {
    fs.renameSync(legacyPath, privatePath);
    fs.chmodSync(privatePath, 0o600);
  } else if (fs.existsSync(legacyPath)) {
    fs.unlinkSync(legacyPath);
  }
}

["auth-data.json", "session-data.json", "device-data.json", "account-data.json", "leaderboard-data.json"]
  .forEach(migrateRuntimeData);

const usage = {
  requests: 0,
  successes: 0,
  failures: 0,
  busy: 0,
  quota: 0,
  inputTokens: 0,
  outputTokens: 0
};

const authPath = path.join(DATA_DIR, "auth-data.json");
const sessionPath = path.join(DATA_DIR, "session-data.json");
const devicePath = path.join(DATA_DIR, "device-data.json");
const accounts = new Map();
const sessions = new Map();
const deviceBindings = new Map();

try {
  if (fs.existsSync(authPath)) {
    const saved = JSON.parse(fs.readFileSync(authPath, "utf8"));
    if (Array.isArray(saved.accounts)) {
      saved.accounts.forEach((account) => {
        if (account?.id && account?.username && account?.passwordHash && account?.passwordSalt) {
          accounts.set(account.username.toLowerCase(), account);
        }
      });
    }
  }
} catch (error) {
  console.error("Unable to load account data:", error.message);
}

try {
  if (fs.existsSync(sessionPath)) {
    const saved = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    if (Array.isArray(saved.sessions)) {
      saved.sessions.forEach((session) => {
        if (session?.token && session?.accountId && session?.expiresAt > Date.now()) {
          sessions.set(session.token, session);
        }
      });
    }
  }
} catch (error) {
  console.error("Unable to load sessions:", error.message);
}

function saveSessions() {
  const entries = [...sessions.entries()].map(([token, session]) => ({ token, ...session }));
  fs.writeFile(sessionPath, JSON.stringify({ sessions: entries }, null, 2), (error) => {
    if (error) {
      console.error("Unable to save sessions:", error.message);
    } else {
      fs.chmodSync(sessionPath, 0o600);
    }
  });
}

try {
  if (fs.existsSync(devicePath)) {
    const saved = JSON.parse(fs.readFileSync(devicePath, "utf8"));
    if (Array.isArray(saved.devices)) {
      saved.devices.forEach((device) => {
        if (device?.deviceId && device?.accountId) deviceBindings.set(device.deviceId, device.accountId);
      });
    }
  }
} catch (error) {
  console.error("Unable to load device bindings:", error.message);
}

function saveDeviceBindings() {
  const devices = [...deviceBindings.entries()].map(([deviceId, accountId]) => ({ deviceId, accountId }));
  fs.writeFile(devicePath, JSON.stringify({ devices }, null, 2), (error) => {
    if (error) {
      console.error("Unable to save device bindings:", error.message);
    } else {
      fs.chmodSync(devicePath, 0o600);
    }
  });
}

function bindDevice(deviceId, account) {
  if (!/^[a-f0-9]{32}$/i.test(deviceId)) return;
  deviceBindings.set(deviceId.toLowerCase(), account.id);
  saveDeviceBindings();
}

function saveAccounts() {
  fs.writeFile(authPath, JSON.stringify({ accounts: [...accounts.values()] }, null, 2), (error) => {
    if (error) {
      console.error("Unable to save account data:", error.message);
    } else {
      fs.chmodSync(authPath, 0o600);
    }
  });
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function createSession(account) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { accountId: account.id, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
  saveSessions();
  return token;
}

function bearerAccount(request) {
  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (session) sessions.delete(token);
    return null;
  }
  return [...accounts.values()].find((account) => account.id === session.accountId) || null;
}

const leaderboardPath = path.join(DATA_DIR, "leaderboard-data.json");
let sharedLeaderboard = new Map();

try {
  if (fs.existsSync(leaderboardPath)) {
    const saved = JSON.parse(fs.readFileSync(leaderboardPath, "utf8"));
    if (Array.isArray(saved.users)) {
      saved.users.forEach((user) => {
        if (typeof user?.id === "string" && user.id.length <= 80) {
          sharedLeaderboard.set(user.id, user);
        }
      });
    }
  }
} catch (error) {
  console.error("Unable to load shared leaderboard data:", error.message);
}

function saveSharedLeaderboard() {
  const users = [...sharedLeaderboard.values()];
  fs.writeFile(leaderboardPath, JSON.stringify({ users }, null, 2), (error) => {
    if (error) {
      console.error("Unable to save shared leaderboard data:", error.message);
    } else {
      fs.chmodSync(leaderboardPath, 0o600);
    }
  });
}

const accountDataPath = path.join(DATA_DIR, "account-data.json");
const accountData = new Map();
try {
  if (fs.existsSync(accountDataPath)) {
    const saved = JSON.parse(fs.readFileSync(accountDataPath, "utf8"));
    if (Array.isArray(saved.accounts)) {
      saved.accounts.forEach((entry) => {
        if (entry?.accountId) accountData.set(entry.accountId, entry);
      });
    }
  }
} catch (error) {
  console.error("Unable to load account data snapshots:", error.message);
}

function saveAccountData() {
  fs.writeFile(accountDataPath, JSON.stringify({ accounts: [...accountData.values()] }, null, 2), (error) => {
    if (error) {
      console.error("Unable to save account data snapshots:", error.message);
    } else {
      fs.chmodSync(accountDataPath, 0o600);
    }
  });
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  response.end(payload);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(Object.assign(new Error("Request is too large."), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON request."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function hashUserId(userId, request) {
  const source = `${userId}:${request.socket.remoteAddress || "unknown"}`;
  return crypto.createHash("sha256").update(source).digest("hex").slice(0, 16);
}

function isRateLimited(userKey) {
  const now = Date.now();
  const current = rateWindows.get(userKey);
  if (!current || now >= current.resetAt) {
    rateWindows.set(userKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  if (current.count >= RATE_LIMIT_REQUESTS) return true;
  current.count += 1;
  return false;
}

function pruneMaps() {
  const now = Date.now();
  for (const [key, value] of rateWindows) {
    if (now >= value.resetAt) rateWindows.delete(key);
  }
}
setInterval(pruneMaps, RATE_LIMIT_WINDOW_MS).unref();

function acquireSlots(userKey) {
  if (globalActiveRequests >= MAX_CONCURRENT_REQUESTS) return null;
  const userActive = userSlots.get(userKey) || 0;
  if (userActive >= MAX_CONCURRENT_PER_USER) return null;
  globalActiveRequests += 1;
  userSlots.set(userKey, userActive + 1);
  return () => {
    globalActiveRequests -= 1;
    const remaining = (userSlots.get(userKey) || 1) - 1;
    if (remaining > 0) userSlots.set(userKey, remaining);
    else userSlots.delete(userKey);
  };
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((item) => item && (item.role === "user" || item.role === "assistant"))
    .filter((item) => typeof item.content === "string" && item.content.trim())
    .slice(-12)
    .map((item) => ({
      role: item.role,
      content: item.content.slice(0, 4000)
    }));
}

function providerErrorDetails(responseStatus, providerBody) {
  const text = JSON.stringify(providerBody || {}).toLowerCase();
  if (responseStatus === 429 && /quota|billing|credits|insufficient/i.test(text)) {
    return {
      status: 429,
      message: "The AI provider quota is exhausted. Please wait and try again later."
    };
  }
  if (responseStatus === 429) {
    return {
      status: 429,
      message: "The AI provider is temporarily rate-limited. Please wait and try again."
    };
  }
  if (responseStatus >= 500) {
    return { status: 502, message: "The AI provider is temporarily unavailable. Please try again." };
  }
  return { status: 502, message: "The AI provider rejected the request. Check its configuration." };
}

async function callProvider(payload) {
  let lastError = null;

  for (let attempt = 0; attempt <= AI_RETRY_COUNT; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(AI_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${AI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const providerBody = await response.json().catch(() => null);
      if (!response.ok) {
        const providerText = JSON.stringify(providerBody || {}).toLowerCase();
        const quotaError = response.status === 429 &&
          /quota|billing|credits|insufficient/i.test(providerText);
        const temporaryError = response.status === 429
          ? !quotaError
          : response.status >= 500;
        if (temporaryError && attempt < AI_RETRY_COUNT) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const delay = Number.isFinite(retryAfter)
            ? Math.min(retryAfter * 1000, 5000)
            : Math.min(500 * 2 ** attempt, 3000);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        const details = providerErrorDetails(response.status, providerBody);
        throw Object.assign(new Error(details.message), {
          status: details.status,
          providerStatus: response.status
        });
      }

      const content = providerBody?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw Object.assign(new Error("The AI provider returned an empty response."), { status: 502 });
      }
      return {
        content,
        usage: providerBody.usage || null
      };
    } catch (error) {
      lastError = error;
      if (error.name === "AbortError") {
        throw Object.assign(new Error("The AI provider timed out. Please try again."), { status: 504 });
      }
      if (error.status) throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || Object.assign(new Error("The AI provider request failed."), { status: 502 });
}

async function handleAuthRegister(request, response) {
  try {
    const body = await readJsonBody(request);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 30) : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[a-z0-9_-]{3,30}$/.test(username)) {
      throw Object.assign(new Error("Use 3–30 letters, numbers, hyphen or underscore for your username."), { status: 400 });
    }
    if (password.length < 8 || password.length > 128) {
      throw Object.assign(new Error("Password must be 8–128 characters."), { status: 400 });
    }
    if (accounts.has(username)) {
      throw Object.assign(new Error("That username is already registered."), { status: 409 });
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const account = {
      id: crypto.randomBytes(16).toString("hex"),
      username,
      name: name || username,
      avatar: typeof body.avatar === "string" ? body.avatar.slice(0, 8) || "🎓" : "🎓",
      passwordSalt: salt,
      passwordHash: hashPassword(password, salt),
      role: accounts.size === 0 ? "owner" : "user",
      createdAt: new Date().toISOString()
    };
    accounts.set(username, account);
    saveAccounts();
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    bindDevice(deviceId, account);
    sendJson(response, 201, { token: createSession(account), account: { id: account.id, username, name: account.name, avatar: account.avatar, role: account.role } });
  } catch (error) {
    sendJson(response, error.status || 400, { error: error.message || "Registration failed." });
  }
}

async function handleAuthLogin(request, response) {
  try {
    const body = await readJsonBody(request);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const account = accounts.get(username);
    const candidateHash = account ? hashPassword(password, account.passwordSalt) : "";
    const candidateBuffer = Buffer.from(candidateHash, "hex");
    const storedBuffer = account ? Buffer.from(account.passwordHash, "hex") : Buffer.alloc(64);
    if (!account || candidateBuffer.length !== storedBuffer.length ||
        !crypto.timingSafeEqual(candidateBuffer, storedBuffer)) {
      throw Object.assign(new Error("Incorrect username or password."), { status: 401 });
    }
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    bindDevice(deviceId, account);
    sendJson(response, 200, { token: createSession(account), account: { id: account.id, username, name: account.name, avatar: account.avatar, role: account.role } });
  } catch (error) {
    sendJson(response, error.status || 400, { error: error.message || "Login failed." });
  }
}

function handleAuthMe(request, response) {
  const account = bearerAccount(request);
  if (!account) {
    sendJson(response, 401, { error: "Please log in again." });
    return;
  }
  sendJson(response, 200, { account: { id: account.id, username: account.username, name: account.name, avatar: account.avatar, role: account.role } });
}

async function handleDeviceLogin(request, response) {
  sendJson(response, 410, {
    error: "Passwordless device login is disabled. Sign in with your username and password."
  });
}

async function handleDeviceForget(request, response) {
  try {
    const account = bearerAccount(request);
    if (!account) {
      sendJson(response, 401, { error: "Please log in again." });
      return;
    }
    const body = await readJsonBody(request);
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.toLowerCase() : "";
    if (/^[a-f0-9]{32}$/.test(deviceId) && deviceBindings.get(deviceId) === account.id) {
      deviceBindings.delete(deviceId);
      saveDeviceBindings();
    }
    sendJson(response, 200, { forgotten: true });
  } catch (error) {
    sendJson(response, 400, { error: "Could not forget this device." });
  }
}

async function handleAccountSync(request, response) {
  const account = bearerAccount(request);
  if (!account) {
    sendJson(response, 401, { error: "Please log in again." });
    return;
  }
  try {
    const body = await readJsonBody(request);
    if (typeof body.name === "string") account.name = body.name.trim().slice(0, 30) || account.name;
    if (typeof body.avatar === "string") account.avatar = body.avatar.slice(0, 8) || account.avatar;
    if (accounts.has(account.username)) saveAccounts();

    const snapshot = body.data && typeof body.data === "object" ? body.data : {};
    accountData.set(account.id, {
      accountId: account.id,
      username: account.username,
      name: account.name,
      avatar: account.avatar,
      role: account.role,
      updatedAt: new Date().toISOString(),
      data: snapshot
    });
    saveAccountData();

    const progress = snapshot.progress || {};
    const tests = Array.isArray(snapshot.testAttempts) ? snapshot.testAttempts : [];
    sharedLeaderboard.set(account.id, {
      id: account.id,
      name: account.name,
      avatar: account.avatar,
      xp: Math.max(0, Number(progress.xp) || 0),
      tests,
      updatedAt: new Date().toISOString()
    });
    saveSharedLeaderboard();

    sendJson(response, 200, { synced: true, account: { id: account.id, username: account.username, name: account.name, avatar: account.avatar, role: account.role } });
  } catch (error) {
    sendJson(response, error.status || 400, { error: error.message || "Could not sync account data." });
  }
}

function handleAccountMe(request, response) {
  const account = bearerAccount(request);
  if (!account) {
    sendJson(response, 401, { error: "Please log in again." });
    return;
  }
  const snapshot = accountData.get(account.id) || null;
  sendJson(response, 200, {
    account: {
      id: account.id,
      username: account.username,
      name: account.name,
      avatar: account.avatar,
      role: account.role
    },
    snapshot
  });
}

function handleOwnerExport(request, response) {
  const account = bearerAccount(request);
  if (!account || account.role !== "owner") {
    sendJson(response, 403, { error: "Only the site owner can export all account data." });
    return;
  }
  const payload = {
    exportedAt: new Date().toISOString(),
    accounts: [...accounts.values()].map(({ passwordHash, passwordSalt, ...safe }) => safe),
    accountData: [...accountData.values()]
  };
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": "attachment; filename=\"studyos-account-export.json\"",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function contentType(filePath) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jsonl": "application/jsonl; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json"
  };
  return types[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function serveStatic(request, response, pathname) {
  const publicFiles = new Set([
    "index.html",
    "styles.css",
    "app.js",
    "manifest.json",
    "sw.js",
    "studyos_wep_jee_advanced_50.json",
    "library/jee-class11.js",
    "library/physics-chapter-notes.js"
  ]);
  let relativePath;
  try {
    relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    sendJson(response, 403, { error: "Forbidden." });
    return;
  }
  if (!publicFiles.has(relativePath)) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }
  const filePath = path.resolve(ROOT, relativePath);
  if (!filePath.startsWith(`${ROOT}${path.sep}`)) {
    sendJson(response, 403, { error: "Forbidden." });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": [".html", ".js", ".css", ".json"].includes(path.extname(filePath).toLowerCase())
        ? "no-cache, no-store, must-revalidate"
        : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });
    response.end(data);
  });
}

function handleLeaderboardGet(request, response, url) {
  const users = [...sharedLeaderboard.values()]
    .map((user) => ({
      id: user.id,
      name: String(user.name || "StudyOS User").slice(0, 30),
      avatar: String(user.avatar || "🎓").slice(0, 8),
      xp: Math.max(0, Number(user.xp) || 0),
      tests: Array.isArray(user.tests) ? user.tests.slice(0, 100).map((attempt) => ({
        id: String(attempt.id || ""),
        title: String(attempt.title || "Practice test").slice(0, 160),
        score: Math.max(0, Number(attempt.score) || 0),
        maxScore: Math.max(1, Number(attempt.maxScore) || 1),
        percentage: Math.max(0, Math.min(100, Number(attempt.percentage) || 0)),
        accuracy: Math.max(0, Math.min(100, Number(attempt.accuracy) || 0)),
        timeSpentSeconds: Math.max(0, Number(attempt.timeSpentSeconds) || 0),
        completedAt: typeof attempt.completedAt === "string" ? attempt.completedAt : null
      })) : [],
      updatedAt: user.updatedAt || null
    }))
    .sort((a, b) => b.xp - a.xp || String(a.name).localeCompare(String(b.name)));
  sendJson(response, 200, { users });
}

async function handleLeaderboardSync(request, response) {
  try {
    const account = bearerAccount(request);
    if (!account) {
      sendJson(response, 401, { error: "Please log in again." });
      return;
    }
    const body = await readJsonBody(request);
    const tests = Array.isArray(body.tests)
      ? body.tests.slice(0, 100).filter((attempt) => attempt && typeof attempt === "object")
      : [];
    sharedLeaderboard.set(account.id, {
      id: account.id,
      name: account.name,
      avatar: account.avatar,
      xp: Math.min(10000000, Math.max(0, Number(body.xp) || 0)),
      tests,
      updatedAt: new Date().toISOString()
    });
    saveSharedLeaderboard();
    handleLeaderboardGet(request, response);
  } catch (error) {
    sendJson(response, error.status || 400, { error: error.message || "Invalid leaderboard update." });
  }
}

async function handleDoubt(request, response) {
  let startedAt = Date.now();
  let userKey = "anonymous";
  usage.requests += 1;

  try {
    const body = await readJsonBody(request);
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const subject = ["Physics", "Chemistry", "Mathematics"].includes(body.subject)
      ? body.subject
      : "Physics";
    const chapter = typeof body.chapter === "string" ? body.chapter.slice(0, 120) : "";
    const mode = ["normal", "hint", "simple"].includes(body.mode) ? body.mode : "normal";
    const images = Array.isArray(body.images) ? body.images.slice(0, 2) : [];

    if (!/^[A-Za-z0-9_-]{8,80}$/.test(userId) ||
        !/^[A-Za-z0-9_-]{8,80}$/.test(conversationId)) {
      throw Object.assign(new Error("A valid user and conversation ID is required."), { status: 400 });
    }
    if (!question && images.length === 0) {
      throw Object.assign(new Error("Ask a question or attach an image."), { status: 400 });
    }
    if (question.length > 4000) {
      throw Object.assign(new Error("Question is too long. Use 4000 characters or fewer."), { status: 413 });
    }

    userKey = hashUserId(userId, request);
    if (isRateLimited(userKey)) {
      usage.failures += 1;
      throw Object.assign(new Error("You have sent too many requests. Please wait before trying again."), { status: 429 });
    }

    const release = acquireSlots(userKey);
    if (!release) {
      usage.busy += 1;
      usage.failures += 1;
      throw Object.assign(new Error("StudyOS is busy serving AI requests. Please retry in a moment."), { status: 503 });
    }

    try {
      if (!AI_API_KEY) {
        throw Object.assign(new Error(
          "AI is not configured yet. Set AI_API_KEY on the server and restart StudyOS."
        ), { status: 503 });
      }

      const instructionParts = [
        "You are a patient JEE study tutor.",
        `Subject: ${subject}.`,
        chapter ? `Chapter: ${chapter}.` : "Chapter: not specified.",
        "Use this structure when relevant: Concept, Given information, Approach, Step-by-step solution, Final answer, Common mistakes.",
        "Use readable mathematical notation with $...$ for inline expressions and $$...$$ for display equations.",
        "Do not claim to be an official JEE solution or previous-year answer.",
        mode === "hint" ? "Give only a useful hint first. Do not reveal the final solution." :
        mode === "simple" ? "Explain more simply, with shorter sentences and one clear example." :
        "Explain accurately and step by step."
      ];

      const history = sanitizeHistory(body.history);
      const userParts = [{ type: "text", text: question || "Please analyze the attached question image." }];
      for (const image of images) {
        if (typeof image.dataUrl === "string" &&
            /^data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(image.dataUrl) &&
            image.dataUrl.length <= 3 * 1024 * 1024) {
          userParts.push({ type: "image_url", image_url: { url: image.dataUrl.slice(0, 3 * 1024 * 1024) } });
        }
      }

      const messages = [
        { role: "system", content: instructionParts.join("\n") },
        ...history,
        { role: "user", content: userParts.length === 1 ? userParts[0].text : userParts }
      ];

      const result = await callProvider({
        model: AI_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 1800
      });

      if (result.usage?.prompt_tokens) usage.inputTokens += result.usage.prompt_tokens;
      if (result.usage?.completion_tokens) usage.outputTokens += result.usage.completion_tokens;
      usage.successes += 1;

      console.log(JSON.stringify({
        event: "ai_doubt_request",
        user: userKey,
        conversation: crypto.createHash("sha256").update(conversationId).digest("hex").slice(0, 12),
        status: 200,
        latencyMs: Date.now() - startedAt,
        subject,
        imageCount: userParts.length - 1,
        promptChars: question.length,
        provider: AI_PROVIDER_NAME
      }));

      sendJson(response, 200, { answer: result.content, provider: AI_PROVIDER_NAME });
    } finally {
      release();
    }
  } catch (error) {
    if (error.status !== 429) usage.failures += 1;
    if (error.status === 429 && /quota|credits|billing/i.test(error.message || "")) usage.quota += 1;
    console.log(JSON.stringify({
      event: "ai_doubt_request",
      user: userKey,
      status: error.status || 500,
      latencyMs: Date.now() - startedAt
    }));
    sendJson(response, error.status || 500, { error: error.message || "Unexpected server error." });
  }
}

function parseAITestJson(content) {
  const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  const jsonText = firstBrace >= 0 && lastBrace > firstBrace
    ? cleaned.slice(firstBrace, lastBrace + 1)
    : cleaned;

  let inString = false;
  let escaped = false;
  const normalized = [];
  for (let index = 0; index < jsonText.length; index += 1) {
    const character = jsonText[index];
    if (escaped) {
      normalized.push(character);
      escaped = false;
      continue;
    }
    if (character === "\\") {
      const next = jsonText[index + 1];
      if (inString && !["\"", "\\", "/", "b", "f", "n", "r", "t", "u"].includes(next)) {
        normalized.push("\\", "\\");
      } else {
        normalized.push(character);
        escaped = true;
      }
      continue;
    }
    if (character === "\"") {
      inString = !inString;
      normalized.push(character);
      continue;
    }
    if (inString && character === "\n") normalized.push("\\", "n");
    else if (inString && character === "\r") normalized.push("\\", "r");
    else if (inString && character === "\t") normalized.push("\\", "t");
    else normalized.push(character);
  }
  return JSON.parse(normalized.join(""));
}

async function handleAITest(request, response) {
  let startedAt = Date.now();
  let userKey = "anonymous";
  usage.requests += 1;

  try {
    const body = await readJsonBody(request);
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const subject = ["Physics", "Chemistry", "Mathematics"].includes(body.subject)
      ? body.subject
      : "Physics";
    const chapter = typeof body.chapter === "string" ? body.chapter.slice(0, 120) : "";
    const difficulty = ["JEE Main", "JEE Advanced", "Mixed"].includes(body.difficulty)
      ? body.difficulty
      : "JEE Main";
    const count = Number(body.count);

    if (!/^[A-Za-z0-9_-]{8,80}$/.test(userId)) {
      throw Object.assign(new Error("A valid user ID is required."), { status: 400 });
    }
    if (!chapter) {
      throw Object.assign(new Error("Choose a chapter before generating a test."), { status: 400 });
    }
    if (![5, 10].includes(count)) {
      throw Object.assign(new Error("Choose 5 or 10 questions."), { status: 400 });
    }

    userKey = hashUserId(userId, request);
    if (isRateLimited(userKey)) {
      usage.failures += 1;
      throw Object.assign(new Error("You have requested too many AI tests. Please wait and try again."), { status: 429 });
    }

    const release = acquireSlots(userKey);
    if (!release) {
      usage.busy += 1;
      usage.failures += 1;
      throw Object.assign(new Error("StudyOS is busy serving AI requests. Please retry in a moment."), { status: 503 });
    }

    try {
      if (!AI_API_KEY) {
        throw Object.assign(new Error(
          "AI is not configured yet. Set AI_API_KEY on the server and restart StudyOS."
        ), { status: 503 });
      }

      const systemPrompt = [
        "You create original JEE-style multiple-choice practice tests.",
        "Return only valid JSON with no markdown or commentary.",
        "Use this exact shape:",
        '{"title":"...","questions":[{"id":1,"topic":"...","question":"...","options":["A...","B...","C...","D..."],"correctIndex":0,"explanation":"...","difficulty":"JEE Main"}]}',
        "Use LaTeX notation inside strings with $...$ and $$...$$.",
        "Make distractors plausible and explanations concise.",
        "Include a concise topic label for every question to support student performance insights.",
        "Escape every backslash in LaTeX as required by JSON.",
        "Keep explanations to two short sentences.",
        "Never stop before the required question count.",
        "correctIndex must be an integer from 0 to 3.",
        "Do not claim the questions are from an official exam or previous-year paper."
      ].join("\n");

      const userPrompt = [
        `Subject: ${subject}`,
        `Chapter: ${chapter}`,
        `Difficulty: ${difficulty}`,
        `Create exactly ${count} unique questions.`
      ].join("\n");

      let result = null;
      let testData = null;
      let formatFailure = null;
      const generationAttempts = 3;

      for (let attempt = 1; attempt <= generationAttempts && !testData; attempt += 1) {
        try {
          result = await callProvider({
            model: AI_MODEL,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: `${userPrompt}\n\nGeneration attempt: ${attempt} of ${generationAttempts}. Keep every value concise and return complete valid JSON.` }
            ],
            temperature: attempt === 1 ? 0.35 : 0.15,
            max_tokens: count === 10 ? 8000 : 5000
          });
          if (result.usage?.prompt_tokens) usage.inputTokens += result.usage.prompt_tokens;
          if (result.usage?.completion_tokens) usage.outputTokens += result.usage.completion_tokens;

          const parsed = parseAITestJson(result.content);
          if (!Array.isArray(parsed.questions) || parsed.questions.length !== count) {
            formatFailure = `incomplete_question_count:${parsed.questions?.length || 0}`;
            continue;
          }
          const structurallyValid = parsed.questions.every((item) =>
            item &&
            typeof item.question === "string" &&
            item.question.trim() &&
            Array.isArray(item.options) &&
            item.options.length === 4 &&
            item.options.every((option) => typeof option === "string" && option.trim())
          );
          if (!structurallyValid) {
            formatFailure = "invalid_question_shape";
            console.log(JSON.stringify({
              event: "ai_test_format_error",
              reason: formatFailure,
              attempt
            }));
            continue;
          }
          testData = parsed;
        } catch (error) {
          if (error.status && ![502, 504].includes(error.status)) throw error;
          formatFailure = error.status === 504 ? "provider_timeout" : "invalid_json_or_truncated_response";
          console.log(JSON.stringify({
            event: "ai_test_format_error",
            reason: formatFailure,
            attempt
          }));
        }
      }

      if (!testData) {
        throw Object.assign(
          new Error("The AI could not produce a complete test. Please try again."),
          { status: 502 }
        );
      }

      testData.questions = testData.questions.map((item, index) => ({
        id: index + 1,
        question: typeof item.question === "string" ? item.question.slice(0, 2000) : "",
        options: Array.isArray(item.options)
          ? item.options.slice(0, 4).map((option) => String(option).slice(0, 500))
          : [],
        correctIndex: (() => {
          const value = Number(item.correctIndex);
          return Number.isInteger(value) && value >= 0 && value <= 3 ? value : 0;
        })(),
        explanation: typeof item.explanation === "string" ? item.explanation.slice(0, 2000) : "",
        difficulty: typeof item.difficulty === "string" ? item.difficulty.slice(0, 40) : difficulty
      })).filter((item) =>
        item.question && item.options.length === 4 &&
        item.options.every((option) => option.trim())
      );

      if (testData.questions.length !== count) {
        throw Object.assign(new Error("The AI returned an invalid question set. Please try again."), { status: 502 });
      }

      usage.successes += 1;

      console.log(JSON.stringify({
        event: "ai_test_request",
        user: userKey,
        status: 200,
        latencyMs: Date.now() - startedAt,
        subject,
        chapter,
        count,
        provider: AI_PROVIDER_NAME
      }));

      sendJson(response, 200, {
        title: typeof testData.title === "string" ? testData.title.slice(0, 160) : `${chapter} Practice Test`,
        questions: testData.questions,
        provider: AI_PROVIDER_NAME
      });
    } finally {
      release();
    }
  } catch (error) {
    if (error.status !== 429) usage.failures += 1;
    console.log(JSON.stringify({
      event: "ai_test_request",
      user: userKey,
      status: error.status || 500,
      latencyMs: Date.now() - startedAt
    }));
    sendJson(response, error.status || 500, { error: error.message || "Unexpected server error." });
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "POST" && url.pathname === "/api/auth/register") {
      await handleAuthRegister(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      await handleAuthLogin(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/auth/me") {
      handleAuthMe(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/device-login") {
      await handleDeviceLogin(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/forget-device") {
      await handleDeviceForget(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/account/sync") {
      await handleAccountSync(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/account/me") {
      handleAccountMe(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/admin/export") {
      handleOwnerExport(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/doubt") {
      await handleDoubt(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/test") {
      await handleAITest(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/leaderboard") {
      handleLeaderboardGet(request, response, url);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/leaderboard/sync") {
      await handleLeaderboardSync(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        status: "ok",
        providerConfigured: Boolean(AI_API_KEY),
        limits: {
          globalConcurrency: MAX_CONCURRENT_REQUESTS,
          perUserConcurrency: MAX_CONCURRENT_PER_USER,
          perUserRateLimit: `${RATE_LIMIT_REQUESTS}/${RATE_LIMIT_WINDOW_MS / 1000}s`,
          timeoutMs: REQUEST_TIMEOUT_MS
        },
        usage: { ...usage }
      });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    serveStatic(request, response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { error: "Unexpected server error." });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`StudyOS server listening on http://0.0.0.0:${PORT}`);
});
