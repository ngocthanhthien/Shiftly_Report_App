// Shiftly Report — Cloudflare Worker backend (thay thế Supabase: Postgres RPC + Auth + Edge Function + Realtime).
//
// Giữ NGUYÊN giao diện `POST /rpc/<sync_*>` (cùng tên hàm, tham số, định dạng trả về — kể cả lỗi trả HTTP 200 dạng
// {error:'unauthorized'|'forbidden_role'}) để index.html chỉ phải đổi URL/xác thực, không đổi logic đồng bộ.
// Quyền truy cập kiểm ở MỌI request (thay cho RLS + SECURITY DEFINER): người dùng phải còn hoạt động trong bảng
// `users`; supervisor không được ghi; khoá meta 'egressControl' chỉ Admin được ghi.
//
// Giới hạn gói Free đã tính đến (xem cloudflare/README.md): 50 truy vấn/subrequest (D1 + R2 tính chung) mỗi request,
// 10 ms CPU — nên băm/kiểm mật khẩu chạy trong Durable Object `Hasher`, ảnh đi thẳng chuỗi dataUrl vào R2 (không giải
// mã base64), và mỗi lệnh ghi/đọc bị chặn số dòng/ảnh (trả reason 'batch_too_large' / danh sách `pending`).
import bcrypt from 'bcryptjs';

const ACCESS_TTL = 3600;            // giây
const REFRESH_TTL = 60 * 86400;     // giây
const PBKDF2_ITER = 100000;         // mức tối đa Workers cho phép
const MAX_ROWS = 20;
const OP_BUDGET = 44;               // chừa chỗ cho truy vấn xác thực + dự phòng trong giới hạn 50
const LOG_KEEP = 10;
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;

const te = new TextEncoder();
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', te.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signJwt(payload, secret) {
  const head = b64u(te.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64u(te.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), te.encode(head + '.' + body));
  return head + '.' + body + '.' + b64u(sig);
}
async function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !secret) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64u(parts[2]), te.encode(parts[0] + '.' + parts[1]));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(parts[1])));
    return p.exp > Math.floor(Date.now() / 1000) ? p : null;
  } catch (e) { return null; }
}
function timingSafeEqual(a, b) {
  const x = te.encode(String(a)), y = te.encode(String(b));
  if (x.length !== y.length) return false;
  let r = 0; for (let i = 0; i < x.length; i++) r |= x[i] ^ y[i];
  return r === 0;
}

/* ---------------- Durable Object: băm/kiểm mật khẩu (giới hạn CPU rộng hơn Worker gói Free) ---------------- */
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
export class Hasher {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(req) {
    const { op, password, hash } = await req.json();
    if (op === 'hash') {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const dk = await pbkdf2(password, salt, PBKDF2_ITER);
      return Response.json({ hash: `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(dk)}` });
    }
    if (op === 'verify') {
      if (String(hash).startsWith('pbkdf2$')) {
        const [, iter, salt, want] = hash.split('$');
        const dk = await pbkdf2(password, unb64(salt), Number(iter));
        return Response.json({ ok: timingSafeEqual(b64(dk), want) });
      }
      // bcrypt ($2a$/$2b$/$2y$) — định dạng mật khẩu đang lưu ở Supabase Auth
      return Response.json({ ok: await bcrypt.compare(password, hash) });
    }
    return Response.json({ error: 'bad_op' }, { status: 400 });
  }
}
async function hasher(env, body) {
  const stub = env.HASHER.get(env.HASHER.idFromName('main'));
  const r = await stub.fetch('https://hasher/', { method: 'POST', body: JSON.stringify(body) });
  return r.json();
}

/* ---------------- Durable Object: Realtime (phát tín hiệu "vừa có thay đổi") ---------------- */
export class Hub {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/broadcast') {
      for (const ws of this.state.getWebSockets()) { try { ws.send('changed'); } catch (e) { /* client đã đóng */ } }
      return new Response('ok');
    }
    if (req.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('bad request', { status: 400 });
  }
  webSocketMessage(ws, msg) { if (msg === 'ping') ws.send('pong'); }
}
function broadcast(env, ctx) {
  try { ctx.waitUntil(env.HUB.get(env.HUB.idFromName('main')).fetch('https://hub/broadcast', { method: 'POST' })); } catch (e) { /* best-effort */ }
}

