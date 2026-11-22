import { github, UserFacingError } from "../github/client";
import { ARTIFACT_LIMIT, downloadBinary } from "../github/actions";
import { readCentralDirectory, inflateZipEntry } from "../upload/zip-entries";
import { validateEntryPath } from "../github/upload";

export interface RunArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  archive_download_url: string;
}

/** Newest usable artifact of one workflow run; names that look like an APK win. */
export async function findRunArtifact(token: string, fullName: string, runId: number): Promise<RunArtifact | null> {
  const data = await github<{ artifacts: RunArtifact[] }>(
    token,
    `/repos/${fullName}/actions/runs/${runId}/artifacts?per_page=100`,
  );
  const ok = data.artifacts.filter((a) => !a.expired && a.size_in_bytes > 0 && a.size_in_bytes <= ARTIFACT_LIMIT);
  return ok.find((a) => /apk|android|app/i.test(a.name)) ?? ok[0] ?? null;
}

/** First regular .apk inside an artifact ZIP, inflated up to `limit` bytes. null when there is none. */
export function apkFromZip(zip: Uint8Array, limit: number): { name: string; data: Uint8Array } | null {
  const entry = readCentralDirectory(zip).find(
    (e) => !e.isDirectory && !e.isSymlink && e.name.toLowerCase().endsWith(".apk") && e.size <= limit,
  );
  if (!entry) return null;
  if (!validateEntryPath(entry.name).ok) throw new UserFacingError("Unsafe APK archive path");
  return { name: entry.name.split("/").pop() ?? "app.apk", data: inflateZipEntry(zip, entry, limit) };
}

export async function fetchRunApk(
  token: string,
  fullName: string,
  runId: number,
  limit: number,
): Promise<{ name: string; data: Uint8Array } | null> {
  const artifact = await findRunArtifact(token, fullName, runId);
  if (!artifact) return null;
  const zip = await downloadBinary(token, artifact.archive_download_url, ARTIFACT_LIMIT);
  return apkFromZip(zip, limit);
}
