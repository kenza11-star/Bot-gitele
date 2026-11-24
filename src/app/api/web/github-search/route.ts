import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { getUsableToken } from "@/lib/github/credentials";
import { searchPublicRepos } from "@/lib/github/public-search";

/** GET /api/web/github-search?q=...&page=1 -> public repositories anywhere on GitHub whose name matches q. */
export async function GET(req: NextRequest) {
  return withWebUser(
    req,
    async ({ userId, env }) => {
      const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
      if (q.length > 100) return json({ error: "Kata pencarian terlalu panjang." }, 400);
      if (!q) return json({ total: 0, items: [] });
      const page = Math.min(10, Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1));
      const cred = await getUsableToken(userId, env);
      if (!cred) return json({ error: "Akun GitHub belum terhubung.", code: "github_not_linked" }, 409);
      return json(await searchPublicRepos(cred.token, q, page));
    },
    { limit: 90 },
  );
}
