"use client";

import { useEffect, useRef, useState } from "react";
import {
  AdaptiveConcurrency,
  HttpError,
  runPool,
  withRetry,
} from "@/lib/transfer/engine";
import { throughput, type Sample } from "@/lib/telegram/progress";
import { resumeStorageKey, type ResumeScope } from "@/lib/upload/resume";
import { CHUNK_LIMITS, UPLOAD_LIMITS } from "@/lib/upload/limits";

const START_CONCURRENCY = 6;
const MIN_CONCURRENCY = 2;
const MAX_CONCURRENCY = 16;
const MB = 1024 * 1024;
const processingLabels: Record<string, string> = {
  verifying: "Verifying ZIP",
  extracting: "Extracting project files",
  validating: "Validating files",
  comparing: "Comparing repository files",
  uploading_blobs: "Uploading GitHub files",
  creating_commit: "Creating commit",
  updating_branch: "Confirming GitHub commit",
};

interface ChunkInfo {
  index: number;
  size: number;
  status: string;
}

interface JobSummary {
  id: string;
  status: string;
  fileName: string;
  repoFullName: string;
  branch: string;
  totalBytes: number;
  chunkSize: number;
  chunkCount: number;
  bytesVerified: number;
  chunks: ChunkInfo[];
  missing: number[];
  stage?: string | null;
  filesTotal?: number | null;
  filesProcessed?: number;
  filesExtracted?: number;
  added?: number;
  updated?: number;
  unchanged?: number;
  commitSha?: string | null;
  commitUrl?: string | null;
  error?: string | null;
  canCancel?: boolean;
}

type Phase =
  | "idle"
  | "preparing"
  | "uploading"
  | "finishing"
  | "processing"
  | "completed"
  | "ready"
  | "error"
  | "cancelled";

/** An HTTP failure carrying the server's message and Retry-After hint. */
class ApiError extends HttpError {
  constructor(status: number, retryAfterMs: number | null, message: string) {
    super(status, retryAfterMs);
    this.message = message;
  }
}

function retryAfterMs(res: {
  headers: { get(name: string): string | null };
}): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const seconds = Number(v);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

async function api<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
  } & Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      retryAfterMs(res),
      data.error ?? `Request failed (${res.status})`,
    );
  }
  return data as T;
}

/** PUTs one chunk to its signed URL and reports real bytes sent. XHR is used because fetch cannot report upload progress. */
function putChunk(
  url: string,
  body: ArrayBuffer,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      signal.removeEventListener("abort", onAbort);
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 409) {
        resolve();
      } else {
        const hint = xhr.getResponseHeader("retry-after");
        const seconds = hint ? Number(hint) : NaN;
        reject(
          new ApiError(
            [400, 401, 403].includes(xhr.status) ? 425 : xhr.status,
            Number.isFinite(seconds) ? seconds * 1000 : null,
            `Storage rejected the chunk (${xhr.status})`,
          ),
        );
      }
    };
    xhr.onerror = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new TypeError("Network error during chunk upload"));
    };
    xhr.ontimeout = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new TypeError("Chunk upload timed out"));
    };
    xhr.onabort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("cancelled"));
    };
    const onAbort = () => xhr.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    xhr.send(body);
  });
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function chunkBytes(job: JobSummary, index: number): number {
  const start = index * job.chunkSize;
  return Math.min(job.chunkSize, job.totalBytes - start);
}

function resumeKey(storageKey: string): string {
  try {
    const existing = window.localStorage.getItem(storageKey);
    if (
      existing &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        existing,
      )
    )
      return existing;
    const fresh = crypto.randomUUID();
    window.localStorage.setItem(storageKey, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}
function clearResumeKey(storageKey: string): void {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    /* optional persistence */
  }
}

function messageFor(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError)
    return "Network problem. Check your connection, then press Retry.";
  if (err instanceof Error && err.message === "cancelled")
    return "Upload cancelled.";
  return "Unexpected error. Press Retry to resume.";
}

