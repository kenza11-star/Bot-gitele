import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppEnv } from "../env";
import { db } from "../db";
import { github } from "../github/client";
import { getUsableToken } from "../github/credentials";
import { ARTIFACT_LIMIT, SEND_LIMIT, downloadBinary } from "../github/actions";
import { sendDocument, sendMessage, type InlineKeyboard } from "../telegram/api";
import { signApkToken } from "./apk-token";
import { apkFromZip, findRunArtifact } from "./artifacts";

export interface WorkflowRunEvent {
  action?: string;
  workflow_run?: {
    id: number;
    name?: string | null;
    run_number?: number;
    head_branch?: string | null;
    head_commit?: { message?: string } | null;
    conclusion?: string | null;
    html_url?: string;
    run_started_at?: string;
    updated_at?: string;
    actor?: { login?: string } | null;
    triggering_actor?: { login?: string } | null;
  };
  repository?: { id: number; full_name: string; owner?: { login?: string } };
  sender?: { login?: string };
}

export function verifySignature(raw: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith("sha256=") || !secret) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

const DONE = new Set(["success", "failure", "timed_out", "startup_failure"]);

export function duration(start?: string, end?: string): string {
  const s = Date.parse(start ?? ""), e = Date.parse(end ?? "");
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return "";
  const sec = Math.round((e - s) / 1000);
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
}

export function buildKeyboard(o: {
  ok: boolean;
  runUrl: string;
  apkUrl: string | null;
  repoId: number;
  runId: number;
}): InlineKeyboard {
  const rows: InlineKeyboard["inline_keyboard"] = [[{ text: o.ok ? "✅ Success" : "❌ Failed", url: o.runUrl }]];
  if (o.ok && o.apkUrl) rows.push([{ text: "⬇️ Download APK", url: o.apkUrl }]);
  if (!o.ok) rows.push([{ text: "🔁 Build ulang", callback_data: `rerun:${o.repoId}:${o.runId}` }]);
  rows.push([{ text: "🔕 Bisukan repo", callback_data: `mute:${o.repoId}` }]);
  return { inline_keyboard: rows };
}

interface Recipient { user_id: string; off: string | null }

async function recipients(logins: string[]): Promise<Recipient[]> {
  if (logins.length === 0) return [];
  const { rows } = await db().query<Recipient>(
    `select distinct u.id as user_id, to_jsonb(u)->>'notify_off' as off
     from app.github_identities i
     join app.telegram_users u on u.id = i.telegram_user_id
     join app.github_credentials c on c.identity_id = i.id
     where i.disconnected_at is null and c.revoked_at is null and lower(i.github_login) = any($1)`,
    [logins],
  );
  return rows;
}

async function isMuted(userId: number, repoId: number): Promise<boolean> {
  try {
    const { rows } = await db().query("select 1 from app.repo_mutes where telegram_user_id=$1 and github_repo_id=$2", [userId, repoId]);
    return rows.length > 0;
  } catch {
    return false; // migration 0010 not applied yet
  }
}

/** One finished workflow run -> a Telegram message (and the APK) for every linked user who can see the repo. */
export async function handleWorkflowRun(event: WorkflowRunEvent, deliveryId: string, env: AppEnv): Promise<void> {
  const run = event.workflow_run, repo = event.repository;
  if (event.action !== "completed" || !run || !repo || !run.conclusion || !DONE.has(run.conclusion)) return;

  const fresh = await db().query(
    `insert into app.build_events (delivery_id, github_repo_id, event_type, run_id, status)
     values ($1,$2,'workflow_run',$3,$4) on conflict (delivery_id) do nothing returning id`,
    [deliveryId, repo.id, run.id, run.conclusion],
  );
  if (fresh.rowCount === 0) return;

  const logins = [...new Set([repo.owner?.login, run.actor?.login, run.triggering_actor?.login, event.sender?.login]
    .filter((v): v is string => !!v).map((v) => v.toLowerCase()))];
  const ok = run.conclusion === "success";
  const runUrl = run.html_url ?? `https://github.com/${repo.full_name}/actions/runs/${run.id}`;
  const commit = (run.head_commit?.message ?? "").split("\n")[0]?.slice(0, 100) ?? "";
  const took = duration(run.run_started_at, run.updated_at);

  for (const r of await recipients(logins)) {
    const userId = Number(r.user_id);
    try {
      if (r.off === "true" || (await isMuted(userId, repo.id))) continue;
      const cred = await getUsableToken(userId, env);
      if (!cred) continue;
      // Only people who can read the repository with their own token are notified.
      await github(cred.token, `/repos/${repo.full_name}`);

      let apkUrl: string | null = null;
      let apk: { name: string; data: Uint8Array } | null = null;
      if (ok) {
        try {
          const artifact = await findRunArtifact(cred.token, repo.full_name, run.id);
          if (artifact) {
            const zip = await downloadBinary(cred.token, artifact.archive_download_url, ARTIFACT_LIMIT);
            const found = apkFromZip(zip, ARTIFACT_LIMIT);
            if (found) {
              apkUrl = `${env.appUrl}/api/apk?t=${signApkToken({ u: userId, repo: repo.full_name, run: run.id }, env.encryptionKey)}`;
              if (found.data.length <= SEND_LIMIT) apk = found;
            }
          }
        } catch (err) {
          console.error("[build-notify] artifact", err instanceof Error ? err.name : "unknown");
        }
      }

      const text = [
        ok ? "✅ Build berhasil" : "❌ Build gagal",
        `${repo.full_name} · ${run.head_branch ?? "-"}`,
        commit && `“${commit}”`,
        `${run.name ?? "Workflow"} #${run.run_number ?? ""}${took ? ` · ${took}` : ""}`,
      ].filter(Boolean).join("\n");
      await sendMessage(env.telegramBotToken, userId, text, buildKeyboard({ ok, runUrl, apkUrl, repoId: repo.id, runId: run.id }));
      if (apk) await sendDocument(env.telegramBotToken, userId, apk.name, apk.data, `${repo.full_name} #${run.run_number ?? ""}`);

      await db().query(
        "insert into app.build_notices (telegram_user_id, github_repo_id, repo_full_name, run_id, conclusion) values ($1,$2,$3,$4,$5)",
        [userId, repo.id, repo.full_name, run.id, run.conclusion],
      ).catch(() => undefined);
    } catch (err) {
      console.error("[build-notify] user failed", err instanceof Error ? err.name : "unknown");
    }
  }
}
