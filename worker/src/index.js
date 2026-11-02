/**
 * 運動軌跡卡 — Garmin Personal API 中繼站（Cloudflare Worker）
 *
 * 為什麼需要它：Garmin Personal API 不允許瀏覽器直接呼叫（CORS 會擋），
 * 而且 API 金鑰不能放在網頁裡，所以由這個 Worker 代為呼叫。
 *
 * 需要的設定（都不寫在程式碼裡）：
 *   Secret  GARMIN_API_KEY   Garmin Connect 建立的 Personal API 金鑰
 *   Secret  ACCESS_KEY       自訂的存取密碼，網頁要用 X-Key header 帶上
 *   KV      TRACE_KV         （建議）快取 access token 和每小時抓到的活動清單
 *   Var     ALLOWED_ORIGINS  （選填）允許的網頁來源，逗號分隔；沒設就允許全部
 *
 * 端點：
 *   GET /health              檢查設定是否完整（不需 X-Key）
 *   GET /activities?days=30  最近活動的精簡清單
 *   GET /fit/{activityId}    該活動的原始 .fit bytes
 */

const VERSION = '1.1.0';
const GARMIN_BASE = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const SEARCH_PATH = '/activitylist-service/activities/search/activities';
const DOWNLOAD_PATH = '/download-service/files/activity/';

const TOKEN_KV_KEY = 'garmin:token';
const SNAPSHOT_KV_KEY = 'garmin:activities:snapshot';
const TOKEN_REFRESH_WINDOW = 60 * 60;   // 到期前 1 小時就重換（跟官方 client 一樣）
const SNAPSHOT_DAYS = 30;               // Cron 預先抓的天數
const SNAPSHOT_MAX_AGE = 65 * 60;       // 快照超過 65 分鐘就視為過舊
const PAGE_SIZE = 50;
const MAX_ACTIVITIES = 300;
const GARMIN_TIMEOUT_MS = 25000;

const MSG_KEY_EXPIRED = 'Garmin API 金鑰無效或已過期，請到 Garmin Connect 重新建立 Personal API 金鑰，再更新 Worker 的 GARMIN_API_KEY。';

/* ---------------- errors ---------------- */
class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/* ---------------- token ---------------- */
let memToken = null; // {token, exp, fp}

async function keyFingerprint(key) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(d).slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function jwtExp(token) {
  try {
    const part = token.split('.')[1];
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4);
    const exp = Number(JSON.parse(atob(b64)).exp);
    if (Number.isFinite(exp)) return exp;
  } catch { /* fall through */ }
  return Math.floor(Date.now() / 1000) + 23 * 3600; // 解不出來就保守當作 23 小時
}

const now = () => Math.floor(Date.now() / 1000);
const fresh = t => t && t.exp - now() > TOKEN_REFRESH_WINDOW;

async function getToken(env, force = false) {
  if (!env.GARMIN_API_KEY) throw new AppError(500, 'CONFIG', 'Worker 尚未設定 GARMIN_API_KEY。');
  const fp = await keyFingerprint(env.GARMIN_API_KEY);
  if (!force) {
    if (memToken && memToken.fp === fp && fresh(memToken)) return memToken.token;
    if (env.TRACE_KV) {
      const cached = await env.TRACE_KV.get(TOKEN_KV_KEY, 'json').catch(() => null);
      if (cached && cached.fp === fp && fresh(cached)) { memToken = cached; return cached.token; }
    }
  }
  const res = await garminFetch(GARMIN_BASE + TOKEN_PATH, {
    method: 'POST',
    headers: { Accept: '*/*', Authorization: `ApiKey ${env.GARMIN_API_KEY}` },
  });
  if (res.status === 401 || res.status === 403) throw new AppError(401, 'KEY_EXPIRED', MSG_KEY_EXPIRED);
  if (!res.ok) throw new AppError(502, 'GARMIN_TOKEN', `向 Garmin 換取 token 失敗（HTTP ${res.status}）。`);
  const token = (await res.text()).trim();
  if (!token) throw new AppError(502, 'GARMIN_TOKEN', 'Garmin 回傳的 token 是空的。');
  memToken = { token, exp: jwtExp(token), fp };
  if (env.TRACE_KV) {
    const ttl = Math.max(60, memToken.exp - now());
    await env.TRACE_KV.put(TOKEN_KV_KEY, JSON.stringify(memToken), { expirationTtl: ttl }).catch(() => {});
  }
  return token;
}

