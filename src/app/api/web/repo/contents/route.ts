import { NextRequest } from "next/server";
import { withWebUser, json } from "@/lib/web/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { openRepo } from "@/lib/web/repo-access";
import { listDir, cleanPath } from "@/lib/github/manage";
import { listBranches } from "@/lib/github/branches";

/** GET /api/web/repo/contents?id=&path=&branch=&branches=1 -> files and folders of one repository folder. */
export async function GET(req: NextRequest) {
  return withWebUser(req, async (user) => {
    const q = req.nextUrl.searchParams;
    const { token, repo, branch } = await openRepo(user, q.get("id"), q.get("branch"));
    const rawPath = q.get("path") ?? "";
    const path = rawPath ? cleanPath(rawPath) : "";
    const items = await listDir(token, repo.fullName, path, branch);
    const branches = q.get("branches") === "1" ? await listBranches(token, repo.fullName).catch(() => [branch]) : undefined;
    return json({ repo, branch, path, items, branches });
  });
}
