import { NextRequest, NextResponse } from "next/server";
import { loadEnv } from "@/lib/env";
import { claimUpdate, finishUpdate } from "@/lib/telegram/update-claims";
import { verifyTelegramSecret } from "@/lib/telegram/webhook-auth";
import { handleMessage } from "@/lib/telegram/handlers";
import { handleCallback } from "@/lib/telegram/callbacks";
import type { TgUpdate } from "@/lib/telegram/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Uploads and GitHub commits can take a while. Raise this if your Vercel plan allows it.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const env = loadEnv();

  if (
    !verifyTelegramSecret(
      req.headers.get("x-telegram-bot-api-secret-token"),
      env.telegramWebhookSecret,
    )
  ) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const update = (await req.json().catch(() => null)) as TgUpdate | null;
  if (!update || !Number.isSafeInteger(update.update_id)) {
    return NextResponse.json({ ok: true });
  }

  const claim = await claimUpdate(update.update_id);
  if (claim.kind === "completed") return NextResponse.json({ ok: true });
  if (claim.kind === "busy")
    return NextResponse.json(
      { ok: false },
      { status: 503, headers: { "retry-after": "30" } },
    );

  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query, env);
    } else if (update.message) {
      await handleMessage(update.message, env);
    }
  } catch (err) {
    await finishUpdate(update.update_id, claim.token, false).catch(
      () => undefined,
    );
    console.error(
      "telegram update failed",
      err instanceof Error ? err.name : "unknown",
    );
    return NextResponse.json(
      { ok: false },
      { status: 503, headers: { "retry-after": "30" } },
    );
  }

  if (!(await finishUpdate(update.update_id, claim.token, true)))
    return NextResponse.json({ ok: false }, { status: 503 });
  return NextResponse.json({ ok: true });
}
