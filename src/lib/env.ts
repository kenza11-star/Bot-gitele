export class EnvError extends Error {}

const REQUIRED = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY_BASE64",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_SLUG",
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "TELEGRAM_ALLOWED_USER_IDS",
  "APP_URL",
] as const;

export interface AppEnv {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  encryptionKey: Buffer;
  allowedAdminIds: ReadonlySet<string>;
  appUrl: string;
}

export function loadEnv(source: Record<string, string | undefined> = process.env): AppEnv {
  const missing = REQUIRED.filter((name) => !source[name]?.trim());
  if (missing.length > 0) {
    throw new EnvError(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const encryptionKey = Buffer.from(source.ENCRYPTION_KEY!.trim(), "base64");
  if (encryptionKey.length !== 32) {
    throw new EnvError("ENCRYPTION_KEY must decode to exactly 32 bytes (base64).");
  }

  const adminIds = source.TELEGRAM_ALLOWED_USER_IDS!.split(",").map((s) => s.trim()).filter(Boolean);
  if (adminIds.length === 0 || !adminIds.every((id) => /^\d+$/.test(id))) {
    throw new EnvError("TELEGRAM_ALLOWED_USER_IDS must be a comma-separated list of numeric Telegram IDs.");
  }

  let appUrl: URL;
  try {
    appUrl = new URL(source.APP_URL!);
  } catch {
    throw new EnvError("APP_URL must be an absolute URL, e.g. https://your-app.vercel.app");
  }
  if (appUrl.protocol !== "https:" && appUrl.hostname !== "localhost") {
    throw new EnvError("APP_URL must use https in production.");
  }

  return {
    telegramBotToken: source.TELEGRAM_BOT_TOKEN!.trim(),
    telegramWebhookSecret: source.TELEGRAM_WEBHOOK_SECRET!.trim(),
    encryptionKey,
    allowedAdminIds: new Set(adminIds),
    appUrl: appUrl.origin,
  };
}
