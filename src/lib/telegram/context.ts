import type { AppEnv } from "../env";
import { sendMessage, editMessageText, type InlineKeyboard } from "./api";
import { btn } from "./ui";
import { getUsableToken, markCredentialExpired } from "../github/credentials";
import { GithubAuthError, GithubNotFoundError, GithubRateLimitError, UserFacingError } from "../github/client";
import { logActivity } from "../activity";

export interface Ctx {
  env: AppEnv;
  telegramUserId: number;
  chatId: number;
  /** Message the tapped button belongs to; null for typed commands. */
  messageId: number | null;
  reply(text: string, keyboard?: InlineKeyboard): Promise<void>;
  /** Edits the tapped message in place; sends a new one when there is nothing to edit (typed command, photo card). */
  show(text: string, keyboard: InlineKeyboard): Promise<void>;
}

export function makeCtx(
  env: AppEnv,
  telegramUserId: number,
  chatId: number,
  messageId: number | null = null,
): Ctx {
  return {
    env,
    telegramUserId,
    chatId,
    messageId,
    reply: async (text, keyboard) => {
      await sendMessage(env.telegramBotToken, chatId, text, keyboard);
    },
    show: async (text, keyboard) => {
      if (messageId !== null) {
        try {
          await editMessageText(env.telegramBotToken, chatId, messageId, text, keyboard);
          return;
        } catch {
          /* photo card or message too old: send a fresh one instead */
        }
      }
      await sendMessage(env.telegramBotToken, chatId, text, keyboard);
    },
  };
}

const LOGIN_KEYBOARD: InlineKeyboard = { inline_keyboard: [[btn("🔐 Login", "menu:login", "primary")]] };

/**
 * Runs a GitHub operation with the caller's own credentials and maps failures to safe messages.
 * Never returns or logs the token.
 */
export async function withGithub<T>(
  ctx: Ctx,
  operation: string,
  fn: (token: string, login: string) => Promise<T>,
): Promise<T | undefined> {
  const cred = await getUsableToken(ctx.telegramUserId, ctx.env);
  if (!cred) {
    await ctx.reply("🔐 Login dulu", LOGIN_KEYBOARD);
    return undefined;
  }

  try {
    return await fn(cred.token, cred.login);
  } catch (err) {
    if (err instanceof GithubAuthError) {
      await markCredentialExpired(ctx.telegramUserId);
      await logActivity(ctx.telegramUserId, operation, "failure", "credential rejected");
      await ctx.reply("⚠️ Sesi GitHub habis", LOGIN_KEYBOARD);
    } else if (err instanceof GithubRateLimitError) {
      await logActivity(ctx.telegramUserId, operation, "failure", "rate limited");
      await ctx.reply("GitHub rate limit reached. Try again later.");
    } else if (err instanceof GithubNotFoundError) {
      await logActivity(ctx.telegramUserId, operation, "failure", "not found or not accessible");
      await ctx.reply(
        "Repo tidak tersedia untuk GitHub App kamu.",
        { inline_keyboard: [[btn("📁 Repos", "menu:repos", "primary")]] },
      );
    } else if (err instanceof UserFacingError) {
      await logActivity(ctx.telegramUserId, operation, "failure", err.message);
      await ctx.reply(err.message);
    } else {
      console.error(operation, err instanceof Error ? err.name : "unknown");
      await logActivity(ctx.telegramUserId, operation, "failure", "unexpected error").catch(() => undefined);
      await ctx.reply("Something went wrong. Please try again.");
    }
    return undefined;
  }
}
