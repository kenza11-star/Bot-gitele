import { listAccessibleRepos, type RepoSummary } from "./repos";

/** Searches only repositories the user's GitHub App installations expose (never all of GitHub). */
const TTL_MS = 60_000;
const cache = new Map<number, { at: number; repos: RepoSummary[] }>();

export async function cachedAccessibleRepos(userId: number, token: string): Promise<RepoSummary[]> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.repos;
  const repos = await listAccessibleRepos(token);
  if (cache.size > 500) cache.clear();
  cache.set(userId, { at: Date.now(), repos });
  return repos;
}

/** Forget the cached repo list (after a rename or delete). */
export function invalidateRepoCache(userId: number): void {
  cache.delete(userId);
}

function inOrder(text: string, needle: string): boolean {
  let i = 0;
  for (const c of text) if (c === needle[i] && ++i === needle.length) return true;
  return false;
}

/** Ranking: name starts with the query, name contains it, full name contains it, letters in order. */
export function matchRepos(repos: RepoSummary[], query: string, limit = 25): RepoSummary[] {
  const t = query.trim().toLowerCase();
  if (!t) return repos.slice(0, limit);
  const scored: { r: RepoSummary; s: number }[] = [];
  for (const r of repos) {
    const full = r.fullName.toLowerCase();
    const name = full.slice(full.indexOf("/") + 1);
    const s = name.startsWith(t) ? 0 : name.includes(t) ? 1 : full.includes(t) ? 2 : inOrder(name, t) ? 3 : -1;
    if (s >= 0) scored.push({ r, s });
  }
  scored.sort((a, b) => a.s - b.s || a.r.fullName.localeCompare(b.r.fullName));
  return scored.slice(0, limit).map((x) => x.r);
}
