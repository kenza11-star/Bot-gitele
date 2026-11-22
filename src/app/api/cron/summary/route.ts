import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { loadEnv } from "@/lib/env";
import { sendMessage } from "@/lib/telegram/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(header: string | null, secret: string): boolean {
  const a = Buffer.from(header ?? ""), b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Daily build summary for users who switched it on with /notif. */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return new NextResponse("CRON_SECRET is not configured", { status: 503 });
  if (!authorized(req.headers.get("authorization"), secret)) return new NextResponse("unauthorized", { status: 401 });
  const env = loadEnv();

  const { rows } = await db().query<{ telegram_user_id: string; ok: string; bad: string; failing: string[] | null }>(
    `select n.telegram_user_id,
            count(*) filter (where n.conclusion = 'success') as ok,
            count(*) filter (where n.conclusion <> 'success') as bad,
            array_agg(distinct n.repo_full_name) filter (where n.conclusion <> 'success') as failing
       from app.build_notices n join app.telegram_users u on u.id = n.telegram_user_id
      where n.created_at > now() - interval '24 hours' and u.notify_daily and not u.notify_off
      group by n.telegram_user_id`,
  );
  let sent = 0;
  for (const r of rows) {
    const text = [
      "📊 Ringkasan build 24 jam",
      `✅ Berhasil: ${r.ok}`,
      `❌ Gagal: ${r.bad}`,
      ...(r.failing?.length ? ["", "Perlu dicek:", ...r.failing.slice(0, 8).map((f) => `• ${f}`)] : []),
    ].join("\n");
    try {
      await sendMessage(env.telegramBotToken, Number(r.telegram_user_id), text);
      sent++;
    } catch {
      /* user blocked the bot */
    }
  }
  await db().query("delete from app.build_notices where created_at < now() - interval '14 days'").catch(() => undefined);
  return NextResponse.json({ sent });
}
