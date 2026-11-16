import { db } from "../db";
import { storageConfig, authHeadersFor } from "../supabase/storage";
export async function readiness() {
  const checks = {
    database: false,
    schema: false,
    storage: false,
    worker: false,
  };
  try {
    const { rows } = await db().query<{
      ready: boolean;
    }>(`select to_regclass('app.worker_heartbeats') is not null
  and to_regclass('app.upload_job_files') is not null and exists(select 1 from information_schema.columns where table_schema='app' and table_name='telegram_users' and column_name='upload_session_version') as ready`);
    checks.database = true;
    checks.schema = Boolean(rows[0]?.ready);
    if (checks.schema) {
      const beats = await db().query<{ alive: boolean }>(
        "select exists(select 1 from app.worker_heartbeats where last_seen_at>now()-interval '60 seconds') as alive",
      );
      checks.worker = Boolean(beats.rows[0]?.alive);
    }
  } catch {}
  try {
    const cfg = storageConfig();
    const res = await fetch(
      `${cfg.url}/storage/v1/bucket/${encodeURIComponent(cfg.bucket)}`,
      {
        headers: authHeadersFor(cfg.secretKey),
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
        redirect: "error",
      },
    );
    const bucket = (await res.json().catch(() => null)) as {
      id?: string;
      name?: string;
      public?: boolean;
      file_size_limit?: number | null;
      allowed_mime_types?: string[] | null;
    } | null;
    const capacity =
      bucket?.file_size_limit == null ||
      bucket.file_size_limit >= 8 * 1024 * 1024;
    const mimes = bucket?.allowed_mime_types;
    const acceptsBytes =
      mimes == null ||
      mimes.some((m) =>
        ["application/octet-stream", "application/*", "*/*"].includes(m),
      );
    checks.storage =
      res.ok &&
      bucket?.public === false &&
      (bucket.id === cfg.bucket || bucket.name === cfg.bucket) &&
      capacity &&
      acceptsBytes;
  } catch {}
  return {
    status: Object.values(checks).every(Boolean) ? "ready" : "unavailable",
    checks,
  };
}
