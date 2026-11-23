import { UserFacingError } from "../github/client";
import { logActivity } from "../activity";
import { getUsableToken } from "../github/credentials";
import { assertRepoAccessible, listAccessibleRepos } from "../github/repos";
import {
  listRuns,
  findNewestArtifact,
  findLatestApkAsset,
  downloadBinary,
  extractApk,
  ARTIFACT_LIMIT,
  SEND_LIMIT,
} from "../github/actions";
import { mintSessionToken } from "../upload/session";
import { withGithub, type Ctx } from "./context";
import { sendDocument, type InlineKeyboard } from "./api";
import { getUserState, setPending } from "./state";
import { mainMenuKeyboard } from "./menu";
import { backBtn, btn, grid, link, pager, repoUrl } from "./ui";

export const REPO_PAGE_SIZE = 8;

/** Home: just the colored menu. */
export async function showMenu(ctx: Ctx): Promise<void> {
  await ctx.show("🏠 Menu", mainMenuKeyboard());
}

/** Repo grid, 2 columns, [←] [1/3] [→] pager, red back button. */
export async function showRepos(ctx: Ctx, page: number): Promise<void> {
  await withGithub(ctx, "list_repos", async (token) => {
    const repos = await listAccessibleRepos(token);
    if (repos.length === 0) {
      await ctx.show("📭 Belum ada repo", {
        inline_keyboard: [
          [
            link(
              "➕ Install GitHub App",
              `https://github.com/apps/${ctx.env.githubAppSlug}/installations/new`,
              "success",
            ),
          ],
          [backBtn()],
        ],
      });
      return;
    }
    const pages = Math.max(1, Math.ceil(repos.length / REPO_PAGE_SIZE));
    const p = Math.min(Math.max(0, page), pages - 1);
    // Drop the "owner/" prefix when every repo has the same owner.
    const sameOwner = new Set(repos.map((r) => r.fullName.split("/")[0])).size === 1;
    const buttons = repos.slice(p * REPO_PAGE_SIZE, (p + 1) * REPO_PAGE_SIZE).map((r) =>
      btn(
        `${r.private ? "🔒 " : ""}${sameOwner ? r.fullName.split("/")[1] : r.fullName}`.slice(0, 40),
        `pick:${r.id}`,
        "primary",
      ),
    );
    await ctx.show("📁 Repo", {
      inline_keyboard: [
        ...grid(buttons, 2),
        ...pager(p, pages, (n) => `repos:${n}`),
        [backBtn()],
      ],
    });
  });
}

/** Selected repo: a button straight to GitHub, then Upload / Actions / APK. */
export async function showRepo(
  ctx: Ctx,
  repo: { fullName: string; branch: string },
): Promise<void> {
  await ctx.show(`🌿 ${repo.branch}`, {
    inline_keyboard: [
      [link(`📦 ${repo.fullName}`, repoUrl(repo.fullName), "primary")],
      [
        btn("⬆️ Upload", "menu:upload", "success"),
        btn("⚙️ Actions", "menu:actions", "primary"),
        btn("📱 APK", "menu:apk", "primary"),
      ],
      [backBtn("repos:0")],
    ],
  });
}

/** Re-opens the repo screen from the saved selection (used by the Kembali buttons). */
export async function showSelectedRepo(ctx: Ctx): Promise<void> {
  const sel = await requireSelection(ctx);
  if (sel) await showRepo(ctx, { fullName: sel.repoFullName, branch: sel.repoBranch });
}

export async function requireSelection(ctx: Ctx): Promise<{
  repoId: number;
  repoFullName: string;
  repoBranch: string;
  sessionVersion: number;
} | null> {
  const st = await getUserState(ctx.telegramUserId);
  if (!st.repoId || !st.repoFullName) {
    // Nothing chosen yet: go straight to the repo list.
    await showRepos(ctx, 0);
    return null;
  }
  return {
    repoId: st.repoId,
    repoFullName: st.repoFullName,
    repoBranch: st.repoBranch ?? "",
    sessionVersion: st.sessionVersion,
  };
}

