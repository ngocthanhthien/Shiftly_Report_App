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

The 14-tab UI (Nhập liệu, Dữ liệu, Truy xuất, Danh sách PO/Recipe/Client,
Danh sách Items Code, Data Log, Báo cáo, Thống kê, Specs, Xuất nhập dữ liệu,
Cài đặt, Hướng dẫn) is the same in both builds.

## Architecture (online build)

There is no custom backend server beyond one small Supabase Edge Function
for account management. `index.html` talks directly to Supabase's PostgREST
RPC endpoint, authenticated as a real Supabase Auth user (Admin: email +
password; User: username + password, mapped internally to a synthetic
email); every real table (`checkpoints`, `meta`, `logs`, `members`,
`member_audit`) has Row Level Security enabled with **no policies**, so
direct REST access is denied outright even to a signed-in user. The only way
in is through a handful of `sync_*` SQL functions (SECURITY DEFINER) that
each check the caller is a signed-in, non-disabled row in `members` — see
[`supabase/schema.sql`](supabase/schema.sql). Creating/disabling accounts
needs the `service_role` key, which never reaches the browser — that only
happens inside [`supabase/functions/admin-users`](supabase/functions/admin-users),
which an Admin calls from the app's Cài đặt tab. See
[`supabase/README.md`](supabase/README.md) for the one-time setup (paste
`schema.sql`, then deploy that one Edge Function with the Supabase CLI).

IndexedDB remains the source of truth on every device (offline-first,
unchanged from the original app) — writes go into a local `outbox` and get
pushed to Supabase whenever the device is online, with an incremental
`seq`-based pull for whatever other devices pushed. See the `CLOUD SYNC` and
`ACCESS CONTROL` sections at the top of `index.html` for the full design
notes, including why the sync cursor is a server-assigned sequence rather
than a timestamp (client clocks drift — a phone with the wrong time must
never cause another device to silently miss data). If cloud sync isn't
configured at all, none of the login gate applies — the app works exactly
like before, fully offline, no account needed.

A Supabase Realtime Broadcast channel (`shiftly-changes`) pings every
connected device the instant one of them pushes a change, so sync is
effectively immediate when the WebSocket connects; ~15-20s polling (already
resilient to backgrounded tabs and reconnects) is the fallback when it
doesn't. Broadcast carries no data — actual reads still only ever happen
through the auth-checked RPCs above, so this adds no new access path.

## Deploy

1. Push this repo to GitHub, enable **GitHub Pages** (Settings → Pages →
   deploy from the `main` branch, root folder). `index.html` is served at
   the resulting `https://<user>.github.io/<repo>/` URL automatically on
   every push — no build step.
2. Set up the Supabase project once (schema + first Admin account + the
   admin-users Edge Function) — see [`supabase/README.md`](supabase/README.md).
3. Open the published URL → tab Cài đặt → enter the Supabase URL and anon
   key from step 2 → log in with the Admin account you just created.

## Tests

```bash
npm ci
npm test
```

Runs against a real embedded Postgres (`@electric-sql/pglite`) executing
the actual `supabase/schema.sql` — not a hand-written mirror — plus a full
jsdom boot of `index.html` that exercises the real sync code path end to
end. See `tests/`.
