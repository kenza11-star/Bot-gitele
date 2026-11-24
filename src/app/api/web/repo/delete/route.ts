import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { openRepo } from "@/lib/web/repo-access";
import { deleteRepo } from "@/lib/github/manage";
import { invalidateRepoCache } from "@/lib/github/search";
import { clearSelection, getUserState } from "@/lib/telegram/state";
import { logActivity } from "@/lib/activity";

/** POST /api/web/repo/delete {id, confirm}  -- confirm must equal the repository's full name. */
export async function POST(req: NextRequest) {
  return withWebUser(
    req,
    async (user) => {
      const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      const { token, repo } = await openRepo(user, b?.id);
      if (b?.confirm !== repo.fullName) return json({ error: "Ketik nama repo lengkap untuk konfirmasi." }, 400);
      await deleteRepo(token, repo.fullName);
      invalidateRepoCache(user.userId);
      if ((await getUserState(user.userId)).repoId === repo.id) await clearSelection(user.userId);
      await logActivity(user.userId, "repo_delete", "success").catch(() => undefined);
      return json({ ok: true });
    },
    { limit: 10 },
  );
}
