# Shiftly Report

Production UI: https://shiftly-report-app.dangthanhbinh53.workers.dev/

The frontend requires HTTP Basic login before serving any route or static asset. Credentials are stored as `APP_USERNAME` and `APP_PASSWORD` secrets on `shiftly-report-app`. Change them through Cloudflare Secrets; never put their values in this repository. The browser displays its native username/password prompt. The backend still requires its separate `SYNC_SECRET`; existing legacy image links and backend clients retain their original behavior. Previously downloaded offline HTML and already-open pages are not remotely locked by this gateway.

The 13-tab UI is unchanged. The production site serves its API at `/api/*` and images at `/images/*` through a Cloudflare service binding to `shiftly-report-sync`. The existing sync Worker remains available for older devices and exported image URLs, using its existing SYNC_SECRET. No secret is committed to this repository.

## Deploy

Node.js 24+, `npm ci`, then `npm run deploy`.
The `npm run deploy` command runs regression tests, deploys the compatibility backend, then deploys the frontend. The frontend build only tests and generates `public/index.html`; it never deploys recursively. Cloudflare Workers Builds uses `npm run deploy` as its deploy command. Both Workers now live in one repository/release workflow.

Existing devices on the production site automatically use same-origin API requests, preserving their configured password. Other sites or custom backend URLs are preserved. D1 and R2 bindings reuse the existing resources; no database migration or destructive reset is needed.

## Sync behavior

- Local changes queue immediately; latest checkpoint/meta replaces earlier pending versions. Logs remain separate.
- Legacy outbox entries compact on startup in one IndexedDB transaction.
- Foreground idle polling grows from 20 to 120 seconds. Network errors back off to 300 seconds. Hidden tabs stop background polling. Saving still schedules a push within 800 ms.
- API requests have a 30-second timeout and send the secret in a header.
- Checkpoint upload batches contain at most 10 records.
- Server sequence assignment and checkpoint writes share an atomic D1 batch. Pulls advance only through returned rows, including legacy ties, and follow pagination.
- Background sync does not rebuild in-progress forms. Navigate to a tab to render refreshed cache contents.

## Rollback

Frontend previous production version: `9b3cc14e` (Git commit `0f5acb5c83d26d12c1efe74a577e8157485e12c9`). Backend previous version: `f425a6a2-fd84-4c9e-831a-d73ceb86e360`. Roll back code through Cloudflare Deployments if needed. Do not roll back the database for a code-only issue; production writes may have occurred since backup.

The offline-only HTML is maintained outside this repository and is unaffected by online storage changes.
