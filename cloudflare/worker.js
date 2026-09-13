// Shiftly Report — Cloud Sync API (Cloudflare Worker)
// Bindings expected (see wrangler.toml):
//   DB      — D1 database (schema.sql)
//   IMAGES  — R2 bucket (attached photos)
//   SYNC_SECRET — secret string, set with: wrangler secret put SYNC_SECRET
//
// All endpoints are protected by a single shared secret, checked as either
// the "X-Sync-Secret" header (used by the app's JSON calls) or a "secret"
// query param (needed for plain <img src="..."> / <image href="..."> loads,
// which cannot send custom headers).

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Secret',
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS),
  });
}

function checkSecret(request, env, url) {
  const provided = request.headers.get('X-Sync-Secret') || url.searchParams.get('secret') || '';
  return !!env.SYNC_SECRET && provided === env.SYNC_SECRET;
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

function rowToCheckpoint(r) {
  return {
    key: r.key, date: r.date, shift: r.shift, section: r.section, po: r.po,
    recipe: r.recipe, client: r.client, technician: r.technician,
    fields: safeParse(r.fields_json, {}), fieldNotes: safeParse(r.field_notes_json, {}),
    images: safeParse(r.images_json, []), updatedAt: r.updated_at, deleted: !!r.deleted,
  };
}

function rowToLog(r) {
  return {
    id: r.id, ts: r.ts, date: r.date, shift: r.shift, po: r.po,
    section: r.section, technician: r.technician, changes: safeParse(r.changes_json, []),
  };
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// The incremental sync cursor ("since=...") MUST be assigned by the server
// in write order — never derived from a client-supplied timestamp. Two
// devices' clocks are never perfectly in sync (phones especially drift or
// get set wrong), so a checkpoint pushed with an earlier client `updatedAt`
// than another device's last-seen cursor would be silently and permanently
// excluded from that device's future pulls even though it's a brand-new
// change. `seq` is a plain incrementing counter bumped on every write,
// independent of any device's clock.
async function nextSeq(env) {
  const row = await env.DB.prepare('UPDATE sync_seq SET value = value + 1 WHERE id = 1 RETURNING value').first();
  return row.value;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname.startsWith('/images/')) {
      // Deliberately NOT secret-gated: object ids are random UUIDs (unguessable),
      // and leaving GET open means the standalone "báo cáo HTML đầy đủ" export
      // (a plain .html file people forward around) can embed working <img>
      // links without baking the shared secret into a file that leaves the app.
      // Uploading (POST, below) still requires the secret.
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      const id = url.pathname.slice('/images/'.length);
      const obj = await env.IMAGES.get(id);
      if (!obj) return new Response('Not found', { status: 404, headers: CORS_HEADERS });
      const headers = Object.assign(
        { 'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000' },
        CORS_HEADERS
      );
      return new Response(obj.body, { headers });
    }

    if (!url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    if (!checkSecret(request, env, url)) return json({ error: 'unauthorized' }, 401);

    const now = new Date().toISOString();

    if (url.pathname === '/api/checkpoints' && request.method === 'GET') {
      const sinceSeq = parseInt(url.searchParams.get('since') || '0', 10) || 0;
      const { results } = await env.DB.prepare('SELECT * FROM checkpoints WHERE seq > ?1 ORDER BY seq ASC LIMIT 5000').bind(sinceSeq).all();
      const cursor = results.length ? results[results.length-1].seq : sinceSeq;
      // Include ties created by the original migration before advancing the cursor.
      const tail = results.length===5000 ? await env.DB.prepare('SELECT * FROM checkpoints WHERE seq = ?1').bind(cursor).all() : {results:[]};
      const rows = [...new Map([...results,...tail.results].map(r=>[r.key,r])).values()];
      return json({serverTime:now,rows:rows.map(rowToCheckpoint),cursor,hasMore:results.length===5000});
    }

    if (url.pathname === '/api/checkpoints' && request.method === 'PUT') {
      const body = await request.json();
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const results = [];
      for (const cp of rows) {
        if (!cp || !cp.key || !cp.updatedAt) { results.push({ key: cp && cp.key, applied: false, reason: 'invalid' }); continue; }
        const current = await env.DB.prepare('SELECT updated_at FROM checkpoints WHERE key = ?1').bind(cp.key).first();
        if (!current || cp.updatedAt > current.updated_at) {

          await env.DB.batch([env.DB.prepare('UPDATE sync_seq SET value=value+1 WHERE id=1'), env.DB.prepare(
            `INSERT INTO checkpoints (key,date,shift,section,po,recipe,client,technician,fields_json,field_notes_json,images_json,updated_at,deleted,seq)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0,(SELECT value FROM sync_seq WHERE id=1))
             ON CONFLICT(key) DO UPDATE SET
               date=excluded.date, shift=excluded.shift, section=excluded.section, po=excluded.po,
               recipe=excluded.recipe, client=excluded.client, technician=excluded.technician,
               fields_json=excluded.fields_json, field_notes_json=excluded.field_notes_json,
               images_json=excluded.images_json, updated_at=excluded.updated_at, deleted=0, seq=excluded.seq WHERE excluded.updated_at > checkpoints.updated_at`
          ).bind(
            cp.key, cp.date, cp.shift, cp.section, cp.po || '', cp.recipe || '', cp.client || '', cp.technician || '',
            JSON.stringify(cp.fields || {}), JSON.stringify(cp.fieldNotes || {}), JSON.stringify(cp.images || []), cp.updatedAt
          )]);
          results.push({ key: cp.key, applied: true });
        } else {
          results.push({ key: cp.key, applied: false, reason: 'stale' });
        }
      }
      return json({ serverTime: now, results });
    }

    if (url.pathname === '/api/checkpoints' && request.method === 'DELETE') {
      const body = await request.json();
      const keys = Array.isArray(body.keys) ? body.keys : [];
      const updatedAt = body.updatedAt || now;
      for (const key of keys) {
        const current = await env.DB.prepare('SELECT updated_at FROM checkpoints WHERE key = ?1').bind(key).first();
        if (!current) {

          await env.DB.batch([env.DB.prepare('UPDATE sync_seq SET value=value+1 WHERE id=1'), env.DB.prepare(
            `INSERT INTO checkpoints (key,date,shift,section,po,recipe,client,technician,fields_json,field_notes_json,images_json,updated_at,deleted,seq)
             VALUES (?1,'','','','','','','','{}','{}','[]',?2,1,(SELECT value FROM sync_seq WHERE id=1)) ON CONFLICT(key) DO UPDATE SET deleted=1,updated_at=excluded.updated_at,seq=excluded.seq WHERE excluded.updated_at > checkpoints.updated_at`
          ).bind(key, updatedAt)]);
        } else if (updatedAt > current.updated_at) {

          await env.DB.batch([env.DB.prepare('UPDATE sync_seq SET value=value+1 WHERE id=1'), env.DB.prepare('UPDATE checkpoints SET deleted=1, updated_at=?1, seq=(SELECT value FROM sync_seq WHERE id=1) WHERE key=?2 AND updated_at < ?1').bind(updatedAt, key)]);
        }
      }
      return json({ serverTime: now });
    }

    if (url.pathname === '/api/meta' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM meta').all();
      const items = {};
      for (const r of results) items[r.k] = { value: safeParse(r.value_json, null), updatedAt: r.updated_at };
      return json({ serverTime: now, items });
    }

    if (url.pathname === '/api/meta' && request.method === 'PUT') {
      const body = await request.json();
      const items = body.items || {};
      const results = {};
      for (const key of Object.keys(items)) {
        const incoming = items[key];
        if (!incoming || !incoming.updatedAt) { results[key] = { applied: false, reason: 'invalid' }; continue; }
        const current = await env.DB.prepare('SELECT updated_at FROM meta WHERE k = ?1').bind(key).first();
        if (!current || incoming.updatedAt > current.updated_at) {
          await env.DB.batch([env.DB.prepare('UPDATE sync_seq SET value=value+1 WHERE id=1'), env.DB.prepare(
            `INSERT INTO meta (k, value_json, updated_at) VALUES (?1,?2,?3)
             ON CONFLICT(k) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at WHERE excluded.updated_at > meta.updated_at`
          ).bind(key, JSON.stringify(incoming.value), incoming.updatedAt)]);
          results[key] = { applied: true };
        } else {
          results[key] = { applied: false, reason: 'stale' };
        }
      }
      return json({ serverTime: now, results });
    }

    if (url.pathname === '/api/logs' && request.method === 'GET') {
      const since = url.searchParams.get('since') || '';
      const stmt = since
        ? env.DB.prepare('SELECT * FROM logs WHERE ts > ?1 ORDER BY ts ASC LIMIT 5000').bind(since)
        : env.DB.prepare('SELECT * FROM logs ORDER BY ts DESC LIMIT 1000');
      const { results } = await stmt.all();
      return json({ serverTime: now, entries: results.map(rowToLog) });
    }

    if (url.pathname === '/api/logs' && request.method === 'POST') {
      const body = await request.json();
      const entries = Array.isArray(body.entries) ? body.entries : [];
      for (const e of entries) {
        await env.DB.prepare(
          'INSERT INTO logs (ts,date,shift,po,section,technician,changes_json) VALUES (?1,?2,?3,?4,?5,?6,?7)'
        ).bind(e.ts || now, e.date || '', e.shift || '', e.po || '', e.section || '', e.technician || '', JSON.stringify(e.changes || [])).run();
      }
      return json({ serverTime: now });
    }

    if (url.pathname === '/api/images' && request.method === 'POST') {
      const body = await request.json();
      const dataUrl = body.dataUrl || '';
      const m = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
      if (!m) return json({ error: 'invalid dataUrl' }, 400);
      const contentType = m[1];
      const bytes = base64ToBytes(m[2]);
      const ext = contentType === 'image/png' ? 'png' : 'jpg';
      const id = crypto.randomUUID() + '.' + ext;
      await env.IMAGES.put(id, bytes, { httpMetadata: { contentType } });
      return json({ id, url: `${url.origin}/images/${id}` });
    }

    return json({ error: 'not found' }, 404);
  },
};
