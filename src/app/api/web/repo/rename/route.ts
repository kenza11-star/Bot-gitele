import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { openRepo } from "@/lib/web/repo-access";
import { renameRepo, validRepoName } from "@/lib/github/manage";
import { invalidateRepoCache } from "@/lib/github/search";
import { logActivity } from "@/lib/activity";
import { db } from "@/lib/db";

/** POST /api/web/repo/rename {id, name} */
export async function POST(req: NextRequest) {
  return withWebUser(
    req,
    async (user) => {
      const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      const name = validRepoName(b?.name);
      const { token, repo } = await openRepo(user, b?.id);
      const fullName = await renameRepo(token, repo.fullName, name);
      invalidateRepoCache(user.userId);
      await db().query(
        "update app.telegram_users set selected_repo_full_name=$3 where id=$1 and selected_repo_id=$2",
        [user.userId, repo.id, fullName],
      );
      await logActivity(user.userId, "repo_rename", "success").catch(() => undefined);
      return json({ ok: true, fullName });
    },
    { limit: 20 },
  );
}
