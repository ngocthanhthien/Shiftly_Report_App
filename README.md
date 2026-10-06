# Shiftly Report

QC shift-report app for ILD Coffee Vietnam's freeze-dried coffee line —
single-file offline-first PWA with multi-device sync.

- **App**: [`index.html`](index.html) — one static file (HTML + CSS + JS inline,
  Vietnamese UI, no build step), hosted on GitHub Pages at
  `https://ngocthanhthien.github.io/Shiftly_Report_App/`.
- **Backend**: [`cloudflare/`](cloudflare/README.md) — a Cloudflare Worker with a
  D1 database (accounts, checkpoints, lists, logs), an R2 bucket (photos) and
  two Durable Objects (password hashing, realtime wake-up signal).
- **Handoff / design notes**: [`HANDOFF.md`](HANDOFF.md).

The 10-tab UI: Nhập liệu, Báo cáo, Dữ liệu, Danh sách Items Code, Danh sách
Client, Specs, Data Log, Danh sách PO, Cài đặt (includes export/import and the
Data & Egress Control card), Hướng dẫn. Recipe is not a separate list — it is
looked up automatically from Item Code.

## Architecture

IndexedDB is the source of truth on every device: every save goes to the local
database first, then into an outbox that is pushed to the Worker whenever the
device is online (offline entry keeps working). `index.html` calls the Worker's
`POST /rpc/sync_*` endpoints directly, authenticated as a real signed-in user
(Admin: email + password; Nhân viên/Giám sát: username + password). Every
request re-checks on the server that the account is active and allowed to do
the action (supervisors are read-only; the egress limits are Admin-only), so
knowing the URL grants nothing. Conflicts are last-write-wins by `updatedAt`;
the pull cursor is a server-assigned sequence (`seq`), never a client clock.
Photos live in R2 and are fetched separately, only when new or changed. A
WebSocket (`/realtime`) pings other devices right after someone saves; ~15-60 s
polling is the fallback. See the `CLOUD SYNC` and `ACCESS CONTROL` sections at
the top of the script in `index.html`, and [`HANDOFF.md`](HANDOFF.md).

## Deploy

- **Frontend**: push to `main`; GitHub Pages (deploy from `main`, root folder)
  serves `index.html` within about a minute.
- **Backend**: see [`cloudflare/README.md`](cloudflare/README.md)
  (`npx wrangler login`, create D1 + R2, apply `schema.sql`, set secrets,
  `npx wrangler deploy`, then import accounts with `/auth/bootstrap`).

## Tests

```bash
npm ci
npm test
```

Runs the real Worker inside Cloudflare's local runtime (Miniflare: real D1, R2
and Durable Objects) and boots the real `index.html` in jsdom against it, plus
UI/logic tests for each tab. `supabase/` is the retired Supabase backend, kept
only as a historical snapshot (git tag `pre-cloudflare`).
