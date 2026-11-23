import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { getUsableToken } from "@/lib/github/credentials";
import { cachedAccessibleRepos, matchRepos } from "@/lib/github/search";

/** GET /api/web/repos/search?q=... -> repositories the GitHub App can reach that match q. */
export async function GET(req: NextRequest) {
  return withWebUser(req, async ({ userId, env }) => {
    const q = req.nextUrl.searchParams.get("q") ?? "";
    if (q.length > 100) return json({ error: "Kata pencarian terlalu panjang." }, 400);
    const cred = await getUsableToken(userId, env);
    if (!cred) return json({ error: "Akun GitHub belum terhubung.", code: "github_not_linked" }, 409);
    const all = await cachedAccessibleRepos(userId, cred.token);
    return json({ repos: matchRepos(all, q), total: all.length });
  });
}
