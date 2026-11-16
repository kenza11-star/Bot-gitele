import { randomUUID } from "node:crypto";
import { db } from "../db";
import { loadEnv } from "../env";
import { storageConfig } from "../supabase/storage";
import { expireStaleUploads } from "../upload/service";
import { claimJob, pause } from "./state";
import { processClaimedJob } from "./processor";
import { deliverOneNotice } from "./notifications";
export async function verifyWorkerConfiguration(): Promise<void> {
  loadEnv();
  storageConfig();
  const { rows } = await db().query<{
    ready: boolean;
  }>(`select to_regclass('app.upload_job_files') is not null and to_regclass('app.worker_heartbeats') is not null
 and exists(select 1 from information_schema.columns where table_schema='app' and table_name='upload_jobs' and column_name='lease_owner') as ready`);
  if (!rows[0]?.ready)
    throw new Error("Apply migrations through 0007 before starting the worker");
}
export async function runOneJob(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  const job = await claimJob();
  if (!job) return false;
  await processClaimedJob(job, signal);
  return true;
}
/** All loops are awaited by the executable process; never invoked after an HTTP response. */
export async function runWorker(
  signal: AbortSignal,
  once = false,
): Promise<void> {
  await verifyWorkerConfiguration();
  const env = loadEnv();
  if (once) {
    await runOneJob(signal);
    for (let i = 0; i < 5; i++)
      if (!(await deliverOneNotice(env.telegramBotToken))) break;
    return;
  }
  const loop = async (
    label: string,
    work: () => Promise<void>,
    interval: number,
  ) => {
    while (!signal.aborted) {
      try {
        await work();
      } catch (e) {
        console.error(label, e instanceof Error ? e.name : "unknown");
      }
      try {
        await pause(interval, signal);
      } catch {
        break;
      }
    }
  };
  const instance = randomUUID();
  try {
    await Promise.all([
      loop(
        "worker heartbeat",
        async () => {
          await db().query(
            "insert into app.worker_heartbeats(instance_id) values($1) on conflict(instance_id) do update set last_seen_at=now()",
            [instance],
          );
        },
        15_000,
      ),
      loop(
        "processing loop",
        async () => {
          await runOneJob(signal);
        },
        1000,
      ),
      loop(
        "notification loop",
        async () => {
          for (let i = 0; i < 10 && !signal.aborted; i++)
            if (!(await deliverOneNotice(env.telegramBotToken))) break;
        },
        1000,
      ),
      loop(
        "cleanup loop",
        async () => {
          await expireStaleUploads(2);
        },
        60_000,
      ),
    ]);
  } finally {
    await db()
      .query("delete from app.worker_heartbeats where instance_id=$1", [
        instance,
      ])
      .catch(() => undefined);
  }
}