const CSS = `
  .wrap{max-width:560px;margin:0 auto;padding:20px 16px 48px;box-sizing:border-box}
  h1{font-size:18px;font-weight:600;margin:0 0 6px}
  .muted{color:#9aa0a6;font-size:13px;line-height:1.5;margin:0 0 16px}
  .card{border:1px solid #2a2d33;border-radius:6px;padding:14px;margin-bottom:14px;background:#17191d}
  .row{display:flex;justify-content:space-between;gap:12px;font-size:14px;padding:4px 0;flex-wrap:wrap}
  .row span:first-child{color:#9aa0a6}.row span:last-child{overflow-wrap:anywhere;min-width:0}.row{align-items:baseline}
  .bar{height:10px;background:#2a2d33;border-radius:4px;overflow:hidden;margin:10px 0}
  .bar>div{height:100%;background:#4f8cff;transition:width .2s linear}
  .btn{background:#2a2d33;color:#e6e6e6;border:1px solid #3a3e46;border-radius:6px;padding:9px 14px;font-size:14px;cursor:pointer;min-height:44px}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .btn.primary{background:#4f8cff;border-color:#4f8cff;color:#fff}
  .file{display:block;margin-bottom:14px}
  .file input{width:100%;font-size:14px;color:#e6e6e6}
  .error{color:#f08a8a;font-size:14px;line-height:1.5;margin:10px 0}
  .ok{color:#8fd19e;font-size:14px;line-height:1.5;margin:10px 0}
  .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  @media (max-width:420px){.btn{flex:1 1 100%}}
`;

