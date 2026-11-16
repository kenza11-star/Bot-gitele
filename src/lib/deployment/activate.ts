import type { AppEnv } from "../env";
import { deploymentUrls } from "./urls";
type ActivationEnv = Pick<
  AppEnv,
  "telegramBotToken" | "telegramWebhookSecret" | "appUrl"
>;
/** Fail closed. Only sanitized, fixed messages leave this module; fetch errors may contain bot URLs. */
export async function activateTelegram(
  env: ActivationEnv,
  fetcher: typeof fetch = fetch,
  register = true,
) {
  const urls = deploymentUrls(env.appUrl);
  const probe = async (url: string, init: RequestInit = {}) => {
    try {
      return await fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error(
        "Deployment probe failed: network, TLS or redirect error.",
      );
    }
  };
  const live = await probe(urls.health);
  const info = (await live.json().catch(() => null)) as {
    service?: string;
    version?: number;
  } | null;
  if (!live.ok || info?.service !== "github-manager-bot" || info.version !== 4)
    throw new Error(
      "Deployment probe failed: final application health route is not available.",
    );
  const callbackProbe = await probe(urls.callback);
  if (callbackProbe.status !== 400)
    throw new Error(
      "Deployment probe failed: OAuth callback route is missing or does not reject an empty callback.",
    );
  const ready = await probe(urls.health + "?ready=1", {
    headers: { "x-telegram-bot-api-secret-token": env.telegramWebhookSecret },
  });
  const readyData = (await ready.json().catch(() => null)) as {
    status?: string;
  } | null;
  if (!ready.ok || readyData?.status !== "ready")
    throw new Error(
      "Deployment probe failed: database, private Storage, schema or background worker is not ready.",
    );
  const post = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  };
  const denied = await probe(urls.webhook, post);
  if (denied.status !== 401)
    throw new Error(
      "Deployment probe failed: webhook does not reject unauthenticated requests.",
    );
  const accepted = await probe(urls.webhook, {
    ...post,
    headers: {
      ...post.headers,
      "x-telegram-bot-api-secret-token": env.telegramWebhookSecret,
    },
  });
  if (!accepted.ok || (await accepted.json().catch(() => null))?.ok !== true)
    throw new Error(
      "Deployment probe failed: implemented webhook route did not accept the authenticated no-op probe.",
    );
  const api = async (method: string, body: unknown) => {
    let res: Response;
    try {
      res = await fetcher(
        `https://api.telegram.org/bot${env.telegramBotToken}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch {
      throw new Error(
        `Telegram ${method} failed: network or TLS error; token omitted.`,
      );
    }
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: unknown;
    } | null;
    if (!res.ok || !data?.ok)
      throw new Error(
        `Telegram ${method} failed (HTTP ${res.status}); token and provider response omitted.`,
      );
    return data.result;
  };
  if (register) {
    await api("setWebhook", {
      url: urls.webhook,
      secret_token: env.telegramWebhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
      max_connections: 10,
    });
  }
  const webhook = (await api("getWebhookInfo", {})) as {
    url?: string;
    pending_update_count?: number;
    last_error_date?: number;
  };
  if (webhook.url !== urls.webhook)
    throw new Error(
      "Telegram registration verification failed: getWebhookInfo URL does not match APP_URL and the implemented route.",
    );
  return {
    registered: register,
    registrationVerified: true,
    deploymentProbeVerified: true,
    webhookUrl: urls.webhook,
    callbackUrl: urls.callback,
    pendingUpdates: webhook.pending_update_count ?? 0,
    lastDeliveryErrorAt: webhook.last_error_date ?? null,
    publicUserTestRequired: true,
  };
}
