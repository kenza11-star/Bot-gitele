import type { AppEnv } from "../env";
import type { GithubProfile } from "../github/oauth";
import { sendMessage, sendPhoto, editMessageText, type InlineKeyboard } from "./api";
import { btn } from "./ui";

/** Button that opens the GitHub authorization page. */
export function loginKeyboard(url: string): InlineKeyboard {
  return { inline_keyboard: [[{ text: "🔐 Login", url }]] };
}

/** The Login button turns into a non-interactive status (callback "noop" is ignored). */
export function loginResultKeyboard(ok: boolean): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        ok
          ? { text: "✅ Berhasil", callback_data: "noop" }
          : { text: "❌ Gagal — coba lagi", callback_data: "menu:login" },
      ],
    ],
  };
}

/** Main menu: green / blue / red rows. Every button is a callback handled in callbacks.ts. */
export function mainMenuKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [btn("📁 Repos", "repos:0", "success"), btn("🌐 Dashboard", "menu:web", "success")],
      [
        btn("⬆️ Upload", "menu:upload", "primary"),
        btn("⚙️ Actions", "menu:actions", "primary"),
        btn("📱 APK", "menu:apk", "primary"),
      ],
      [btn("📊 Status", "menu:status", "danger"), btn("🔔 Notif", "menu:notif", "danger")],
    ],
  };
}

/** Menu buttons that still reuse the slash-command handlers (they send a fresh message). */
export const MENU_COMMANDS: Record<string, string> = {
  login: "/login",
  web: "/web",
  status: "/status",
  notif: "/notif",
};

export function buildProfileCard(p: GithubProfile, accessibleRepos: number | null): string {
  const lines = [`👤 ${p.name ? `${p.name} (@${p.login})` : `@${p.login}`}`];
  if (p.bio) lines.push(`📝 ${p.bio.slice(0, 160)}`);
  if (p.company) lines.push(`🏢 ${p.company}`);
  if (p.location) lines.push(`📍 ${p.location}`);
  lines.push("");
  if (p.publicRepos !== undefined) lines.push(`📦 Repo publik: ${p.publicRepos}`);
  if (accessibleRepos !== null) lines.push(`🔓 Repo yang bisa dikelola bot: ${accessibleRepos}`);
  if (p.followers !== undefined) lines.push(`👥 Followers: ${p.followers}`);
  if (p.following !== undefined) lines.push(`➡️ Following: ${p.following}`);
  if (p.createdAt) lines.push(`📅 Bergabung: ${p.createdAt.slice(0, 10)}`);
  lines.push(`🔗 https://github.com/${p.login}`);
  return lines.join("\n");
}

/** Sends the profile card (with avatar when Telegram can fetch it) and the menu buttons. */
export async function sendProfileCard(
  env: AppEnv,
  chatId: number,
  profile: GithubProfile,
  accessibleRepos: number | null,
): Promise<void> {
  const text = buildProfileCard(profile, accessibleRepos);
  const menu = mainMenuKeyboard();
  if (profile.avatarUrl) {
    try {
      await sendPhoto(env.telegramBotToken, chatId, profile.avatarUrl, text, menu);
      return;
    } catch {
      /* fall back to a text card */
    }
  }
  await sendMessage(env.telegramBotToken, chatId, text, menu);
}

/** Turns the Login button message into Success/Failed. Never throws. */
export async function markLoginResult(
  env: AppEnv,
  chatId: number,
  messageId: number | null,
  ok: boolean,
  text: string,
): Promise<void> {
  if (messageId === null) return;
  await editMessageText(env.telegramBotToken, chatId, messageId, text, loginResultKeyboard(ok)).catch(
    () => undefined,
  );
}