export default function Uploader() {
  const [token, setToken] = useState<string | null>(null);
  const [scope, setScope] = useState<ResumeScope | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [job, setJob] = useState<JobSummary | null>(null);
  const [bytesDone, setBytesDone] = useState(0);
  const [speed, setSpeed] = useState<number | null>(null);
  const [concurrency, setConcurrency] = useState(START_CONCURRENCY);
  const [chunksDone, setChunksDone] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);

  const resumeStorageRef = useRef<string | null>(null);
  const jobRef = useRef<JobSummary | null>(null);
  const fileRef = useRef<File | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const controllerRef = useRef<AdaptiveConcurrency | null>(null);
  const loadedRef = useRef<Map<number, number>>(new Map());
  const verifiedRef = useRef<Set<number>>(new Set());
  const samplesRef = useRef<Sample[]>([]);

  // Read the session token from the URL fragment, then remove it from the address bar.
  useEffect(() => {
    let t = new URLSearchParams(window.location.hash.slice(1)).get("t");
    try {
      if (t) window.sessionStorage.setItem("gm-upload-session", t);
      else t = window.sessionStorage.getItem("gm-upload-session");
    } catch {
      /* Tokens stay in memory if storage is unavailable. */
    }
    if (t) {
      setToken(t);
      let last: string | null = null;
      try {
        last = window.sessionStorage.getItem("gm-upload-last-job");
      } catch {}
      if (last && /^[0-9a-f-]{36}$/i.test(last))
        void api<JobSummary>("GET", `/api/upload/jobs/${last}`, t)
          .then((summary) => {
            setJob(summary);
            jobRef.current = summary;
            if (["uploaded", "processing"].includes(summary.status))
              setPhase("processing");
            else if (summary.status === "completed") setPhase("completed");
            else if (["failed", "expired"].includes(summary.status)) {
              setPhase("error");
              setErrorText(summary.error ?? "GitHub processing failed");
            }
          })
          .catch(() => {});
      window.history.replaceState(null, "", window.location.pathname);
    } else {
      setNotice(
        "Open this page with the Upload ZIP button from the Telegram bot.",
      );
    }
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!token) return;
    const abort = new AbortController();
    setScope(null);
    void api<ResumeScope>(
      "GET",
      "/api/upload/context",
      token,
      undefined,
      abort.signal,
    )
      .then(setScope)
      .catch((err) => {
        if (!abort.signal.aborted) setNotice(messageFor(err));
      });
    return () => abort.abort();
  }, [token]);

  // Real progress: sums the bytes each chunk has actually sent or verified.
  useEffect(() => {
    if (phase !== "uploading") return;
    const id = window.setInterval(() => {
      const done = Array.from(loadedRef.current.values()).reduce(
        (s, n) => s + n,
        0,
      );
      const now = Date.now();
      samplesRef.current = [
        ...samplesRef.current,
        { t: now, bytes: done },
      ].filter((s) => now - s.t <= 15_000);
      setBytesDone(done);
      setSpeed(throughput(samplesRef.current));
      setConcurrency(controllerRef.current?.limit ?? START_CONCURRENCY);
    }, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  // Background work is durable; polling only displays its persisted state.
  useEffect(() => {
    if (!job || !token || !["uploaded", "processing"].includes(job.status))
      return;
    const abort = new AbortController();
    const id = window.setInterval(() => {
      void api<JobSummary>(
        "GET",
        `/api/upload/jobs/${job.id}`,
        token,
        undefined,
        abort.signal,
      )
        .then((current) => {
          jobRef.current = current;
          setJob(current);
          if (current.status === "completed") {
            setPhase("completed");
            if (resumeStorageRef.current)
              clearResumeKey(resumeStorageRef.current);
          } else if (["failed", "expired"].includes(current.status)) {
            setPhase("error");
            setErrorText(current.error ?? "GitHub processing failed");
          } else if (current.status === "cancelled") {
            setPhase("cancelled");
            setErrorText("Upload cancelled.");
          } else setPhase("processing");
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 401) {
            setNotice(
              "This browser link expired. Processing continues; check Telegram or open a fresh /upload link.",
            );
            window.clearInterval(id);
          }
        });
    }, 3000);
    return () => {
      window.clearInterval(id);
      abort.abort();
    };
  }, [job?.id, job?.status, token]);

  async function uploadChunk(
    summary: JobSummary,
    file: File,
    index: number,
    tok: string,
    abort: AbortController,
  ) {
    const size = chunkBytes(summary, index);
    const start = index * summary.chunkSize;
    const body = await file.slice(start, start + size).arrayBuffer();
    const sha = await sha256Hex(body);

    await withRetry(
      async () => {
        loadedRef.current.set(index, 0);
        const signed = await api<{
          verified: boolean;
          url?: string;
          attemptId?: string;
        }>(
          "POST",
          `/api/upload/jobs/${summary.id}/chunks/${index}/sign`,
          tok,
          undefined,
          abort.signal,
        );
        if (!signed.verified) {
          if (!signed.url) throw new Error("Server returned no upload URL");
          await putChunk(
            signed.url,
            body,
            (loaded) => loadedRef.current.set(index, loaded),
            abort.signal,
          );
          try {
            // Retry verification without uploading bytes again after an ambiguous API response.
            await withRetry(
              () =>
                api(
                  "POST",
                  `/api/upload/jobs/${summary.id}/chunks/${index}/complete`,
                  tok,
                  { sha256: sha, size, attemptId: signed.attemptId },
                  abort.signal,
                ),
              { attempts: 5, baseMs: 800, maxMs: 15_000, signal: abort.signal },
            );
          } catch (err) {
            if (err instanceof ApiError && err.status === 422)
              throw new ApiError(425, null, err.message);
            throw err;
          }
        }
      },
      { attempts: 5, baseMs: 800, maxMs: 15_000, signal: abort.signal },
    );

    loadedRef.current.set(index, size);
    verifiedRef.current.add(index);
    setChunksDone(verifiedRef.current.size);
  }

  async function start(file: File) {
    if (!token || (abortRef.current && !abortRef.current.signal.aborted))
      return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setErrorText("Please choose a .zip file.");
      return;
    }
    if (file.size <= 0) {
      setErrorText("This file is empty.");
      return;
    }
    if (file.size > UPLOAD_LIMITS.webArchiveBytes) {
      setErrorText(
        `This ZIP is ${(file.size / MB).toFixed(1)} MB. The browser limit is 100 MB.`,
      );
      return;
    }

    jobRef.current = null;
    setJob(null);
    fileRef.current = file;
    setErrorText(null);
    setNotice(null);
    setPhase("preparing");
    samplesRef.current = [];
    const abort = new AbortController();
    abortRef.current = abort;

    let storageKey: string | null = null;
    try {
      if (!scope)
        throw new ApiError(
          401,
          null,
          "Open the upload link from Telegram again.",
        );
      const fileSha256 = await sha256Hex(await file.arrayBuffer());
      if (abort.signal.aborted) throw new Error("cancelled");
      storageKey = resumeStorageKey(scope, file, fileSha256);
      resumeStorageRef.current = storageKey;
      const create = () =>
        api<JobSummary>(
          "POST",
          "/api/upload/jobs",
          token,
          {
            fileName: file.name,
            totalBytes: file.size,
            fileSha256,
            clientKey: resumeKey(storageKey!),
          },
          abort.signal,
        );
      let summary: JobSummary;
      try {
        summary = await create();
      } catch (err) {
        if (!(err instanceof ApiError) || ![409, 410].includes(err.status))
          throw err;
        clearResumeKey(storageKey);
        summary = await create();
      }
      jobRef.current = summary;
      try {
        window.sessionStorage.setItem("gm-upload-last-job", summary.id);
      } catch {}
      if (
        summary.status !== "created" &&
        summary.status !== "uploading" &&
        summary.status !== "uploaded" &&
        summary.status !== "processing" &&
        summary.status !== "completed"
      ) {
        if (storageKey) clearResumeKey(storageKey);
        throw new ApiError(
          409,
          null,
          `This upload is ${summary.status}. Send /upload in Telegram to start a new one.`,
        );
      }
      setJob(summary);

      verifiedRef.current = new Set(
        summary.chunks
          .filter((c) => c.status === "verified")
          .map((c) => c.index),
      );
      loadedRef.current = new Map();
      verifiedRef.current.forEach((i) =>
        loadedRef.current.set(i, chunkBytes(summary, i)),
      );
      setChunksDone(verifiedRef.current.size);
      setBytesDone(summary.bytesVerified);

      if (summary.missing.length > 0) {
        setPhase("uploading");
        const controller = new AdaptiveConcurrency(
          START_CONCURRENCY,
          MIN_CONCURRENCY,
          MAX_CONCURRENCY,
        );
        controllerRef.current = controller;
        await runPool(
          summary.missing,
          controller,
          (index) => uploadChunk(summary, file, index, token, abort),
          abort.signal,
        );
      }

      setPhase("finishing");
      const ready = await withRetry(
        () =>
          api<JobSummary>(
            "POST",
            `/api/upload/jobs/${summary.id}/ready`,
            token,
            undefined,
            abort.signal,
          ),
        { attempts: 5, baseMs: 800, maxMs: 15_000, signal: abort.signal },
      );
      jobRef.current = ready;
      setJob(ready);
      setBytesDone(ready.bytesVerified);
      if (ready.status === "completed" && storageKey)
        clearResumeKey(storageKey);
      setPhase(ready.status === "completed" ? "completed" : "ready");
    } catch (err) {
      if (abort.signal.aborted) return;
      abort.abort(); // Stop all outstanding browser transfers on failure.
      setPhase("error");
      setErrorText(messageFor(err));
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
    }
  }

  async function cancel() {
    const active = abortRef.current;
    active?.abort();
    const current = jobRef.current;
    if (current && token) {
      try {
        await api("POST", `/api/upload/jobs/${current.id}/cancel`, token);
      } catch (err) {
        setErrorText(messageFor(err));
        setPhase(
          ["uploaded", "processing"].includes(current.status)
            ? "processing"
            : "error",
        );
        return;
      }
    }
    setPhase("cancelled");
    setErrorText("Upload cancelled.");
  }

  const busy =
    phase === "preparing" ||
    phase === "uploading" ||
    phase === "finishing" ||
    phase === "ready" ||
    phase === "processing";
  const total = job?.totalBytes ?? fileRef.current?.size ?? 0;
  const pct =
    total > 0 ? Math.min(100, Math.floor((bytesDone / total) * 100)) : 0;
  const chunkTotal = job?.chunkCount ?? 0;

  return (
    <main className="wrap">
      <style>{CSS}</style>
      <h1>Upload ZIP</h1>
      <p className="muted">
        Upload a ZIP up to 100 MiB to the selected GitHub repository. Track
        progress here and in Telegram.
      </p>

      {notice && <p className="error">{notice}</p>}

      {token && (
        <>
          <label className="file">
            <input
              aria-label="Choose ZIP file or select the same file to resume"
              type="file"
              accept=".zip,application/zip"
              disabled={busy || !scope}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void start(f);
              }}
            />
          </label>

          {(job || scope) && (
            <div className="card">
              <div className="row">
                <span>Repository</span>
                <span>{job?.repoFullName ?? scope?.repoFullName}</span>
              </div>
              <div className="row">
                <span>Branch</span>
                <span>{job?.branch ?? scope?.branch}</span>
              </div>
              <div className="row">
                <span>File</span>
                <span>
                  {job?.fileName ??
                    fileRef.current?.name ??
                    "Choose a ZIP file"}
                </span>
              </div>
            </div>
          )}

          {phase !== "idle" && (
            <div className="card">
              <div className="row">
                <span>Status</span>
                <span>
                  {phase === "preparing" && "Preparing…"}
                  {phase === "uploading" && "Uploading…"}
                  {phase === "finishing" && "Verifying…"}
                  {phase === "ready" && "Chunks verified; queued for GitHub"}
                  {phase === "processing" &&
                    `GitHub: ${processingLabels[job?.stage ?? ""] ?? "Queued for processing"}`}
                  {phase === "completed" &&
                    (job?.commitSha
                      ? "Upload completed"
                      : "Already up to date")}
                  {phase === "error" && "Failed"}
                  {phase === "cancelled" && "Cancelled"}
                </span>
              </div>
              <div
                className="bar"
                aria-label="ZIP upload progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              >
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="row">
                <span>Progress</span>
                <span>{total > 0 ? `${pct}%` : "—"}</span>
              </div>
              <div className="row">
                <span>Transferred</span>
                <span>
                  {total > 0
                    ? `${(bytesDone / MB).toFixed(1)} / ${(total / MB).toFixed(1)} MB`
                    : "—"}
                </span>
              </div>
              <div className="row">
                <span>Speed</span>
                <span>
                  {phase === "uploading"
                    ? speed !== null
                      ? `${(speed / MB).toFixed(1)} MB/s`
                      : "measuring…"
                    : "—"}
                </span>
              </div>
              <div className="row">
                <span>Chunks</span>
                <span>
                  {chunkTotal > 0
                    ? `${chunksDone} / ${chunkTotal} (${CHUNK_LIMITS.defaultBytes / MB} MB each)`
                    : "—"}
                </span>
              </div>
              <div className="row">
                <span>Parallel uploads</span>
                <span>{phase === "uploading" ? concurrency : "—"}</span>
              </div>
            </div>
          )}

          {phase === "ready" && (
            <p className="ok">
              Your ZIP was received and queued for GitHub processing. You can
              leave this page and follow progress in Telegram.
            </p>
          )}
          {(phase === "processing" || phase === "completed") && (
            <p className="muted">
              Files processed: {job?.filesProcessed ?? 0} /{" "}
              {job?.filesTotal ?? "—"}.{" "}
              {phase === "completed" ? "Added" : "Planned added"}:{" "}
              {job?.added ?? 0}, updated: {job?.updated ?? 0}, unchanged:{" "}
              {job?.unchanged ?? 0}.
              {phase !== "completed" &&
                "Changes are not committed until GitHub confirms."}
            </p>
          )}
          {phase === "completed" && (
            <p className="ok">
              {job?.commitSha ? (
                <>
                  GitHub confirmed commit {job.commitSha.slice(0, 7)}.{" "}
                  {job.commitUrl && (
                    <a href={job.commitUrl} target="_blank" rel="noreferrer">
                      View commit
                    </a>
                  )}
                </>
              ) : (
                "Already up to date. No commit was created."
              )}
            </p>
          )}
          {errorText && <p className="error">{errorText}</p>}

          <div className="actions">
            {busy && job?.canCancel !== false && (
              <button className="btn" onClick={() => void cancel()}>
                Cancel
              </button>
            )}
            {(phase === "error" || phase === "cancelled") &&
              fileRef.current && (
                <button
                  className="btn primary"
                  onClick={() => fileRef.current && void start(fileRef.current)}
                >
                  Retry
                </button>
              )}
          </div>
        </>
      )}
    </main>
  );
}
