import { createHmac, timingSafeEqual } from "node:crypto";

export interface ApkClaims {
  /** Telegram user whose GitHub credential downloads the artifact. */
  u: number;
  repo: string;
  run: number;
  exp: number;
}

const TTL_MS = 7 * 24 * 3600_000;

const key = (secret: Buffer) => createHmac("sha256", secret).update("apk-link-v1").digest();
const mac = (payload: string, secret: Buffer) => createHmac("sha256", key(secret)).update(payload).digest("base64url");

export function signApkToken(c: Omit<ApkClaims, "exp">, secret: Buffer, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...c, exp: now + TTL_MS })).toString("base64url");
  return `${payload}.${mac(payload, secret)}`;
}

export function verifyApkToken(token: string | null, secret: Buffer, now = Date.now()): ApkClaims | null {
  const [payload, sig, extra] = (token ?? "").split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const want = Buffer.from(mac(payload, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString()) as ApkClaims;
    if (!Number.isSafeInteger(c.u) || !Number.isSafeInteger(c.run) || typeof c.repo !== "string" || !(c.exp > now)) return null;
    if (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(c.repo)) return null;
    return c;
  } catch {
    return null;
  }
}
