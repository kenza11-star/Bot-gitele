# GitHub Manager Bot — Foundation Release (v0.1.0)

This is the first slice of the GitHub Manager Bot specification. It is not the complete product.

## Implemented
- Environment validation (12 required variables, clear error messages)
- AES-256-GCM encryption helpers for stored secrets
- Telegram webhook endpoint with secret-token verification
- /start, /help, and unknown-command replies
- PostgreSQL schema (migration 0001) in a private `app` schema with RLS enabled
- Unit tests for env validation, encryption, and webhook authentication

## Not implemented yet
- GitHub App login, installation handling, and credential storage
- Repository selector, ZIP upload, push/commit workflow
- GitHub Actions monitoring, artifact and release downloads
- GitHub webhook receiver and build notifications
- Admin dashboard, Telegram bot status panel, admin login, activity logs
- Supabase Storage integration (SUPABASE_* variables are reserved in .env.example)
- Reply and inline keyboards for the bot menu

## Setup (foundation only)
1. Copy `.env.example` to `.env.local` and fill in values.
2. Run `npm install`. This release ships without a lockfile; commit one after the first install.
3. Apply `db/migrations/0001_init.sql` to Supabase.
4. Run `npm test`, `npm run typecheck`, `npm run build`.
5. Register the Telegram webhook at `APP_URL/api/telegram/webhook` with `secret_token` set to `TELEGRAM_WEBHOOK_SECRET`.

## Verification status
Source files are written but have not been compiled, type-checked, or tested in the environment that produced them.
