import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { openRepo } from "@/lib/web/repo-access";
import { changePath, cleanPath } from "@/lib/github/manage";
import { logActivity } from "@/lib/activity";

/** POST /api/web/repo/files {id, branch, op: "delete" | "rename", path, newPath?} -> one commit on the branch. */
export async function POST(req: NextRequest) {
  return withWebUser(
    req,
    async (user) => {
      const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!b || (b.op !== "delete" && b.op !== "rename")) return json({ error: "Operasi tidak valid." }, 400);
      const { token, repo, branch } = await openRepo(user, b.id, b.branch);
      const path = cleanPath(b.path);
      const op = b.op === "delete" ? ({ kind: "delete", path } as const) : ({ kind: "rename", path, newPath: cleanPath(b.newPath) } as const);
      const out = await changePath(token, repo.fullName, branch, op);
      await logActivity(user.userId, "repo_file_" + b.op, "success").catch(() => undefined);
      return json({ ok: true, commitSha: out.commitSha, files: out.files });
    },
    { limit: 40 },
  );
}
