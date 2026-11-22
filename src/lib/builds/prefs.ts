import { db } from "../db";
import type { Ctx } from "../telegram/context";

interface Prefs { off: boolean; daily: boolean; muted: number }

async function read(userId: number): Promise<Prefs> {
  const { rows } = await db().query(
    "select notify_off, notify_daily, (select count(*) from app.repo_mutes m where m.telegram_user_id = u.id) as muted from app.telegram_users u where id = $1",
    [userId],
  );
  const r = rows[0] ?? {};
  return { off: !!r.notify_off, daily: !!r.notify_daily, muted: Number(r.muted ?? 0) };
}

function view(p: Prefs) {
  return {
    text: ["🔔 Notifikasi build", `Semua: ${p.off ? "mati" : "nyala"}`, `Ringkasan harian: ${p.daily ? "nyala" : "mati"}`, `Repo dibisukan: ${p.muted}`].join("\n"),
    keyboard: {
      inline_keyboard: [
        [{ text: p.off ? "🔔 Nyalakan semua" : "🔕 Matikan semua", callback_data: "notif:all" }],
        [{ text: p.daily ? "📊 Matikan ringkasan harian" : "📊 Nyalakan ringkasan harian", callback_data: "notif:daily" }],
      ],
    },
  };
}

export async function showNotif(ctx: Ctx): Promise<void> {
  try {
    const v = view(await read(ctx.telegramUserId));
    await ctx.reply(v.text, v.keyboard);
  } catch {
    await ctx.reply("Fitur ini butuh migrasi database 0010_build_notify.sql.");
  }
}

export async function toggleNotif(ctx: Ctx, which: "all" | "daily"): Promise<void> {
  try {
    await db().query(
      which === "all"
        ? "update app.telegram_users set notify_off = not notify_off where id = $1"
        : "update app.telegram_users set notify_daily = not notify_daily where id = $1",
      [ctx.telegramUserId],
    );
    await showNotif(ctx);
  } catch {
    await ctx.reply("Fitur ini butuh migrasi database 0010_build_notify.sql.");
  }
}
