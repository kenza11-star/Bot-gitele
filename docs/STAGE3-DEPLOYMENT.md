# Stage 3 deployment

The application is connected end-to-end in code. It is **not an already running service**. Deploy both the Next.js application and the executable background worker before expecting automatic GitHub commits or Telegram progress.

## Architecture

1. Private Telegram `/upload` mints a signed user/repository/branch-scoped browser link.
2. Browser uploads 8 MiB chunks directly to the existing private `github-uploads` bucket. API completion verifies each stored chunk's size and SHA-256.
3. `/ready` performs a short, atomic completeness check and persists `uploaded`. This is the queue entry; it does not run an unawaited processor or claim GitHub success.
4. An always-on Node worker polls PostgreSQL every second, atomically claims one eligible job with `FOR UPDATE SKIP LOCKED`, and renews its 90-second lease every 30 seconds.
5. Worker revalidates all chunk indexes/sizes/hashes, assembles at most 100 MiB, verifies the whole-file hash, validates ZIP metadata/CRC/paths/expansion, and extracts at most 300 MiB / 20,000 files.
6. It retrieves the original Telegram user's current GitHub credential and rechecks their GitHub App installation access. It snapshots the original selected branch, compares files, and persists a per-path manifest. No filenames/extensions are filtered. UTF-8 and CP437 ZIP names are decoded; Unicode path extras are supported.
7. Distinct changed blobs are uploaded with adaptive concurrency 6–16 and a separate base64 byte-allocation gate. Unchanged or already-present blob objects are reused. Content mutation budgets are persisted per user across worker replicas (60/minute, 400/hour), with Retry-After and GitHub reset handling.
8. The base tree is preserved for UPDATE ONLY. A tree and deterministic commit are checkpointed. The branch update uses `force:false`, then the worker reads the branch and confirms the commit or its ancestry before storing `completed`.
9. A separate, awaited notification loop polls persisted progress once a second. It edits one progress message, at most every three seconds per chat, with a shared bot-wide pacing gate. A confirmed final summary is sent automatically, followed by the bundled GIF when available. Animation failure never suppresses the text summary.

Only one job runs per worker process. Run more replicas for independent jobs; leases/fencing and shared budgets protect the queue. Parallel API requests do not imply multiple physical internet connections. Node fetch uses its normal connection pooling.

## Database

For an existing Stage 2.5 database, apply **`db/migrations/0006_github_processing.sql`** once before deploying Stage 3. It is additive and re-runnable. It adds leases, checkpoints, counters, delivery state, per-file manifests, API budgets and chat throttling. It fills a missing private progress chat with that job's Telegram owner ID. It deletes no user/job/file data. All new tables have RLS and revoke anon/authenticated access.

For a fresh database, apply 0001 through 0006 in order. Do not replay 0001–0003 on an existing database.

Example from a trusted administrator shell with a PostgreSQL client:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0006_github_processing.sql
```

Keep database TLS verified; provide `DATABASE_CA_CERT` only when the default CA trust does not validate your database. Use the same private application schema and appropriately privileged database role as Stage 2.5. Never expose `app` through a public Data API grant.

## Environment — no variable renamed

The worker uses the same values as the Next.js application:

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY_BASE64`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_SLUG`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET=github-uploads`, `ENCRYPTION_KEY`, `TELEGRAM_ALLOWED_USER_IDS`, `APP_URL`.

Preserve optional `CRON_SECRET` and `DATABASE_CA_CERT`. There is no new worker URL, shared worker HTTP secret, or public trigger endpoint. The only optional runtime tuning shown here is the standard worker-only `NODE_OPTIONS`; it does not rename any Vercel variable.

Use a private environment file on your worker host. Copy `.env.example` to `.env.worker`, fill it outside source control and restrict permissions. The worker must be able to reach PostgreSQL, Supabase Storage, `api.github.com`, `github.com` (OAuth refresh), and `api.telegram.org` over TLS. Set `APP_URL` to your real HTTPS Vercel deployment.

## Worker entry points

Use Node.js 24 LTS (the tested local runtime is 24.22.1). From the project root:

```sh
npm ci
npm run worker -- --help
npm run worker:check
npm run worker
```

Load environment variables through your host/service manager, or with Node's environment-file support:

```sh
node --env-file=.env.worker --import tsx src/worker.ts --check
node --env-file=.env.worker --import tsx src/worker.ts
```

`--check` validates required configuration and migration presence through a real database query; it fails if credentials/schema are unavailable. `--once` processes at most one queued job, then attempts pending notifications and exits. The default command is the continuous production worker. `SIGTERM`/`SIGINT` stop new claims and abort active GitHub work; an interrupted lease becomes eligible for recovery after expiry.

Recommended starting allocation: **2 GiB RAM per worker**, with Node heap 1536 MiB as shown. Increase for overhead on constrained hosts or measure your workload. The worker buffers bounded archives/extracted files; it is not a constant-memory streaming extractor. The 100 MiB exact-size test ran locally, but no production-host memory/throughput guarantee is claimed.

### Docker Compose on an always-on host

```sh
cp .env.example .env.worker
# Fill .env.worker with the existing application values; do not commit it.
chmod 600 .env.worker
docker compose -f compose.worker.yaml build
docker compose -f compose.worker.yaml run --rm worker node --import tsx src/worker.ts --check
docker compose -f compose.worker.yaml up -d
docker compose -f compose.worker.yaml logs -f worker
```

