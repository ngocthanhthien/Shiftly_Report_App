import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import bcrypt from 'bcryptjs';

// Khởi động Worker THẬT (cloudflare/src/worker.js) trong workerd cục bộ (Miniflare: D1 + R2 + Durable Object thật) — dùng
// chung cho các test đầu-cuối chạy app (jsdom) nói chuyện với backend.
export const ORIGIN = 'https://ngocthanhthien.github.io';
export const API = 'http://api.test';
const schemaSql = readFileSync(new URL('../../cloudflare/schema.sql', import.meta.url), 'utf8');

export async function startBackend() {
  const entry = new URL('../../cloudflare/src/worker.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const out = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
    mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'] });
  const mf = new Miniflare({
    modules: true, script: out.outputFiles[0].text, compatibilityDate: '2025-09-01',
    d1Databases: { DB: 'test-db' }, r2Buckets: { IMAGES: 'test-images' },
    durableObjects: { HASHER: { className: 'Hasher', useSQLite: true }, HUB: { className: 'Hub', useSQLite: true } },
    bindings: { JWT_SECRET: 'test-secret-test-secret-test-secret-1234', ALLOWED_ORIGINS: ORIGIN, BOOTSTRAP_TOKEN: 'boot-token' },
  });
  const db = await mf.getD1Database('DB');
  const images = await mf.getR2Bucket('IMAGES');
  for (const s of schemaSql.replace(/--[^\n]*/g, '').split(';').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean)) await db.prepare(s).run();
  return { mf, db, images };
}

// Tài khoản dùng bcrypt — cùng định dạng hash mà Supabase Auth đang lưu (mật khẩu cũ phải dùng được nguyên vẹn).
export async function seedUsers(mf) {
  const mk = (o, pw) => ({ id: crypto.randomUUID(), ...o, passwordHash: bcrypt.hashSync(pw, 10) });
  const users = {
    admin: mk({ email: 'admin@example.com', displayName: 'Quản trị', role: 'admin' }, 'adminpass'),
    user: mk({ username: 'qa1', displayName: 'QA Một', role: 'user' }, 'userpass'),
  };
  const res = await mf.dispatchFetch(API + '/auth/bootstrap', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bootstrap-Token': 'boot-token' }, body: JSON.stringify({ users: Object.values(users) }) });
  await res.json();
  return users;
}