export async function showUpload(ctx: Ctx): Promise<void> {
  const sel = await requireSelection(ctx);
  if (!sel) return;
  const cred = await getUsableToken(ctx.telegramUserId, ctx.env);
  if (!cred) {
    await ctx.reply("🔐 Login dulu", {
      inline_keyboard: [[btn("🔐 Login", "menu:login", "primary")]],
    });
    return;
  }
  await assertRepoAccessible(cred.token, sel.repoId);
  // A .zip sent straight to the chat is still accepted for 10 minutes.
  await setPending(ctx.telegramUserId, "await_zip", 10);
  const session = mintSessionToken(ctx.telegramUserId, ctx.env.encryptionKey, Date.now(), {
    repoId: sel.repoId,
    repoFullName: sel.repoFullName,
    branch: sel.repoBranch,
    sessionVersion: sel.sessionVersion,
  });
  await ctx.show(`⬆️ ${sel.repoFullName.split("/")[1] ?? sel.repoFullName} · ${sel.repoBranch}`, {
    inline_keyboard: [
      [link("⬆️ Upload", `${ctx.env.appUrl}/upload#t=${session}`, "success")],
      [backBtn("menu:repo")],
    ],
  });
}

const RUN_ICON: Record<string, string> = {
  Success: "✅",
  Failed: "❌",
  "In progress": "🔄",
  Queued: "⏳",
  Cancelled: "🚫",
  Skipped: "⏭",
};

/** Latest workflow runs as buttons; tapping one opens it on GitHub. */
export async function showActions(ctx: Ctx): Promise<void> {
  const sel = await requireSelection(ctx);
  if (!sel) return;
  await withGithub(ctx, "actions", async (token) => {
    await assertRepoAccessible(token, sel.repoId);
    const runs = await listRuns(token, sel.repoFullName);
    const keyboard: InlineKeyboard = {
      inline_keyboard: [
        ...runs.map((r) => [
          link(
            `${RUN_ICON[r.label] ?? "❔"} ${r.name} #${r.runNumber}${r.branch ? ` · ${r.branch}` : ""}`.slice(0, 60),
            r.url,
            r.label === "Failed" ? "danger" : r.label === "Success" ? "success" : "primary",
          ),
        ]),
        [btn("🔄 Refresh", "menu:actions", "success"), backBtn("menu:repo")],
      ],
    };
    await ctx.show(runs.length ? "⚙️ Actions" : "⚙️ Belum ada run", keyboard);
  });
}

export async function sendLatestApk(ctx: Ctx, token: string, fullName: string): Promise<void> {
  const botToken = ctx.env.telegramBotToken;

  const artifact = await findNewestArtifact(token, fullName);
  let fallbackZip: Uint8Array | null = null;
  let artifactProblem: string | null = null;
  if (artifact) {
    try {
      const zip = await downloadBinary(token, artifact.archive_download_url, ARTIFACT_LIMIT);
      const apk = extractApk(zip);
      if (apk)
        return sendDocument(botToken, ctx.chatId, apk.name, apk.data, `📱 ${artifact.name}`);
      if (zip.length <= SEND_LIMIT) fallbackZip = zip;
    } catch (e) {
      if (!(e instanceof UserFacingError)) throw e;
      artifactProblem = e.message;
    }
  }
  const asset = await findLatestApkAsset(token, fullName);
  if (asset) {
    if (asset.size > SEND_LIMIT)
      return ctx.reply("APK lebih dari 50 MB, ambil dari halaman release GitHub.");
    const data = await downloadBinary(token, asset.url, SEND_LIMIT);
    return sendDocument(botToken, ctx.chatId, asset.name, data, "📱 Release terbaru");
  }
  if (fallbackZip && artifact)
    return sendDocument(
      botToken,
      ctx.chatId,
      `${artifact.name}.zip`,
      fallbackZip,
      "Artifact (tidak ada APK di dalamnya)",
    );
  if (artifactProblem) return ctx.reply(artifactProblem);

  await ctx.reply("📭 APK tidak ditemukan");
}

export async function showApk(ctx: Ctx): Promise<void> {
  const sel = await requireSelection(ctx);
  if (!sel) return;
  await withGithub(ctx, "apk_download", async (token) => {
    await assertRepoAccessible(token, sel.repoId);
    await sendLatestApk(ctx, token, sel.repoFullName);
    await logActivity(ctx.telegramUserId, "apk_download", "success");
  });
}
