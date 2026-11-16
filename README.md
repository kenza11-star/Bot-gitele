# GitHub Manager Bot V2 — Production Final

Public multi-user Telegram bot built on the existing Next.js / PostgreSQL / Supabase / GitHub App project. Every user connects their own GitHub account. Normal commands are public; `/admin` remains owner-only.

**Browser pipeline:** Telegram `/upload` → signed direct-to-private-Storage chunks → durable PostgreSQL queue → background worker → validated ZIP → update-only GitHub commit → branch confirmation → Telegram progress and text/GIF result. ZIP limit: **100 MiB**.

Stage 4 adds existing-branch selection, safe APK streaming/extraction and Release fallback, durable webhook delivery claims, upload-session revocation, account-switch isolation, actual pg TLS override protection, protected readiness/worker heartbeats and a safe executable webhook activation script. Existing features and environment variable names remain.

## Run and verify

Use **Node.js 24.x**.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run worker -- --help
npm run telegram:activate -- --dry-run
```

`npm start` serves the built web app. `npm run worker` starts the required separate always-on processor with the same existing environment values.

## Deploy

1. Existing Stage 3 database: apply **0007_production_hardening.sql**. Fresh database: apply 0001–0007 in order.
2. Keep `github-uploads` private and permit 8 MiB octet-stream chunk objects.
3. Deploy the project as Next.js at the correct Vercel root, targeting **https://bot-xsync-delta.vercel.app**.
4. Keep all existing ENV names. Set `APP_URL=https://bot-xsync-delta.vercel.app`; OAuth callback is `/github/callback`.
5. Deploy/run the included worker and check readiness.
6. Run `npm run telegram:activate` with existing environment values loaded on a trusted host. It checks deployment first, registers the implemented `/api/telegram/webhook` with secret_token, then verifies getWebhookInfo. It does not print tokens or discard pending updates.
7. Test a real non-admin user and inspect the confirmed commit/Telegram result.

Complete commands, SQL, permissions, monitoring and blockers: **[docs/PRODUCTION-DEPLOYMENT.md](docs/PRODUCTION-DEPLOYMENT.md)**.

Actual audit changes and verification results: **[PRODUCTION-REPORT.md](PRODUCTION-REPORT.md)**. Historical Stage 2.5/3 reports and documentation are retained; the final deployment guide supersedes their setup steps.

## Operational status

This is the complete final source package, **not a claim that production infrastructure has already been activated**. The Vercel API inspection was blocked by account permission (403). The public domain responded, but the deployed uploader/callback returned 404 during this audit. Production secrets were not requested or printed; no live webhook registration or database migration was performed. Follow the deployment and acceptance checks before declaring the bot operational.
