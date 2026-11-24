import { getUsableToken } from "../github/credentials";
import { assertRepoAccessible, type RepoSummary } from "../github/repos";
import { getBranch } from "../github/branches";
import { UploadError } from "../upload/service";
import type { WebUser } from "./auth";

/** Resolves a repo id to a repository this user's own installation can reach (never trusts a name from the browser). */
export async function openRepo(
  user: WebUser,
  rawId: unknown,
  rawBranch?: unknown,
): Promise<{ token: string; repo: RepoSummary; branch: string }> {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new UploadError(400, "repoId tidak valid.");
  const cred = await getUsableToken(user.userId, user.env);
  if (!cred) throw new UploadError(409, "Akun GitHub belum terhubung.");
  const repo = await assertRepoAccessible(cred.token, id);
  const branch =
    typeof rawBranch === "string" && rawBranch ? await getBranch(cred.token, repo.fullName, rawBranch) : repo.defaultBranch;
  return { token: cred.token, repo, branch };
}