The image runs the worker directly as an unprivileged user. Compose uses a read-only filesystem and ephemeral `/tmp`. A managed always-on container/background-worker service can use the same `Dockerfile.worker` and command. Do not deploy this daemon as an autoscaling Vercel Function or a container Function that scales to zero between requests.

### Linux systemd alternative

Install the project and production dependencies under `/opt/github-manager-bot`, create an unprivileged `github-manager` service account, and put the existing environment values in root-owned `/etc/github-manager-worker.env` with mode 0600. Review `deploy/github-manager-worker.service`, including the installed Node binary path. Install and enable it with systemd. The service keeps no durable local state; PostgreSQL and Supabase hold all checkpoints and file data.

Docker/systemd deployment examples are supplied code/configuration; neither was deployed from this task.

## Next.js / Vercel

Deploy the existing Next.js application normally, with the same environment names and existing Telegram webhook URL/secret. The browser PUT continues to bypass the Function payload boundary. `/ready` now queues quickly; chunk verification requests still read one bounded chunk.

The actual selected Vercel account/plan was not supplied or inspected. Official documentation checked for this task lists:

| Configuration | Hobby maximum | Pro maximum | Enterprise maximum |
| --- | --- | --- | --- |
| Fluid Compute, Node.js | 300 sec | 800 sec | 800 sec |
| Fluid disabled, legacy duration | 60 sec | 300 sec | 900 sec |

The standard request/response payload limit is 4.5 MB. Extended duration/beta availability is not assumed. The external worker has no dependency on a Vercel Function staying alive for an entire upload. Check the actual dashboard settings and billing plan before deployment; we cannot verify those from the source ZIP.

The daily cleanup cron is preserved, but **is not the processing trigger**. Continuous worker polling triggers jobs; the worker also attempts small cleanup batches every minute. `CRON_SECRET` enables the existing optional HTTP cron route independently.

## Required GitHub permissions

Use each user's GitHub App user token and accessible installations. Repository Contents read/write and Metadata read are needed. Keep Actions read for the existing APK/workflow commands. Changing `.github/workflows/*.yml` or `.yaml` additionally requires **Workflows: read and write**; installation owners must accept updated permissions. Branch protection may reject direct pushes even with these permissions; the job fails clearly without forcing the branch. GitHub App installation/user permissions and organization policies remain authoritative.

The repository/selected branch must already contain an initial commit. Empty repositories are rejected clearly; initialize a README in GitHub first. This version does not create a hidden bootstrap commit or an unrequested file.

## Cancellation, recovery and notification guarantees

- Users can cancel in the browser, using the progress message button, or `/cancel [job UUID]` privately. Ownership is checked server-side. Without an ID, `/cancel` targets that user's latest active upload.
- Cancellation closes queued/processing work and invalidates its lease. Disconnecting GitHub also cancels that user’s pending work before the publication boundary. Already uploaded unreferenced Git objects may remain on GitHub. Nothing absent from the ZIP is deleted.
- Once a durable publication marker is written immediately before the branch update, cancellation returns an explicit 409: the remote operation may already have succeeded. The worker must reconcile the branch before reporting an outcome; it cannot safely promise to retract a remote commit.
- Lease ownership/freshness is checked for checkpoints and before Git mutations. Stale workers cannot change persistent job state. Duplicate immutable blob/tree requests are harmless; a commit request has the same job marker, parent, tree, author, committer and timestamp on replay. The stored candidate commit is used to reconcile an ambiguous ref response.
- GitHub REST `force:false` provides atomic fast-forward safety, **not strict expected-SHA compare-and-swap**. Concurrent incompatible branch updates fail; concurrent descendant commits can be confirmed via the comparison API. No force push or automatic destructive rebase is performed.
- Progress/message IDs, sample counters, Telegram retry time and terminal delivery state persist in PostgreSQL. Telegram does not offer an idempotency key for sendMessage: a crash after delivery but before acknowledgement can cause a repeated notification. Delivery is at-least-once; optional animation is attempted at most once and can be omitted after a crash. No fabricated file_id is used.
- ZIP transfer figures are bytes verified from Storage, not fabricated in-flight byte estimates. File counts are processed/prepared counts until final confirmation. ETA appears only from a recent measurable byte delta and applies only to the current transfer stage.
- Standard ZIP store/deflate, UTF-8/CP437 names, binary bytes and executable file modes are supported. ZIP64, encrypted ZIPs, malformed headers, duplicate paths, unsupported compression/special files, symlinks, Git internals, traversal, file/directory conflicts and expansion-limit violations are rejected explicitly. Git cannot represent empty directories; no actual file is silently skipped.
- Source objects are removed only after the signed-URL safety window and retention expiry. Completed/failed job metadata is retained after object cleanup. Unfinished uploads expire after 24 hours, queued processing has 72-hour source retention, and completed/failed objects have 72-hour retention. Jobs still blocked by quotas past expiry fail instead of reading deleted objects.
- The browser upload token expires after 30 minutes. Worker processing and Telegram notices continue independently. Reopen `/upload` privately to inspect/resume with the same repository/branch; verified chunks are not retransferred.

## Official references checked

- https://vercel.com/docs/functions/limitations
- https://vercel.com/docs/functions/configuring-functions/duration
- https://docs.github.com/en/rest/git/refs
- https://docs.github.com/en/rest/git/trees
- https://docs.github.com/en/rest/git/commits
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://core.telegram.org/bots/api#editmessagetext
- https://core.telegram.org/bots/api#sendanimation
- https://supabase.com/docs/guides/storage/serving/downloads
