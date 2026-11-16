import { createHash, randomBytes } from "node:crypto";
import { db } from "../db";

export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/** Creates a one-time, 10-minute state bound to a Telegram user. Only the hash is stored. */
export async function createLoginState(telegramUserId: number): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  await db().query(
    `insert into app.oauth_states (state_hash, telegram_user_id, expires_at)
     values ($1, $2, now() + interval '10 minutes')`,
    [hashState(state), telegramUserId],
  );
  return state;
}

/** Atomically consumes a state. Returns the bound Telegram user ID, or null if invalid, expired, or reused. */
export async function consumeLoginState(state: string): Promise<number | null> {
  const { rows } = await db().query<{ telegram_user_id: string }>(
    `update app.oauth_states set used_at = now()
     where state_hash = $1 and used_at is null and expires_at > now()
     returning telegram_user_id`,
    [hashState(state)],
  );
  return rows[0] ? Number(rows[0].telegram_user_id) : null;
}
