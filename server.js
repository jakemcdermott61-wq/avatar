// TikTok LIVE -> Roblox relay (multi-streamer)
//
// POST /connect     { session, tiktok }  -> start listening to that streamer's LIVE chat
// GET  /poll?session=...                 -> { status, error, names: [...] }  (drains the new names)
// POST /disconnect  { session }          -> stop listening
// GET  /                                 -> health check
//
// Settings (environment variables, all optional):
//   PORT           port to listen on (hosts set this for you)           default 3417
//   API_KEY        if set, every request must send header  x-api-key    default none
//   MAX_SESSIONS   how many streamers can be connected at once          default 200
//   EULER_API_KEY  optional paid signing key (eulerstream.com)

import http from "node:http";
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from "tiktok-live-connector";

const PORT = Number(process.env.PORT || 3417);
const API_KEY = process.env.API_KEY || "";
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 200);
const EULER_API_KEY = process.env.EULER_API_KEY || "";

const IDLE_MS = 90_000;
const MAX_PENDING = 300;
const ROBLOX_NAME = /^[A-Za-z0-9_]{3,20}$/;
const TIKTOK_NAME = /^[A-Za-z0-9_.]{2,24}$/;
const SESSION_ID = /^[\w-]{1,64}$/;

const sessions = new Map();

function connectSession(s) {
  if (s.closed) return;
  s.status = "connecting";
  s.error = "";

  const conn = new TikTokLiveConnection(s.tiktok, EULER_API_KEY ? { signApiKey: EULER_API_KEY } : {});
  s.conn = conn;

  let handled = false;
  const retry = (message, ms) => {
    if (handled || s.closed) return;
    handled = true;
    s.status = "retrying";
    s.error = message;
    try { conn.disconnect(); } catch {}
    s.timer = setTimeout(() => connectSession(s), ms);
  };

  conn.on(ControlEvent.CONNECTED, () => {
    s.status = "connected";
    s.error = "";
    console.log(`[${s.id.slice(0, 8)}] connected to @${s.tiktok}`);
  });
  conn.on(ControlEvent.DISCONNECTED, () => retry("Disconnected from TikTok. Trying again...", 5_000));
  conn.on(ControlEvent.ERROR, (err) => console.error(`[${s.id.slice(0, 8)}] TikTok error:`, err?.message || err));

  conn.on(WebcastEvent.CHAT, (data) => {
    const text = String(data.content ?? data.comment ?? "").trim().replace(/^@/, "");
    if (!ROBLOX_NAME.test(text)) return;
    if (s.pending.length >= MAX_PENDING) return;
    s.pending.push(text);
  });

  conn.connect().catch((err) => {
    console.error(`[${s.id.slice(0, 8)}] couldn't connect to @${s.tiktok}:`, err?.message || err);
    retry(`Couldn't connect to @${s.tiktok}. Are you LIVE right now? Trying again...`, 10_000);
  });
}

function closeSession(s) {
  s.closed = true;
  clearTimeout(s.timer);
  try { s.conn?.disconnect(); } catch {}
  sessions.delete(s.id);
}

setInterval(() => {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (now - s.lastPoll > IDLE_MS) {
      console.log(`[${s.id.slice(0, 8)}] idle, closing (@${s.tiktok})`);
      closeSession(s);
    }
  }
}, 30_000).unref();

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 4096) req.destroy();
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/" && req.method === "GET") {
    return send(res, 200, { status: "ok", sessions: sessions.size });
  }

  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return send(res, 401, { error: "bad api key" });
  }

  if (url.pathname === "/poll" && req.method === "GET") {
    const s = sessions.get(url.searchParams.get("session") || "");
    if (!s) return send(res, 404, { error: "unknown session" });
    s.lastPoll = Date.now();
    const names = s.pending.splice(0, s.pending.length);
    return send(res, 200, { status: s.status, error: s.error, names });
  }

  if (req.method === "POST" && (url.pathname === "/connect" || url.pathname === "/disconnect")) {
    const body = await readJson(req);
    if (!body || typeof body.session !== "string" || !SESSION_ID.test(body.session)) {
      return send(res, 400, { error: "bad request" });
    }

    if (url.pathname === "/disconnect") {
      const s = sessions.get(body.session);
      if (s) closeSession(s);
      return send(res, 200, { ok: true });
    }

    const tiktok = String(body.tiktok || "").trim().replace(/^@/, "");
    if (!TIKTOK_NAME.test(tiktok)) {
      return send(res, 400, { error: "That doesn't look like a TikTok username." });
    }

    const existing = sessions.get(body.session);
    if (existing) closeSession(existing);

    if (sessions.size >= MAX_SESSIONS) {
      return send(res, 429, { error: "The chat service is full right now. Try again in a few minutes." });
    }

    const s = {
      id: body.session, tiktok, status: "connecting", error: "",
      pending: [], lastPoll: Date.now(), conn: null, timer: null, closed: false,
    };
    sessions.set(s.id, s);
    console.log(`[${s.id.slice(0, 8)}] new session for @${tiktok} (${sessions.size} active)`);
    connectSession(s);
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`Relay listening on port ${PORT}${API_KEY ? " (API key required)" : " (no API key set)"}`));
