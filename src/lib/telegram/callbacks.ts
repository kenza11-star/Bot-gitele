import { cancelJob, UploadError } from "../upload/service";
import type { AppEnv } from "../env";
import { answerCallbackQuery, type InlineKeyboard } from "./api";
import { makeCtx, withGithub, type Ctx } from "./context";
import { assertRepoAccessible } from "../github/repos";
import { setSelectedRepo } from "./state";
import { consumeRateLimit } from "../rate-limit";
import { db } from "../db";
import { githubRaw } from "../github/client";
import { MENU_COMMANDS } from "./menu";
import {
  showApk,
  showActions,
  showMenu,
  showRepo,
  showRepos,
  showSelectedRepo,
  showUpload,
} from "./views";
import type { TgCallbackQuery } from "./types";

export type CallbackAction =
  | { kind: "repos"; page: number }
  | { kind: "pick"; repoId: number };

export function parseCallbackData(
  data: string | undefined,
): CallbackAction | null {
  const m = /^(repos|pick):(\d{1,12})$/.exec(data ?? "");
  if (!m) return null;
  const n = Number(m[2]);
  return m[1] === "repos"
    ? { kind: "repos", page: n }
    : { kind: "pick", repoId: n };
}

export async function handleCallback(
  cq: TgCallbackQuery,
  env: AppEnv,
): Promise<void> {
  await answerCallbackQuery(env.telegramBotToken, cq.id).catch(() => undefined);
  const chatId = cq.message?.chat.id;
  if (!chatId || chatId !== cq.from.id) return;

  const ctx = makeCtx(env, cq.from.id, chatId, cq.message?.message_id ?? null);
  if (!(await consumeRateLimit(`tg:${cq.from.id}`, 30, 60))) {
    await ctx.reply("⏳ Terlalu cepat, tunggu sebentar");
    return;
  }

  const cancel = /^upload_cancel:([0-9a-f-]{36})$/i.exec(cq.data ?? "");
  if (cancel) {
    try {
      await cancelJob(cq.from.id, cancel[1]);
      await ctx.reply("🚫 Upload dibatalkan");
    } catch (e) {
      await ctx.reply(
        e instanceof UploadError
          ? e.message
          : "Gagal membatalkan, coba lagi.",
      );
    }
    return;
  }
  // Build notification buttons.
  const rerun = /^rerun:(\d{1,12}):(\d{1,14})$/.exec(cq.data ?? "");
  if (rerun) {
    await withGithub(ctx, "rerun_build", async (token) => {
      const repo = await assertRepoAccessible(token, Number(rerun[1]));
      await githubRaw(token, `/repos/${repo.fullName}/actions/runs/${rerun[2]}/rerun`, { method: "POST" });
      await ctx.reply(`🔁 ${repo.fullName}`);
    });
    return;
  }
  const mute = /^(mute|unmute):(\d{1,12})$/.exec(cq.data ?? "");
  if (mute) {
    const on = mute[1] === "mute", repoId = Number(mute[2]);
    try {
      await db().query(
        on
          ? "insert into app.repo_mutes (telegram_user_id, github_repo_id) values ($1,$2) on conflict do nothing"
          : "delete from app.repo_mutes where telegram_user_id=$1 and github_repo_id=$2",
        [cq.from.id, repoId],
      );
      await ctx.reply(on ? "🔕 Repo dibisukan." : "🔔 Notifikasi repo aktif lagi.", {
        inline_keyboard: [[on ? { text: "🔔 Aktifkan lagi", callback_data: `unmute:${repoId}` } : { text: "🔕 Bisukan", callback_data: `mute:${repoId}` }]],
      });
    } catch {
      await ctx.reply("Fitur ini butuh migrasi database 0010_build_notify.sql.");
    }
    return;
  }
  const notif = /^notif:(all|daily)$/.exec(cq.data ?? "");
  if (notif) {
    const { toggleNotif } = await import("../builds/prefs");
    await toggleNotif(ctx, notif[1] as "all" | "daily");
    return;
  }
  // Menu buttons: screens are edited in place.
  const menu = /^menu:([a-z]{1,12})$/.exec(cq.data ?? "");
  if (menu) {
    const screens: Record<string, (c: Ctx) => Promise<void>> = {
      home: showMenu,
      repo: showSelectedRepo,
      upload: showUpload,
      actions: showActions,
      apk: showApk,
    };
    const screen = screens[menu[1]];
    if (screen) {
      await screen(ctx).catch(async (e) => {
        console.error("menu", menu[1], e instanceof Error ? e.name : "unknown");
        await ctx.reply("⚠️ Gagal, coba lagi");
      });
      return;
    }
    const command = MENU_COMMANDS[menu[1]];
    if (!command) return;
    const { handleMessage } = await import("./handlers");
    await handleMessage({ chat: { id: chatId }, from: cq.from, text: command }, env);
    return;
  }
  const action = parseCallbackData(cq.data);
  if (!action) return;

  if (action.kind === "repos") {
    await showRepos(ctx, action.page);
    return;
  }

  // Selection re-checks access against the caller's own installations.
  await withGithub(ctx, "select_repo", async (token) => {
    const repo = await assertRepoAccessible(token, action.repoId);
    await setSelectedRepo(
      cq.from.id,
      repo.id,
      repo.fullName,
      repo.defaultBranch,
    );
    await showRepo(ctx, { fullName: repo.fullName, branch: repo.defaultBranch });
  });
}
