# Shiftly Report

QC shift-report app for ILD Coffee Vietnam's freeze-dried coffee line —
single-file offline-first PWA, with optional multi-device sync.

- **Offline app**: `Shiftly_Report_App.html` — fully offline, no network
  dependency at all. Meant to run locally on the tablets at the plant.
- **Online app**: [`index.html`](index.html) — identical UI/business logic,
  plus optional background sync so multiple tablets/PCs can share one data
  set. Hosted as a static site (GitHub Pages); data lives in a Supabase
  (Postgres) project — see [`supabase/README.md`](supabase/README.md) for
  the one-time setup (paste one SQL file into the Supabase dashboard, no
  CLI needed).

The 13-tab UI (Nhập liệu, Dữ liệu, Truy xuất, Danh sách PO/Recipe/Client,
Data Log, Báo cáo, Thống kê, Specs, Xuất nhập dữ liệu, Cài đặt, Hướng dẫn)
is the same in both builds.

## Architecture (online build)

There is no custom backend server. `index.html` talks directly to
Supabase's PostgREST RPC endpoint using the public `anon` key; every real
table (`checkpoints`, `meta`, `logs`) has Row Level Security enabled with
**no policies**, so direct REST access is denied outright. The only way in
is through a handful of `sync_*` SQL functions (SECURITY DEFINER) that each
check a shared secret argument themselves — see
[`supabase/schema.sql`](supabase/schema.sql). That secret is set once via
`select set_sync_secret('...')` in the Supabase SQL Editor and is never
committed to this repo; each device enters it in the app's Cài đặt tab.

IndexedDB remains the source of truth on every device (offline-first,
unchanged from the original app) — writes go into a local `outbox` and get
pushed to Supabase whenever the device is online, with an incremental
`seq`-based pull for whatever other devices pushed. See the `CLOUD SYNC`
section at the top of `index.html` for the full design notes, including why
the sync cursor is a server-assigned sequence rather than a timestamp
(client clocks drift — a phone with the wrong time must never cause another
device to silently miss data).

A Supabase Realtime Broadcast channel (`shiftly-changes`) pings every
connected device the instant one of them pushes a change, so sync is
effectively immediate when the WebSocket connects; ~15-20s polling (already
resilient to backgrounded tabs and reconnects) is the fallback when it
doesn't. Broadcast carries no data — actual reads still only ever happen
through the secret-checked RPCs above, so this adds no new access path.

## Deploy

1. Push this repo to GitHub, enable **GitHub Pages** (Settings → Pages →
   deploy from the `main` branch, root folder). `index.html` is served at
   the resulting `https://<user>.github.io/<repo>/` URL automatically on
   every push — no build step.
2. Set up the Supabase project once — see
   [`supabase/README.md`](supabase/README.md).
3. Open the published URL → tab Cài đặt → enter the Supabase URL, anon key,
   and sync password from step 2.

## Tests

```bash
npm ci
npm test
```

Runs against a real embedded Postgres (`@electric-sql/pglite`) executing
the actual `supabase/schema.sql` — not a hand-written mirror — plus a full
jsdom boot of `index.html` that exercises the real sync code path end to
end. See `tests/`.
