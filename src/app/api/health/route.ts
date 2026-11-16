import { NextRequest, NextResponse } from "next/server";
import { verifyTelegramSecret } from "@/lib/telegram/webhook-auth";
import { loadEnv } from "@/lib/env";
import { readiness } from "@/lib/deployment/readiness";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(req: NextRequest) {
  const headers = { "cache-control": "no-store" };
  if (req.nextUrl.searchParams.get("ready") !== "1")
    return NextResponse.json(
      { service: "github-manager-bot", version: 4, status: "ok" },
      { headers },
    );
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (
    !secret ||
    !verifyTelegramSecret(
      req.headers.get("x-telegram-bot-api-secret-token"),
      secret,
    )
  )
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers },
    );
  try {
    loadEnv();
    const result = await readiness();
    return NextResponse.json(result, {
      status: result.status === "ready" ? 200 : 503,
      headers,
    });
  } catch {
    return NextResponse.json(
      { status: "unavailable" },
      { status: 503, headers },
    );
  }
}