async function garminFetch(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(GARMIN_TIMEOUT_MS) });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new AppError(504, 'GARMIN_UNREACHABLE', timeout ? 'Garmin 伺服器回應逾時，請稍後再試。' : '無法連線到 Garmin 伺服器，請稍後再試。');
  }
}

/** 帶 token 呼叫 Garmin；token 被拒時強制重換一次再試 */
async function garminGet(env, path, accept = 'application/json') {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(env, attempt > 0);
    const res = await garminFetch(GARMIN_BASE + path, {
      headers: { Accept: accept, Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && attempt === 0) { memToken = null; continue; }
    if (res.status === 401 || res.status === 403) throw new AppError(401, 'KEY_EXPIRED', MSG_KEY_EXPIRED);
    if (res.status === 404) throw new AppError(404, 'NOT_FOUND', '在 Garmin 找不到這筆資料。');
    if (res.status === 429) throw new AppError(429, 'RATE_LIMITED', 'Garmin 暫時限制了請求次數，請過幾分鐘再試。');
    if (!res.ok) throw new AppError(502, 'GARMIN_HTTP', `Garmin 回應錯誤（HTTP ${res.status}）。`);
    return res;
  }
  throw new AppError(401, 'KEY_EXPIRED', MSG_KEY_EXPIRED);
}

/* ---------------- activities ---------------- */
const ymd = d => d.toISOString().slice(0, 10);
/** Garmin 的 startTimeGMT 長這樣 "2026-10-30 06:12:00"（沒有時區），當作 UTC 解析 */
function gmtMs(s) {
  if (!s) return null;
  const iso = String(s).trim().replace(' ', 'T');
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  return Number.isFinite(t) ? t : null;
}

function activityRecords(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') for (const k of ['activities', 'activityList']) if (Array.isArray(v[k])) return v[k];
  return [];
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function slimActivity(a) {
  const t = a.activityType;
  return {
    id: String(a.activityId),
    name: a.activityName || a.title || a.name || '',
    type: (t && (t.typeKey || t.key)) || (typeof t === 'string' ? t : ''),
    start: a.startTimeLocal || a.startTimeGMT || a.activityDate || null,
    startGMT: a.startTimeGMT || null,
    distance: num(a.distance),                 // 公尺
    duration: num(a.duration),                 // 秒（計時時間）
    movingDuration: num(a.movingDuration),     // 秒
    elapsedDuration: num(a.elapsedDuration),   // 秒
  };
}

async function fetchActivities(env, days) {
  const end = new Date(Date.now() + 86400000); // 多抓一天，避免 UTC 與台灣時間的日期差
  const start = new Date(Date.now() - days * 86400000);
  const out = [];
  for (let s = 0; s < MAX_ACTIVITIES; s += PAGE_SIZE) {
    const q = new URLSearchParams({ start: String(s), limit: String(PAGE_SIZE), startDate: ymd(start), endDate: ymd(end) });
    const res = await garminGet(env, `${SEARCH_PATH}?${q}`);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : []; } catch { throw new AppError(502, 'GARMIN_FORMAT', 'Garmin 回傳的活動清單格式無法辨識。'); }
    const page = activityRecords(data).filter(a => a && a.activityId != null);
    out.push(...page.map(slimActivity));
    if (page.length < PAGE_SIZE) break;
  }
  out.sort((a, b) => String(b.startGMT || b.start || '').localeCompare(String(a.startGMT || a.start || '')));
  return out;
}

async function refreshSnapshot(env) {
  const activities = await fetchActivities(env, SNAPSHOT_DAYS);
  const snap = { fetchedAt: now(), days: SNAPSHOT_DAYS, activities };
  if (env.TRACE_KV) await env.TRACE_KV.put(SNAPSHOT_KV_KEY, JSON.stringify(snap));
  return snap;
}

async function handleActivities(env, url) {
  const days = Math.round(Number(url.searchParams.get('days') || 30));
  if (!Number.isFinite(days) || days < 1 || days > 365) throw new AppError(400, 'BAD_REQUEST', 'days 必須是 1 到 365 之間的整數。');
  const forceLive = url.searchParams.get('fresh') === '1';
  if (!forceLive && env.TRACE_KV && days <= SNAPSHOT_DAYS) {
    const snap = await env.TRACE_KV.get(SNAPSHOT_KV_KEY, 'json').catch(() => null);
    if (snap && now() - snap.fetchedAt < SNAPSHOT_MAX_AGE) {
      const cutoff = Date.now() - days * 86400000;
      const list = snap.activities.filter(a => { const t = gmtMs(a.startGMT); return t == null || t >= cutoff; });
      return { fetchedAt: snap.fetchedAt, cached: true, days, activities: list };
    }
  }
  if (days === SNAPSHOT_DAYS && env.TRACE_KV) {
    const snap = await refreshSnapshot(env);
    return { fetchedAt: snap.fetchedAt, cached: false, days, activities: snap.activities };
  }
  return { fetchedAt: now(), cached: false, days, activities: await fetchActivities(env, days) };
}

/* ---------------- zip ---------------- */
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 從 ZIP 取出第一個 .fit 檔；用中央目錄的大小，所以有 data descriptor 的 ZIP 也能讀 */
async function extractFit(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (u8.length >= 12 && String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) === '.FIT') return { name: null, bytes: u8 };
  if (!(u8[0] === 0x50 && u8[1] === 0x4B)) throw new AppError(502, 'GARMIN_FORMAT', 'Garmin 回傳的不是 ZIP 或 FIT 檔。');
  let e = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new AppError(502, 'GARMIN_FORMAT', 'Garmin 回傳的壓縮檔格式無法辨識。');
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  for (let i = 0; i < count; i++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!/\.fit$/i.test(name)) continue;
    const start = loff + 30 + dv.getUint16(loff + 26, true) + dv.getUint16(loff + 28, true);
    const data = u8.subarray(start, start + csize);
    if (method === 0) return { name, bytes: data };
    if (method === 8) return { name, bytes: await inflateRaw(data) };
    throw new AppError(502, 'GARMIN_FORMAT', '不支援這種壓縮方式。');
  }
  throw new AppError(404, 'NO_FIT', '這筆活動的原始檔裡沒有 .fit 檔（可能是手動建立的活動）。');
}

