import { github, GithubHttpError } from "./client";

export interface PublicRepo {
  id: number;
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  url: string;
  avatar: string;
  updatedAt: string;
}

interface Raw {
  id: number;
  full_name: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  html_url: string;
  updated_at: string;
  owner: { avatar_url: string };
}

// Search results are public, so one small cache serves everybody. GitHub allows only 30 searches/min per user.
const cache = new Map<string, { at: number; value: { total: number; items: PublicRepo[] } }>();
const TTL_MS = 30_000;

/** Searches EVERY public repository on GitHub by name. */
export async function searchPublicRepos(
  token: string,
  query: string,
  page = 1,
): Promise<{ total: number; items: PublicRepo[] }> {
  const q = query.trim();
  const key = `${q.toLowerCase()}|${page}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: { total: number; items: PublicRepo[] };
  try {
    const r = await github<{ total_count: number; items: Raw[] }>(
      token,
      `/search/repositories?q=${encodeURIComponent(`${q} in:name is:public`)}&per_page=20&page=${page}`,
    );
    value = {
      total: r.total_count,
      items: r.items.map((i) => ({
        id: i.id,
        fullName: i.full_name,
        description: i.description,
        stars: i.stargazers_count,
        language: i.language,
        url: i.html_url,
        avatar: i.owner.avatar_url,
        updatedAt: i.updated_at,
      })),
    };
  } catch (e) {
    // GitHub answers 422 for queries it cannot parse; show "no results" instead of an error.
    if (e instanceof GithubHttpError && e.status === 422) value = { total: 0, items: [] };
    else throw e;
  }
  if (cache.size > 300) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}