/* ---------------- HTTP helpers ---------------- */
function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = { 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
  if (origin && allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function json(obj, req, env, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(req, env) } });
}
async function authUser(req, env) {
  const h = req.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : new URL(req.url).searchParams.get('token');
  if (!token) return null;
  const p = await verifyJwt(token, env.JWT_SECRET);
  if (!p) return null;
  const u = await env.DB.prepare('SELECT id, display_name, username, email, role, disabled FROM users WHERE id = ?1').bind(p.sub).first();
  return u && !u.disabled ? u : null;
}
const isWriter = u => u.role !== 'supervisor';
const isAdmin = u => u.role === 'admin';
const fpOf = images => (images || []).map(im => im.ts).sort((a, b) => a - b).join(',');
const imgKey = (cpKey, ts) => `cp/${encodeURIComponent(cpKey)}/${ts}`;
const parse = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };
const placeholders = n => Array.from({ length: n }, (_, i) => '?' + (i + 1)).join(',');
const NEXT_SEQ = "(SELECT v FROM counters WHERE name='seq')";
const BUMP = "UPDATE counters SET v = v + 1 WHERE name = 'seq'";

/* ---------------- RPC: các hàm sync_* (cùng tên/định dạng như supabase/schema.sql) ---------------- */
const RPC = {
  async sync_whoami(env, u) {
    return { userId: u.id, displayName: u.display_name, username: u.username, role: u.role };
  },

  async sync_get_checkpoints(env, u, p) {
    const since = Number(p.p_since || 0);
    const { results } = await env.DB.prepare(
      'SELECT key, date, shift, section, po, item_code, recipe, client, technician, fields, field_notes, images_fp, updated_at, deleted, seq FROM checkpoints WHERE seq > ?1 ORDER BY seq LIMIT 200'
    ).bind(since).all();
    const rows = results.map(r => ({
      key: r.key, date: r.date, shift: r.shift, section: r.section, po: r.po, itemCode: r.item_code, recipe: r.recipe,
      client: r.client, technician: r.technician, fields: parse(r.fields, {}), fieldNotes: parse(r.field_notes, {}),
      imagesFp: r.images_fp, updatedAt: r.updated_at, deleted: !!r.deleted,
    }));
    return { rows, cursor: results.length ? results[results.length - 1].seq : since, hasMore: results.length === 200 };
  },

  // Ảnh KHÔNG đi kèm sync_get_checkpoints (chỉ imagesFp). Mỗi lần gọi tối đa OP_BUDGET lượt đọc R2 (giới hạn subrequest
  // gói Free) — phần chưa phục vụ trả về trong `pending`, client gọi lại với đúng các key đó.
  async sync_get_checkpoint_images(env, u, p) {
    const keys = (p.p_keys || []).slice(0, MAX_ROWS);
    const items = {}, pending = [];
    if (!keys.length) return { items, pending };
    const { results } = await env.DB.prepare(`SELECT key, images FROM checkpoints WHERE key IN (${placeholders(keys.length)}) AND deleted = 0`).bind(...keys).all();
    let used = 0;
    for (const r of results) {
      const metas = parse(r.images, []);
      if (used + metas.length > OP_BUDGET && used > 0) { pending.push(r.key); continue; }
      const imgs = await Promise.all(metas.map(async m => {
        const obj = await env.IMAGES.get(imgKey(r.key, m.ts));
        return obj ? { ...m, dataUrl: await obj.text() } : null;
      }));
      used += metas.length;
      items[r.key] = imgs.filter(Boolean);
    }
    return { items, pending };
  },

  async sync_put_checkpoints(env, u, p) {
    if (!isWriter(u)) return { error: 'forbidden_role' };
    const input = Array.isArray(p.p_rows) ? p.p_rows : [];
    const results = new Array(input.length);
    const cand = [];
    input.forEach((row, i) => {
      if (i >= MAX_ROWS) { results[i] = { key: row && row.key, applied: false, reason: 'batch_too_large' }; return; }
      if (!row || !row.key || !row.updatedAt) { results[i] = { key: row && row.key, applied: false, reason: 'invalid' }; return; }
      cand.push({ i, row });
    });
    if (!cand.length) return { results };
    const keys = cand.map(c => c.row.key);
    const existing = new Map((await env.DB.prepare(`SELECT key, updated_at, images_fp, images FROM checkpoints WHERE key IN (${placeholders(keys.length)})`).bind(...keys).all()).results.map(r => [r.key, r]));

    let budget = OP_BUDGET - 2;
    const accepted = [];
    const r2Deletes = [];
    for (const c of cand) {
      const { row, i } = c;
      const cur = existing.get(row.key);
      const hasImages = Array.isArray(row.images);
      const fp = hasImages ? fpOf(row.images) : null;
      const newer = !cur || row.updatedAt > cur.updated_at;
      const imagesUpgrade = !!cur && row.updatedAt === cur.updated_at && hasImages && fp !== cur.images_fp;
      if (!newer && !imagesUpgrade) { results[i] = { key: row.key, applied: false, reason: 'stale' }; continue; }
      const cost = 2 + (hasImages ? row.images.length : 0);
      if (cost > budget) { results[i] = { key: row.key, applied: false, reason: 'batch_too_large' }; continue; }
      budget -= cost;
      accepted.push({ i, row, cur, hasImages, fp });
    }

    const stmts = [];
    for (const a of accepted) {
      const { row } = a;
      let metas = [];
      if (a.hasImages) {
        await Promise.all(row.images.map(im => env.IMAGES.put(imgKey(row.key, im.ts), String(im.dataUrl || ''))));
        metas = row.images.map(im => { const { dataUrl, ...rest } = im; return { ...rest, size: String(dataUrl || '').length }; });
        if (a.cur) {
          const keep = new Set(row.images.map(im => im.ts));
          parse(a.cur.images, []).filter(m => !keep.has(m.ts)).forEach(m => r2Deletes.push(imgKey(row.key, m.ts)));
        }
      }
      stmts.push(env.DB.prepare(BUMP));
      stmts.push(env.DB.prepare(
        `INSERT INTO checkpoints (key, date, shift, section, po, item_code, recipe, client, technician, fields, field_notes, images, images_fp, updated_at, deleted, seq)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,0,${NEXT_SEQ})
         ON CONFLICT(key) DO UPDATE SET date=excluded.date, shift=excluded.shift, section=excluded.section, po=excluded.po,
           item_code=excluded.item_code, recipe=excluded.recipe, client=excluded.client, technician=excluded.technician,
           fields=excluded.fields, field_notes=excluded.field_notes,
           images=CASE WHEN ?15=1 THEN excluded.images ELSE checkpoints.images END,
           images_fp=CASE WHEN ?15=1 THEN excluded.images_fp ELSE checkpoints.images_fp END,
           updated_at=excluded.updated_at, deleted=0, seq=excluded.seq
         WHERE excluded.updated_at > checkpoints.updated_at
            OR (excluded.updated_at = checkpoints.updated_at AND ?15=1 AND excluded.images_fp IS NOT checkpoints.images_fp)`
      ).bind(row.key, row.date || '', row.shift || '', row.section || '', row.po || '', row.itemCode || '', row.recipe || '', row.client || '',
        row.technician || '', JSON.stringify(row.fields || {}), JSON.stringify(row.fieldNotes || {}),
        JSON.stringify(metas), a.hasImages ? a.fp : '', row.updatedAt, a.hasImages ? 1 : 0));
    }
    if (stmts.length) {
      const out = await env.DB.batch(stmts);
      accepted.forEach((a, n) => {
        const applied = out[n * 2 + 1].meta.changes > 0;
        results[a.i] = applied ? { key: a.row.key, applied: true } : { key: a.row.key, applied: false, reason: 'stale' };
      });
      if (r2Deletes.length) await env.IMAGES.delete(r2Deletes.slice(0, 1000));
    }
    return { results };
  },

  async sync_delete_checkpoints(env, u, p) {
    if (!isWriter(u)) return { error: 'forbidden_role' };
    const dels = (Array.isArray(p.p_deletes) ? p.p_deletes : []).filter(d => d && d.key && d.updatedAt).slice(0, MAX_ROWS);
    if (!dels.length) return { ok: true };
    const keys = dels.map(d => d.key);
    const cur = (await env.DB.prepare(`SELECT key, images FROM checkpoints WHERE key IN (${placeholders(keys.length)})`).bind(...keys).all()).results;
    const stmts = [];
    for (const d of dels) {
      stmts.push(env.DB.prepare(BUMP));
      stmts.push(env.DB.prepare(
        `INSERT INTO checkpoints (key, date, shift, section, po, updated_at, deleted, seq, images, images_fp)
         VALUES (?1,'','','','',?2,1,${NEXT_SEQ},'[]','')
         ON CONFLICT(key) DO UPDATE SET deleted=1, updated_at=excluded.updated_at, seq=excluded.seq, images='[]', images_fp=''
         WHERE excluded.updated_at > checkpoints.updated_at`
      ).bind(d.key, d.updatedAt));
    }
    const out = await env.DB.batch(stmts);
    const r2 = [];
    dels.forEach((d, n) => {
      if (out[n * 2 + 1].meta.changes > 0) {
        const c = cur.find(x => x.key === d.key);
        if (c) parse(c.images, []).forEach(m => r2.push(imgKey(d.key, m.ts)));
      }
    });
    if (r2.length) await env.IMAGES.delete(r2.slice(0, 1000));
    return { ok: true };
  },

  async sync_get_meta(env, u, p) {
    const since = p.p_since || null;
    const { results } = await env.DB.prepare('SELECT k, value, updated_at FROM meta WHERE ?1 IS NULL OR updated_at > ?1').bind(since).all();
    const items = {}; let cursor = since;
    for (const r of results) { items[r.k] = { value: parse(r.value, null), updatedAt: r.updated_at }; if (!cursor || r.updated_at > cursor) cursor = r.updated_at; }
    return { items, cursor };
  },

  async sync_put_meta(env, u, p) {
    if (!isWriter(u)) return { error: 'forbidden_role' };
    const entries = Object.entries(p.p_items || {}).slice(0, MAX_ROWS);
    const res = {};
    const todo = [];
    for (const [k, v] of entries) {
      if (!v || !v.updatedAt) { res[k] = { applied: false, reason: 'invalid' }; continue; }
      // Data & Egress Control: chỉ Admin được đổi — kiểm ở SERVER, không chỉ ẩn nút ở client.
      if (k === 'egressControl' && !isAdmin(u)) { res[k] = { applied: false, reason: 'forbidden_role' }; continue; }
      todo.push([k, v]);
    }
    if (todo.length) {
      const out = await env.DB.batch(todo.map(([k, v]) => env.DB.prepare(
        `INSERT INTO meta (k, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(k) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at WHERE excluded.updated_at > meta.updated_at`
      ).bind(k, JSON.stringify(v.value === undefined ? null : v.value), v.updatedAt)));
      todo.forEach(([k], n) => { res[k] = { applied: out[n].meta.changes > 0 }; });
    }
    return { results: res };
  },

  async sync_post_logs(env, u, p) {
    if (!isWriter(u)) return { error: 'forbidden_role' };
    const entries = (Array.isArray(p.p_entries) ? p.p_entries : []).slice(0, MAX_ROWS);
    if (!entries.length) return { ok: true };
    const stmts = entries.map(e => env.DB.prepare(
      'INSERT INTO logs (ts, date, shift, po, section, technician, changes, user_name, machine, action) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)'
    ).bind(e.ts || new Date().toISOString(), e.date || null, e.shift || null, e.po || null, e.section || null, e.technician || null,
      JSON.stringify(e.changes || []), e.user || null, e.machine || null, e.action || null));
    // Chỉ giữ LOG_KEEP dòng mới nhất (tự xoá phần cũ hơn — lịch sử cũ mất hẳn, theo yêu cầu giảm dung lượng).
    stmts.push(env.DB.prepare(`DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY ts DESC, id DESC LIMIT ${LOG_KEEP})`));
    await env.DB.batch(stmts);
    return { ok: true };
  },

  async sync_get_logs(env, u, p) {
    const limit = Math.max(1, Math.min(Number(p.p_limit) || LOG_KEEP, 100));
    const { results } = await env.DB.prepare('SELECT * FROM logs ORDER BY ts DESC, id DESC LIMIT ?1').bind(limit).all();
    return { rows: results.map(r => ({ ts: r.ts, date: r.date, shift: r.shift, po: r.po, section: r.section, technician: r.technician,
      changes: parse(r.changes, []), user: r.user_name, machine: r.machine, action: r.action })) };
  },
};
const WRITE_RPCS = new Set(['sync_put_checkpoints', 'sync_delete_checkpoints', 'sync_put_meta', 'sync_post_logs']);