async function handleFit(env, id) {
  const res = await garminGet(env, DOWNLOAD_PATH + id, 'application/zip, application/x-zip-compressed, application/octet-stream');
  const buf = await res.arrayBuffer();
  if (!buf.byteLength) throw new AppError(502, 'GARMIN_EMPTY', 'Garmin 回傳的原始檔是空的。');
  const { name, bytes } = await extractFit(buf);
  const fname = name ? name.split('/').pop() : `${id}.fit`;
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fname.replace(/[^\w.\-]/g, '_')}"`,
      'Cache-Control': 'private, max-age=86400',
    },
  });
}

/* ---------------- http plumbing ---------------- */
function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allow = !allowed.length ? '*' : (origin && allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Key, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Disposition',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

/** 固定時間比對，避免從回應時間猜出密碼 */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function route(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method !== 'GET') throw new AppError(405, 'METHOD', '只支援 GET。');

  if (path === '/' || path === '/health') {
    return json({ ok: true, version: VERSION, hasApiKey: !!env.GARMIN_API_KEY, hasAccessKey: !!env.ACCESS_KEY, hasKV: !!env.TRACE_KV });
  }

  if (!env.ACCESS_KEY) throw new AppError(500, 'CONFIG', 'Worker 尚未設定 ACCESS_KEY。');
  const given = req.headers.get('X-Key') || '';
  if (!given || !(await safeEqual(given, env.ACCESS_KEY))) throw new AppError(401, 'BAD_ACCESS_KEY', '存取密碼錯誤，請檢查網頁「Garmin」分頁裡填的密碼。');

  if (path === '/activities') return json(await handleActivities(env, url));
  const m = path.match(/^\/fit\/(\d{1,20})$/);
  if (m) return handleFit(env, m[1]);
  throw new AppError(404, 'NOT_FOUND', '沒有這個路徑。');
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(req, env);
    } catch (err) {
      const e = err instanceof AppError ? err : new AppError(500, 'INTERNAL', '中繼站發生未預期的錯誤。');
      if (!(err instanceof AppError)) console.error(err);
      res = json({ error: true, code: e.code, message: e.message }, e.status);
    }
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },

  /** Cron：每小時先把最近 30 天的活動清單存到 KV，網頁打開就能馬上看到 */
  async scheduled(event, env, ctx) {
    if (!env.TRACE_KV || !env.GARMIN_API_KEY) return;
    ctx.waitUntil(refreshSnapshot(env).catch(err => console.error('cron refresh failed:', err && err.message)));
  },
};

// 給測試用
export const _internal = { extractFit, jwtExp, slimActivity, activityRecords };
