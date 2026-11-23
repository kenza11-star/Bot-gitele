import { getBranch, listBranches } from "../github/branches";
import { cancelJob, UploadError } from "../upload/service";
import type { AppEnv } from "../env";
import { db } from "../db";
import { consumeRateLimit } from "../rate-limit";
import { logActivity } from "../activity";
import { attachLoginMessage, createLoginState } from "../auth/oauth-state";
import { isAdmin } from "../auth/admin";
import { authorizeUrl, fetchGithubProfile } from "../github/oauth";
import { getActiveGithubLogin, unlinkGithubAccount } from "../github/linking";
import { getUsableToken, revokeGrant } from "../github/credentials";
import { assertRepoAccessible, listAccessibleRepos } from "../github/repos";
import { cachedAccessibleRepos, matchRepos } from "../github/search";
import { makeCtx, withGithub, type Ctx } from "./context";
import { sendMessage } from "./api";
import { loginKeyboard, mainMenuKeyboard, sendProfileCard } from "./menu";
import { backBtn, btn, link } from "./ui";
import { dispatchProcessor } from "../actions-worker/dispatch";
import { mintWebToken } from "../web/session";
import {
  getUserState,
  setPending,
  clearSelection,
  setSelectedRepo,
} from "./state";
import { requireSelection, showActions, showApk, showMenu, showRepo, showRepos, showUpload } from "./views";
import { handleZipUpload } from "./documents";
import { UNKNOWN_TEXT } from "./messages";
import type { TgMessage } from "./types";

/** A queued job nobody has picked up for 3+ minutes means the dispatch was missed; nudge the processor once. */
async function redispatchIfStalled(userId: number): Promise<void> {
  try {
    const { rows } = await db().query(
      `select 1 from app.upload_jobs where telegram_user_id=$1 and status='uploaded' and cancel_requested_at is null
       and next_attempt_at<now()-interval '3 minutes' and (dispatched_at is null or dispatched_at<now()-interval '3 minutes') limit 1`,
      [userId],
    );
    if (rows.length) await dispatchProcessor();
  } catch {
    /* best effort */
  }
}

/** /cari <kata>: finds repositories the GitHub App can reach. Tapping a result selects it. */
async function cariCommand(ctx: Ctx, query: string): Promise<void> {
  if (query.length > 100) return ctx.reply("Kata pencarian terlalu panjang.");
  await withGithub(ctx, "search_repos", async (token) => {
    const all = await cachedAccessibleRepos(ctx.telegramUserId, token);
    const hits = matchRepos(all, query, 8);
    if (hits.length === 0)
      return ctx.reply(query ? `📭 “${query}”` : "📭 Belum ada repo", { inline_keyboard: [[backBtn()]] });
    await ctx.reply(`🔎 ${query || "semua"}`, {
      inline_keyboard: [
        ...hits.map((h) => [btn(`${h.private ? "🔒 " : ""}${h.fullName}`.slice(0, 60), `pick:${h.id}`, "primary")]),
        [backBtn()],
      ],
    });
  });
}

/** Sends a message whose only button is Login; the OAuth callback later turns it into Success/Failed. */
async function sendLoginPrompt(ctx: Ctx, text: string): Promise<void> {
  if (!(await consumeRateLimit(`login:${ctx.telegramUserId}`, 5, 600))) {
    return ctx.reply("⏳ Terlalu sering, coba lagi nanti");
  }
  const state = await createLoginState(ctx.telegramUserId);
  const messageId = await sendMessage(
    ctx.env.telegramBotToken,
    ctx.chatId,
    text,
    loginKeyboard(authorizeUrl(ctx.env, state)),
  );
  await attachLoginMessage(state, messageId).catch(() => undefined);
}

/** /start: profile card + menu when already connected, otherwise the Login button. */
async function showHome(ctx: Ctx): Promise<void> {
  const cred = await getUsableToken(ctx.telegramUserId, ctx.env).catch(() => null);
  if (cred) {
    try {
      const profile = await fetchGithubProfile(cred.token);
      const count = await listAccessibleRepos(cred.token)
        .then((r) => r.length)
        .catch(() => null);
      return sendProfileCard(ctx.env, ctx.chatId, profile, count);
    } catch {
      /* token no longer usable: fall through to the Login button */
    }
  }
  return sendLoginPrompt(
    ctx,
    "👋 GitHub Manager",
  );
}

