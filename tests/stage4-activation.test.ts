import { expect, it, vi } from "vitest";
import { activateTelegram } from "@/lib/deployment/activate";
const env = {
  telegramBotToken: "123:NEVER_PRINT_TOKEN",
  telegramWebhookSecret: "safe-secret",
  appUrl: "https://bot-xsync-delta.vercel.app",
};
it("checks readiness/routes then registers and verifies the exact deployed webhook", async () => {
  const calls: any[] = [];
  const fetcher = vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/github/callback"))
      return new Response("Invalid request", { status: 400 });
    if (url.endsWith("/api/health?ready=1"))
      return Response.json({
        status: "ready",
        checks: { database: true, storage: true, worker: true },
      });
    if (url.endsWith("/api/health"))
      return Response.json({
        service: "github-manager-bot",
        version: 4,
        status: "ok",
      });
    if (url.endsWith("/api/telegram/webhook"))
      return init.headers?.["x-telegram-bot-api-secret-token"] ===
        env.telegramWebhookSecret
        ? Response.json({ ok: true })
        : new Response("unauthorized", { status: 401 });
    if (url.endsWith("/setWebhook"))
      return Response.json({ ok: true, result: true });
    if (url.endsWith("/getWebhookInfo"))
      return Response.json({
        ok: true,
        result: {
          url: env.appUrl + "/api/telegram/webhook",
          pending_update_count: 0,
        },
      });
    throw new Error("unknown");
  });
  const result = await activateTelegram(env, fetcher as typeof fetch);
  expect(result.registered).toBe(true);
  const body = JSON.parse(
    calls.find((c) => c.url.endsWith("/setWebhook")).init.body,
  );
  expect(body.secret_token).toBe(env.telegramWebhookSecret);
  expect(body.drop_pending_updates).toBe(false);
  expect(body.url).toBe(
    "https://bot-xsync-delta.vercel.app/api/telegram/webhook",
  );
  expect(JSON.stringify(result)).not.toContain(env.telegramBotToken);
  expect(JSON.stringify(result)).not.toContain(env.telegramWebhookSecret);
});
it("does not register anything when the deployed app/worker is not ready", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({ status: "unavailable" }, { status: 503 }),
    );
  await expect(activateTelegram(env, fetcher)).rejects.toThrow();
  expect(
    fetcher.mock.calls.some((c) => String(c[0]).includes("/setWebhook")),
  ).toBe(false);
});
it("never exposes tokens from a transport error", async () => {
  await expect(
    activateTelegram(
      env,
      vi.fn().mockRejectedValue(new Error("leak " + env.telegramBotToken)),
    ),
  ).rejects.toThrow(/^Deployment probe failed/);
});