/* ---------------- Auth ---------------- */
async function issueTokens(env, user) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await signJwt({ sub: user.id, iat: now, exp: now + ACCESS_TTL }, env.JWT_SECRET);
  const refreshToken = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT INTO sessions (id, user_id, refresh_hash, expires_at) VALUES (?1,?2,?3,?4)')
    .bind(crypto.randomUUID(), user.id, await sha256hex(refreshToken), now + REFRESH_TTL).run();
  return { accessToken, refreshToken, expiresAt: now + ACCESS_TTL,
    user: { userId: user.id, displayName: user.display_name, username: user.username, role: user.role } };
}
function identifierToLookup(raw) {
  let id = String(raw || '').trim().toLowerCase();
  // Bản client cũ ghép username thành email giả <username>@<ref>.users.internal — vẫn nhận, chỉ lấy phần tên.
  if (id.endsWith('.users.internal')) id = id.split('@')[0];
  return id;
}
async function rateLimited(env, key) {
  const now = Math.floor(Date.now() / 1000);
  const r = await env.DB.prepare('SELECT n, window_start FROM login_attempts WHERE k = ?1').bind(key).first();
  return !!r && now - r.window_start < 900 && r.n >= 8;
}
async function recordFailure(env, key) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO login_attempts (k, n, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(k) DO UPDATE SET n = CASE WHEN ?2 - window_start >= 900 THEN 1 ELSE n + 1 END,
       window_start = CASE WHEN ?2 - window_start >= 900 THEN ?2 ELSE window_start END`).bind(key, now).run();
}
async function handleAuth(path, req, env) {
  const body = await req.json().catch(() => ({}));
  if (path === '/auth/login') {
    const ident = identifierToLookup(body.identifier);
    const password = String(body.password || '');
    if (!ident || !password) return { status: 400, body: { error: 'invalid_credentials' } };
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    const rlKey = ip + '|' + ident;
    if (await rateLimited(env, rlKey)) return { status: 429, body: { error: 'too_many_attempts' } };
    const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?1 OR username = ?1').bind(ident).first();
    const ok = user && !user.disabled ? (await hasher(env, { op: 'verify', password, hash: user.password_hash })).ok : false;
    if (!ok) { await recordFailure(env, rlKey); return { status: 401, body: { error: 'invalid_credentials' } }; }
    await env.DB.prepare('DELETE FROM login_attempts WHERE k = ?1').bind(rlKey).run();
    // Nâng cấp bcrypt (nhập từ Supabase) lên PBKDF2 ngay lần đăng nhập đầu — các lần sau không cần bcrypt nữa.
    if (String(user.password_hash).startsWith('$2')) {
      const { hash } = await hasher(env, { op: 'hash', password });
      await env.DB.prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2').bind(hash, user.id).run();
    }
    return { status: 200, body: await issueTokens(env, user) };
  }
  if (path === '/auth/refresh') {
    const now = Math.floor(Date.now() / 1000);
    const h = await sha256hex(String(body.refreshToken || ''));
    const s = await env.DB.prepare('SELECT id, user_id, expires_at FROM sessions WHERE refresh_hash = ?1').bind(h).first();
    if (!s || s.expires_at < now) return { status: 401, body: { error: 'invalid_refresh' } };
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(s.user_id).first();
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(s.id).run();
    if (!user || user.disabled) return { status: 401, body: { error: 'invalid_refresh' } };
    return { status: 200, body: await issueTokens(env, user) };
  }
  if (path === '/auth/logout') {
    if (body.refreshToken) await env.DB.prepare('DELETE FROM sessions WHERE refresh_hash = ?1').bind(await sha256hex(String(body.refreshToken))).run();
    return { status: 200, body: { ok: true } };
  }
  if (path === '/auth/bootstrap') {
    // Nhập tài khoản ban đầu (từ Supabase, giữ nguyên user_id + hash bcrypt) hoặc tạo Admin đầu tiên — cần BOOTSTRAP_TOKEN.
    if (!env.BOOTSTRAP_TOKEN) return { status: 404, body: { error: 'not_found' } };
    if (!timingSafeEqual(req.headers.get('X-Bootstrap-Token') || '', env.BOOTSTRAP_TOKEN)) return { status: 403, body: { error: 'forbidden' } };
    let inserted = 0, skipped = 0;
    for (const u of Array.isArray(body.users) ? body.users : []) {
      if (!u.id || !u.passwordHash || !['admin', 'user', 'supervisor'].includes(u.role || 'user')) { skipped++; continue; }
      const r = await env.DB.prepare(
        'INSERT OR IGNORE INTO users (id, email, username, display_name, role, disabled, password_hash) VALUES (?1,?2,?3,?4,?5,?6,?7)'
      ).bind(u.id, u.username ? null : (u.email || null), u.username || null, u.displayName || '', u.role || 'user', u.disabled ? 1 : 0, u.passwordHash).run();
      r.meta.changes > 0 ? inserted++ : skipped++;
    }
    if (body.createAdmin) {
      const a = body.createAdmin;
      const { hash } = await hasher(env, { op: 'hash', password: String(a.password || '') });
      const r = await env.DB.prepare('INSERT OR IGNORE INTO users (id, email, display_name, role, password_hash) VALUES (?1,?2,?3,\'admin\',?4)')
        .bind(crypto.randomUUID(), String(a.email || '').toLowerCase(), a.displayName || 'Admin', hash).run();
      r.meta.changes > 0 ? inserted++ : skipped++;
    }
    return { status: 200, body: { inserted, skipped } };
  }
  return { status: 404, body: { error: 'not_found' } };
}

/* ---------------- Quản lý tài khoản (thay Edge Function admin-users) — chỉ Admin ---------------- */
async function audit(env, actor, action, detail) {
  await env.DB.prepare('INSERT INTO member_audit (actor_id, actor_name, action, detail) VALUES (?1,?2,?3,?4)').bind(actor.id, actor.display_name, action, detail).run();
}
async function handleAdmin(env, caller, body) {
  const bad = (msg, status = 400) => ({ status, body: { error: msg } });
  const { action } = body;
  if (action === 'list-users') {
    const { results } = await env.DB.prepare('SELECT id, display_name, username, email, role, disabled, created_at FROM users').all();
    const users = results.map(r => ({ userId: r.id, displayName: r.display_name || 'N/A', username: r.username || null,
      email: r.username ? null : (r.email || '(Không có email)'), role: r.role, status: r.disabled ? 'Disabled' : 'Active', hasMemberRecord: true, createdAt: r.created_at }));
    users.sort((a, b) => a.role !== b.role ? (a.role === 'admin' ? -1 : 1) : a.displayName.localeCompare(b.displayName));
    return { status: 200, body: { users } };
  }
  if (action === 'create-user') {
    const name = String(body.displayName || '').trim(), username = String(body.username || '').trim().toLowerCase();
    const email = String(body.email || '').trim().toLowerCase(), password = String(body.password || '');
    const role = ['admin', 'supervisor'].includes(body.role) ? body.role : 'user';
    const usingUsername = !email && !!username;
    if (!name) return bad('Họ và tên không được để trống.');
    if (usingUsername) { if (!USERNAME_RE.test(username)) return bad('Tên đăng nhập không hợp lệ: 2-32 ký tự, chữ thường/số, có thể chứa . _ -, không bắt đầu/kết thúc bằng ký tự đặc biệt.'); }
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('Địa chỉ email không đúng định dạng.');
    if (password.length < 6) return bad('Mật khẩu phải có tối thiểu 6 ký tự.');
    const dup = await env.DB.prepare('SELECT 1 FROM users WHERE (?1 IS NOT NULL AND username = ?1) OR (?2 IS NOT NULL AND email = ?2)').bind(usingUsername ? username : null, usingUsername ? null : email).first();
    if (dup) return bad(usingUsername ? 'Tên đăng nhập đã được sử dụng.' : 'Email đã được sử dụng.');
    const { hash } = await hasher(env, { op: 'hash', password });
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users (id, email, username, display_name, role, disabled, password_hash) VALUES (?1,?2,?3,?4,?5,0,?6)')
      .bind(id, usingUsername ? null : email, usingUsername ? username : null, name, role, hash).run();
    await audit(env, caller, 'USER_CREATED', `Tạo người dùng ${name} (${usingUsername ? '@' + username : email}), vai trò: ${role}`);
    return { status: 200, body: { ok: true, user: { userId: id, displayName: name, email: usingUsername ? null : email, username: usingUsername ? username : null, role, status: 'Active' } } };
  }
  if (action === 'change-role') {
    const { targetUserId, newRole } = body;
    if (!targetUserId) return bad('Thiếu targetUserId');
    if (!['user', 'admin', 'supervisor'].includes(newRole)) return bad('Vai trò mới không hợp lệ (chỉ chấp nhận user, supervisor hoặc admin).');
    if (targetUserId === caller.id && newRole !== 'admin') {
      const other = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0 AND id<>?1").bind(caller.id).first();
      if (!other.n) return bad('Không thể hạ quyền: Bạn là Quản trị viên đang hoạt động duy nhất của hệ thống.');
    }
    const t = await env.DB.prepare('SELECT display_name, role FROM users WHERE id = ?1').bind(targetUserId).first();
    if (!t) return bad('Không tìm thấy người dùng.', 404);
    await env.DB.prepare('UPDATE users SET role = ?1 WHERE id = ?2').bind(newRole, targetUserId).run();
    await audit(env, caller, 'ROLE_CHANGED', `Đổi vai trò người dùng ${t.display_name} từ ${t.role} thành ${newRole}`);
    return { status: 200, body: { ok: true, role: newRole } };
  }
  if (action === 'disable-user' || action === 'enable-user') {
    const { targetUserId } = body;
    if (!targetUserId) return bad('Thiếu targetUserId');
    const disabling = action === 'disable-user';
    if (disabling && targetUserId === caller.id) return bad('Không thể tự vô hiệu hóa tài khoản của chính bạn.');
    const t = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?1').bind(targetUserId).first();
    if (!t) return bad('Không tìm thấy người dùng.', 404);
    await env.DB.prepare('UPDATE users SET disabled = ?1 WHERE id = ?2').bind(disabling ? 1 : 0, targetUserId).run();
    if (disabling) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(targetUserId).run();
    await audit(env, caller, disabling ? 'USER_DISABLED' : 'USER_ENABLED', `${disabling ? 'Vô hiệu hóa' : 'Kích hoạt lại'} người dùng ${t.display_name}`);
    return { status: 200, body: { ok: true, status: disabling ? 'Disabled' : 'Active' } };
  }
  return bad(`Action '${action}' không được hỗ trợ.`);
}

/* ---------------- Router ---------------- */
export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    const path = new URL(req.url).pathname;
    try {
      if (path.startsWith('/auth/')) {
        const r = await handleAuth(path, req, env);
        return json(r.body, req, env, r.status);
      }
      if (path === '/realtime') {
        if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
        if (!(await authUser(req, env))) return new Response('unauthorized', { status: 401 });
        return env.HUB.get(env.HUB.idFromName('main')).fetch(req);
      }
      if (path.startsWith('/rpc/') && req.method === 'POST') {
        const fn = path.slice(5);
        const u = await authUser(req, env);
        // Cùng quy ước cũ: lỗi quyền trả HTTP 200 + {error}, để cloudFetch xử lý 1 chỗ duy nhất.
        if (!u) return json({ error: 'unauthorized' }, req, env);
        if (!RPC[fn]) return json({ error: 'not_found' }, req, env, 404);
        const params = await req.json().catch(() => ({}));
        const out = await RPC[fn](env, u, params || {});
        if (WRITE_RPCS.has(fn) && !out.error) broadcast(env, ctx);
        return json(out, req, env);
      }
      if (path === '/admin/users' && req.method === 'POST') {
        const u = await authUser(req, env);
        if (!u) return json({ error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' }, req, env, 401);
        if (!isAdmin(u)) return json({ error: 'Từ chối truy cập: Yêu cầu quyền Quản trị viên (Admin).' }, req, env, 403);
        const r = await handleAdmin(env, u, await req.json().catch(() => ({})));
        return json(r.body, req, env, r.status);
      }
      if (path === '/' || path === '/health') return json({ ok: true, service: 'shiftly-report-api' }, req, env);
      return json({ error: 'not_found' }, req, env, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'internal_error' }, req, env, 500);
    }
  },
};