export async function handleMessage(
  msg: TgMessage,
  env: AppEnv,
): Promise<void> {
  if (!msg.from) return;
  const from = msg.from;
  const ctx = makeCtx(env, from.id, msg.chat.id);

  // Every user is registered on first contact. Access is never gated by the admin list.
  await db().query(
    `insert into app.telegram_users (id, username, first_name) values ($1, $2, $3)
     on conflict (id) do update set username = excluded.username,
       first_name = excluded.first_name, last_active_at = now()`,
    [from.id, from.username ?? null, from.first_name ?? null],
  );

  if (!(await consumeRateLimit(`tg:${from.id}`, 30, 60))) {
    return ctx.reply("⏳ Terlalu cepat, tunggu sebentar");
  }

  // GitHub account links, private repositories and signed upload capabilities stay in DMs.
  if (msg.chat.id !== from.id) {
    return ctx.reply("💬 Pakai chat pribadi dengan bot ini");
  }
  if (msg.document) return handleZipUpload(ctx, msg.document);

  const command = (msg.text ?? "")
    .trim()
    .split(/\s+/)[0]
    .split("@")[0]
    .toLowerCase();

  switch (command) {
    case "/start":
      return showHome(ctx);
    case "/help":
    case "/menu":
      return showMenu(ctx);

    case "/login": {
      return sendLoginPrompt(
        ctx,
        "🔐 Login GitHub",
      );
    }

    case "/web":
    case "/dashboard": {
      if (!(await consumeRateLimit(`web-link:${from.id}`, 5, 600)))
        return ctx.reply("⏳ Terlalu sering, coba lagi nanti");
      const v = await db().query<{ upload_session_version: number }>(
        "select upload_session_version from app.telegram_users where id=$1",
        [from.id],
      );
      const token = mintWebToken(from.id, env.encryptionKey, v.rows[0]?.upload_session_version ?? 0);
      return ctx.reply("🌐 Dashboard · 8 jam, jangan di-forward", {
        inline_keyboard: [
          [link("🌐 Buka Dashboard", `${env.appUrl}/app#t=${token}`, "success")],
          [backBtn()],
        ],
      });
    }

    case "/status": {
      const login = await getActiveGithubLogin(from.id);
      const st = await getUserState(from.id);
      await redispatchIfStalled(from.id);
      const text = [
        login ? `🐙 ${login}` : "🔐 Belum login",
        st.repoFullName ? `📦 ${st.repoFullName}${st.repoBranch ? ` · ${st.repoBranch}` : ""}` : "📦 Belum pilih repo",
      ].join("\n");
      return ctx.reply(text, { inline_keyboard: [[backBtn()]] });
    }

    case "/repos":
      return showRepos(ctx, 0);

    case "/branch":
    case "/branches": {
      const sel = await requireSelection(ctx);
      if (!sel) return;
      const name = (msg.text ?? "").trim().split(/\s+/).slice(1).join(" ");
      await withGithub(ctx, "select_branch", async (token) => {
        await assertRepoAccessible(token, sel.repoId);
        if (!name) {
          const branches = await listBranches(token, sel.repoFullName);
          return ctx.reply(
            `🌿 ${sel.repoBranch}\n\n${branches.join("\n")}\n\n/branch nama`,
          );
        }
        const branch = await getBranch(token, sel.repoFullName, name);
        await setSelectedRepo(from.id, sel.repoId, sel.repoFullName, branch);
        await showRepo(ctx, { fullName: sel.repoFullName, branch });
      });
      return;
    }
    case "/upload":
      return showUpload(ctx);

    case "/cancel": {
      await setPending(from.id, null, 0);
      const requested = (msg.text ?? "").trim().split(/\s+/)[1];
      const rows = requested
        ? [{ id: requested }]
        : (
            await db().query<{ id: string }>(
              "select id from app.upload_jobs where telegram_user_id=$1 and status in ('created','uploading','uploaded','processing') order by created_at desc limit 1",
              [from.id],
            )
          ).rows;
      if (!rows[0])
        return ctx.reply("🚫 Tidak ada upload aktif");
      try {
        await cancelJob(from.id, rows[0].id);
        return ctx.reply("🚫 Upload dibatalkan");
      } catch (e) {
        return ctx.reply(
          e instanceof UploadError ? e.message : "Gagal membatalkan, coba lagi.",
        );
      }
    }

    case "/actions":
      return showActions(ctx);

    case "/apk":
      return showApk(ctx);

    case "/cari":
      return cariCommand(ctx, (msg.text ?? "").replace(/^\/cari(@\S+)?/i, "").trim());

    case "/notif": {
      const { showNotif } = await import("../builds/prefs");
      return showNotif(ctx);
    }

    case "/logout": {
      // Revoke at GitHub when a usable token exists, then delete local material regardless.
      const cred = await getUsableToken(from.id, env).catch(() => null);
      let revoked = false;
      if (cred) {
        revoked = await revokeGrant(env, cred.token).catch(() => false);
      }
      const removed = await unlinkGithubAccount(from.id);
      await clearSelection(from.id);
      await logActivity(
        from.id,
        "github_disconnect",
        "success",
        revoked ? undefined : "grant not confirmed revoked",
      );
      if (removed === 0) return ctx.reply("🔐 Belum login", { inline_keyboard: [[btn("🔐 Login", "menu:login", "primary")]] });
      return ctx.reply(
        revoked
          ? "👋 Akun diputus, token dihapus"
          : "👋 Akun diputus, token dihapus\n⚠️ GitHub belum konfirmasi pencabutan, cabut manual di GitHub Settings.",
      );
    }

    case "/admin": {
      // Non-admins get the generic reply so the command is not revealed.
      if (!isAdmin(env, String(from.id))) return ctx.reply(UNKNOWN_TEXT, mainMenuKeyboard());
      const { rows } = await db().query<{ users: string; connected: string }>(
        `select (select count(*) from app.telegram_users) as users,
                (select count(*) from app.github_identities where disconnected_at is null) as connected`,
      );
      return ctx.reply(
        `Users: ${rows[0].users}\nConnected GitHub accounts: ${rows[0].connected}`,
      );
    }

    default:
      return command.startsWith("/")
        ? ctx.reply(UNKNOWN_TEXT, mainMenuKeyboard())
        : showMenu(ctx);
  }
}
