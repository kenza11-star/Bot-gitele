import {
  github,
  githubRaw,
  GithubHttpError,
  GithubNotFoundError,
  UserFacingError,
} from "./client";
import { validateEntryPath } from "./upload";

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
}

/** Folder listing, folders first. An empty repository (no commits yet) lists as empty. */
export async function listDir(
  token: string,
  fullName: string,
  path: string,
  ref: string,
): Promise<DirEntry[]> {
  const url = `/repos/${fullName}/contents${path ? `/${enc(path)}` : ""}?ref=${encodeURIComponent(ref)}`;
  let data: unknown;
  try {
    data = await github<unknown>(token, url);
  } catch (e) {
    if (e instanceof GithubNotFoundError && !path) return [];
    throw e;
  }
  if (!Array.isArray(data)) throw new UserFacingError("Itu bukan folder.");
  const items = (data as { name: string; path: string; type: string; size?: number }[]).map(
    (i): DirEntry => ({
      name: i.name,
      path: i.path,
      type: i.type === "dir" ? "dir" : "file",
      size: i.size ?? 0,
    }),
  );
  return items.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string | null;
}

export type PathOp =
  | { kind: "delete"; path: string }
  | { kind: "rename"; path: string; newPath: string };

const MAX_CHANGED = 3000;

/** Cleans a user supplied repository path. Throws a friendly error for anything unsafe. */
export function cleanPath(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim().replace(/^\/+|\/+$/g, "") : "";
  const check = validateEntryPath(text);
  if (!check.ok) throw new UserFacingError("Nama atau path tidak valid.");
  return check.path;
}

/**
 * Deletes or renames a file or a whole folder as ONE commit on `branch`.
 * Works through the Git Data API so folders (which GitHub has no endpoint for) behave like files.
 */
export async function changePath(
  token: string,
  fullName: string,
  branch: string,
  op: PathOp,
): Promise<{ commitSha: string; files: number }> {
  const refPath = `/repos/${fullName}/git/refs/heads/${enc(branch)}`;
  const ref = await github<{ object: { sha: string } }>(token, refPath.replace("/git/refs/", "/git/ref/"));
  const head = ref.object.sha;
  const headCommit = await github<{ tree: { sha: string } }>(token, `/repos/${fullName}/git/commits/${head}`);
  const tree = await github<{ truncated: boolean; tree: TreeEntry[] }>(
    token,
    `/repos/${fullName}/git/trees/${headCommit.tree.sha}?recursive=1`,
  );
  if (tree.truncated) throw new UserFacingError("Repo terlalu besar untuk diubah dari dashboard.");

  const p = op.path;
  const affected = tree.tree.filter((e) => e.type !== "tree" && (e.path === p || e.path.startsWith(`${p}/`)));
  if (affected.length === 0) throw new UserFacingError("File atau folder tidak ditemukan di branch ini.");
  if (affected.length > MAX_CHANGED) throw new UserFacingError(`Terlalu banyak file (${affected.length}). Maksimal ${MAX_CHANGED}.`);

  const entries: TreeEntry[] = [];
  for (const e of affected) entries.push({ path: e.path, mode: e.mode, type: e.type, sha: null });

  if (op.kind === "rename") {
    const n = op.newPath;
    if (n === p) throw new UserFacingError("Nama baru sama dengan nama lama.");
    if (n.startsWith(`${p}/`)) throw new UserFacingError("Tidak bisa memindahkan folder ke dalam dirinya sendiri.");
    const clash = tree.tree.some(
      (e) => e.path === n || e.path.startsWith(`${n}/`) || (e.type !== "tree" && n.startsWith(`${e.path}/`)),
    );
    if (clash) throw new UserFacingError("Sudah ada file atau folder dengan nama itu.");
    for (const e of affected)
      entries.push({ path: n + e.path.slice(p.length), mode: e.mode, type: e.type, sha: e.sha });
  }

  const created = await github<{ sha: string }>(token, `/repos/${fullName}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: entries }),
  });
  const message =
    op.kind === "delete" ? `Delete ${p}` : `Rename ${p} to ${op.newPath}`;
  const commit = await github<{ sha: string }>(token, `/repos/${fullName}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: `${message} (via Kyn-X)`, tree: created.sha, parents: [head] }),
  });
  try {
    await githubRaw(token, refPath, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
  } catch (e) {
    if (e instanceof GithubHttpError && (e.status === 422 || e.status === 409))
      throw new UserFacingError("Branch baru saja berubah. Muat ulang lalu coba lagi.");
    throw e;
  }
  return { commitSha: commit.sha, files: affected.length };
}

const ADMIN_HINT =
  "GitHub App belum punya izin “Administration: Read and write”. Aktifkan di pengaturan GitHub App, lalu setujui pembaruan izin pada instalasi.";

export function validRepoName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === "." || name === ".." || name.endsWith(".git"))
    throw new UserFacingError("Nama repo hanya boleh huruf, angka, titik, minus, dan garis bawah.");
  return name;
}

export async function renameRepo(token: string, fullName: string, name: string): Promise<string> {
  try {
    const r = await github<{ full_name: string }>(token, `/repos/${fullName}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    return r.full_name;
  } catch (e) {
    if (e instanceof GithubHttpError && e.status === 403) throw new UserFacingError(ADMIN_HINT);
    if (e instanceof GithubHttpError && e.status === 422) throw new UserFacingError("Nama repo sudah dipakai atau tidak valid.");
    throw e;
  }
}

export async function deleteRepo(token: string, fullName: string): Promise<void> {
  try {
    await githubRaw(token, `/repos/${fullName}`, { method: "DELETE" });
  } catch (e) {
    if (e instanceof GithubHttpError && e.status === 403) throw new UserFacingError(ADMIN_HINT);
    throw e;
  }
}
