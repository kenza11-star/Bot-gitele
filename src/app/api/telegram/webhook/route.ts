import { NextRequest, NextResponse } from "next/server";
import { loadEnv } from "@/lib/env";
import { verifyTelegramSecret } from "@/lib/telegram/webhook-auth";
import { sendMessage } from "@/lib/telegram/api";
import { HELP_TEXT, UNKNOWN_TEXT, WELCOME_TEXT } from "@/lib/telegram/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
}

export async function POST(req: NextRequest) {
  const env = loadEnv();

  if (!verifyTelegramSecret(req.headers.get("x-telegram-bot-api-secret-token"), env.telegramWebhookSecret)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const update = (await req.json().catch(() => null)) as TelegramUpdate | null;
  const message = update?.message;
  if (!message?.text || !message.from) {
    return NextResponse.json({ ok: true });
  }

  const command = message.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  const chatId = message.chat.id;

  if (command === "/start") {
    await sendMessage(env.telegramBotToken, chatId, WELCOME_TEXT);
  } else if (command === "/help") {
    await sendMessage(env.telegramBotToken, chatId, HELP_TEXT);
  } else if (command.startsWith("/")) {
    await sendMessage(env.telegramBotToken, chatId, UNKNOWN_TEXT);
  }

  return NextResponse.json({ ok: true });
}
