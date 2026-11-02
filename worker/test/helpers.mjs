// Test helpers: a tiny FIT encoder, a ZIP builder, and a fake Garmin server.
import zlib from 'node:zlib';

const FIT_EPOCH = 631065600;
function crc16(bytes){
  const T = [0x0000,0xCC01,0xD801,0x1400,0xF001,0x3C00,0x2800,0xE401,0xA001,0x6C00,0x7800,0xB401,0x5000,0x9C01,0x8801,0x4400];
  let crc = 0;
  for (const b of bytes){
    let t = T[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ T[b & 0xF];
    t = T[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ T[(b >> 4) & 0xF];
  }
  return crc;
}
/** builds a FIT file with N GPS records and one session (cycling) */
export function makeFit({n = 120, startUnix = Date.UTC(2026, 9, 30, 6, 0) / 1000} = {}){
  const out = [];
  const u8 = v => out.push(v & 0xFF);
  const u16 = v => { u8(v); u8(v >> 8); };
  const u32 = v => { u16(v & 0xFFFF); u16((v >>> 16) & 0xFFFF); };
  const i32 = v => u32(v >>> 0);
  const t0 = Math.round(startUnix - FIT_EPOCH);
  // definition local 0 = record(20): 253 ts u32, 0 lat s32, 1 lon s32, 5 dist u32, 78 alt u32, 73 speed u32
  u8(0x40); u8(0); u8(0); u16(20); u8(6);
  for (const [f, s, bt] of [[253,4,0x86],[0,4,0x85],[1,4,0x85],[5,4,0x86],[78,4,0x86],[73,4,0x86]]){ u8(f); u8(s); u8(bt); }
  let dist = 0;
  for (let i = 0; i < n; i++){
    const lat = 25.03 + 0.01 * Math.sin(i / n * 6.28), lon = 121.56 + 0.01 * Math.cos(i / n * 6.28);
    dist += 8; // 8 m/s
    u8(0); u32(t0 + i); i32(Math.round(lat / 180 * 2147483648)); i32(Math.round(lon / 180 * 2147483648));
    u32(dist * 100); u32((100 + 500) * 5); u32(8000);
  }
  // definition local 1 = session(18): 253 ts, 2 start u32, 5 sport enum, 7 elapsed u32, 8 timer u32, 9 dist u32, 22 ascent u16
  u8(0x41); u8(0); u8(0); u16(18); u8(7);
  for (const [f, s, bt] of [[253,4,0x86],[2,4,0x86],[5,1,0x00],[7,4,0x86],[8,4,0x86],[9,4,0x86],[22,2,0x84]]){ u8(f); u8(s); u8(bt); }
  u8(1); u32(t0 + n); u32(t0); u8(2); u32(n * 1000); u32(n * 1000); u32(dist * 100); u16(42);
  const data = Uint8Array.from(out);
  const hdr = new Uint8Array(14); const dv = new DataView(hdr.buffer);
  hdr[0] = 14; hdr[1] = 0x20; dv.setUint16(2, 2132, true); dv.setUint32(4, data.length, true);
  hdr.set([0x2E, 0x46, 0x49, 0x54], 8); dv.setUint16(12, crc16(hdr.subarray(0, 12)), true);
  const body = new Uint8Array(14 + data.length + 2); body.set(hdr); body.set(data, 14);
  new DataView(body.buffer).setUint16(14 + data.length, crc16(body.subarray(0, 14 + data.length)), true);
  return body;
}

/** ZIP with one deflated entry; withDescriptor = sizes only in central dir (like streaming zips) */
export function makeZip(name, content, {withDescriptor = true} = {}){
  const comp = zlib.deflateRawSync(Buffer.from(content));
  const nameB = Buffer.from(name);
  const crc = zlib.crc32 ? zlib.crc32(Buffer.from(content)) : 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(withDescriptor ? 0x08 : 0, 6); local.writeUInt16LE(8, 8);
  if (!withDescriptor){ local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(content.length, 22); }
  local.writeUInt16LE(nameB.length, 26);
  const desc = withDescriptor ? (() => { const d = Buffer.alloc(16); d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(crc, 4); d.writeUInt32LE(comp.length, 8); d.writeUInt32LE(content.length, 12); return d; })() : Buffer.alloc(0);
  const localPart = Buffer.concat([local, nameB, comp, desc]);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(withDescriptor ? 0x08 : 0, 8); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(content.length, 24); cen.writeUInt16LE(nameB.length, 28); cen.writeUInt32LE(0, 42);
  const cenPart = Buffer.concat([cen, nameB]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cenPart.length, 12); end.writeUInt32LE(localPart.length, 16);
  const all = Buffer.concat([localPart, cenPart, end]);
  return new Uint8Array(all.buffer, all.byteOffset, all.length);
}

export function makeJwt(expSec){
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({alg: 'none'})}.${b({exp: expSec, sub: 'x'})}.sig`;
}

/** fake Garmin; mode flags let tests flip behaviour */
export function fakeGarmin(){
  const state = {tokenCalls: 0, searchCalls: 0, keyValid: true, rejectNextBearer: false, issued: new Set(), fit: makeFit(), lastSearch: null};
  state.activities = [
    {activityId: 1002, activityName: '河濱騎車', activityType: {typeKey: 'road_biking'}, startTimeLocal: '2026-10-30 14:00:00', startTimeGMT: '2026-10-30 06:00:00', distance: 960, duration: 120, movingDuration: 118, elapsedDuration: 125},
    {activityId: 1001, activityName: '晨跑', activityType: {typeKey: 'running'}, startTimeLocal: '2026-10-29 06:00:00', startTimeGMT: '2026-10-28 22:00:00', distance: 5000, duration: 1800},
  ];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const h = new Headers(init.headers || {});
    if (u.pathname === '/personalapitoken-service/personal-api/personal-api-key/token'){
      state.tokenCalls++;
      if (init.method !== 'POST' || h.get('Authorization') !== 'ApiKey test-garmin-key' || !state.keyValid) return new Response('unauthorized', {status: 401});
      const t = makeJwt(Math.floor(Date.now() / 1000) + 86400) + state.tokenCalls;
      state.issued.add(t);
      return new Response(t + '\n', {status: 200, headers: {'Content-Type': 'text/plain'}});
    }
    const auth = (h.get('Authorization') || '').replace(/^Bearer /, '');
    if (!state.issued.has(auth)) return new Response('bad token', {status: 401});
    if (state.rejectNextBearer){ state.rejectNextBearer = false; state.issued.delete(auth); return new Response('expired', {status: 401}); }
    if (u.pathname === '/activitylist-service/activities/search/activities'){
      state.searchCalls++; state.lastSearch = Object.fromEntries(u.searchParams);
      return Response.json(+u.searchParams.get('start') === 0 ? state.activities : []);
    }
    const m = u.pathname.match(/^\/download-service\/files\/activity\/(\d+)$/);
    if (m){
      if (m[1] === '404') return new Response('nope', {status: 404});
      if (m[1] === '555') return new Response(makeZip('notes.txt', Buffer.from('hi')), {status: 200});
      return new Response(makeZip(`${m[1]}_ACTIVITY.fit`, state.fit), {status: 200, headers: {'Content-Type': 'application/zip'}});
    }
    return new Response('not found', {status: 404});
  };
  return {state, fetchImpl};
}

export function memoryKV(){
  const m = new Map();
  return {
    m,
    async get(k, type){ const v = m.get(k); if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v){ m.set(k, v); },
  };
}
