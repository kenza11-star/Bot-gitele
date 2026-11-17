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
  verifying: "Memverifikasi ZIP",
  extracting: "Mengekstrak file proyek",
  validating: "Memvalidasi file",
  comparing: "Membandingkan dengan repositori",
  uploading_blobs: "Mengirim file ke GitHub",
  creating_commit: "Membuat commit",
  updating_branch: "Menunggu konfirmasi GitHub",
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
    return "Masalah jaringan. Periksa koneksi, lalu tekan Coba lagi.";
  if (err instanceof Error && err.message === "cancelled")
    return "Unggahan dibatalkan.";
  return "Terjadi kesalahan tak terduga. Tekan Coba lagi untuk melanjutkan.";
}

const CSS = `
  .up{max-width:720px;margin:0 auto}
  .up.page{padding:24px 16px 56px}
  .up h1{font-size:20px;font-weight:600;margin:0 0 6px;letter-spacing:-.01em}
  .up .muted{color:var(--text-2,#9aa0a6);font-size:13px;line-height:1.55;margin:0 0 16px}
  .up .card{border:1px solid var(--border,#2a2d33);border-radius:8px;padding:12px 14px;margin-bottom:12px;background:var(--surface,#17191d)}
  .up .row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:13px;padding:5px 0;flex-wrap:wrap}
  .up .row span:first-child{color:var(--text-2,#9aa0a6)}
  .up .row span:last-child{overflow-wrap:anywhere;min-width:0;font-variant-numeric:tabular-nums}
  .up .bar{height:6px;background:var(--border,#2a2d33);border-radius:3px;overflow:hidden;margin:10px 0}
  .up .bar>div{height:100%;background:var(--accent,#5bb4ff);transition:width .2s linear}
  .up .btn{background:var(--surface-2,#22252b);color:var(--text,#e6e6e6);border:1px solid var(--border-strong,#3a3e46);border-radius:6px;padding:9px 14px;font-size:14px;cursor:pointer;min-height:44px;font-family:inherit}
  .up .btn:hover:not(:disabled){border-color:var(--text-2,#9aa0a6)}
  .up .btn:focus-visible,.up .drop:focus-within{outline:2px solid var(--accent,#5bb4ff);outline-offset:2px}
  .up .btn:disabled{opacity:.5;cursor:not-allowed}
  .up .btn.primary{background:var(--accent,#5bb4ff);border-color:var(--accent,#5bb4ff);color:var(--on-accent,#06121f);font-weight:600}
  .up .drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center;border:1px dashed var(--border-strong,#3a3e46);border-radius:8px;padding:28px 16px;margin-bottom:12px;cursor:pointer;color:var(--text-2,#9aa0a6);font-size:14px;transition:border-color .15s,background .15s}
  .up .drop strong{color:var(--text,#e6e6e6);font-weight:600}
  .up .drop.over{border-color:var(--accent,#5bb4ff);background:var(--accent-soft,rgba(91,180,255,.08))}
  .up .drop.disabled{opacity:.5;cursor:not-allowed}
  .up .drop input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
  .up .error{color:var(--danger,#f08a8a);font-size:14px;line-height:1.5;margin:10px 0}
  .up .ok{color:var(--success,#8fd19e);font-size:14px;line-height:1.5;margin:10px 0}
  .up .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  .up .check{width:20px;height:20px;vertical-align:-4px;margin-right:6px}
  .up .check path{stroke-dasharray:24;stroke-dashoffset:24;animation:draw .5s ease-out forwards}
  @keyframes draw{to{stroke-dashoffset:0}}
  @media (prefers-reduced-motion:reduce){.up .check path{animation:none;stroke-dashoffset:0}.up .bar>div{transition:none}}
  @media (max-width:420px){.up .btn{flex:1 1 100%}}
`;

export default function Uploader({
  initialToken,
  embedded = false,
}: {
  /** Dashboard flow: an upload token already bound to one verified repository and branch. */
  initialToken?: string;
  embedded?: boolean;
} = {}) {
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
    if (initialToken) return () => abortRef.current?.abort();
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
              setErrorText(summary.error ?? "Pemrosesan GitHub gagal");
            }
          })
          .catch(() => {});
      window.history.replaceState(null, "", window.location.pathname);
    } else {
      setNotice(
        "Buka halaman ini lewat tombol Unggah ZIP dari bot Telegram, atau pilih repositori di dashboard.",
      );
    }
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!initialToken) return;
    setToken(initialToken);
    setNotice(null);
  }, [initialToken]);

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
            setErrorText(current.error ?? "Pemrosesan GitHub gagal");
          } else if (current.status === "cancelled") {
            setPhase("cancelled");
            setErrorText("Unggahan dibatalkan.");
          } else setPhase("processing");
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 401) {
            setNotice(
              "Tautan browser ini kedaluwarsa. Pemrosesan tetap berjalan; cek Telegram atau buka tautan /upload yang baru.",
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
      setErrorText("Pilih file berekstensi .zip.");
      return;
    }
    if (file.size <= 0) {
      setErrorText("File ini kosong.");
      return;
    }
    if (file.size > UPLOAD_LIMITS.webArchiveBytes) {
      setErrorText(
        `ZIP ini berukuran ${(file.size / MB).toFixed(1)} MB. Batas unggahan browser adalah 100 MB.`,
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
    setErrorText("Unggahan dibatalkan.");
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

  const [over, setOver] = useState(false);
  const pick = (f?: File | null) => {
    if (f) void start(f);
  };
  const statusText =
    phase === "preparing" ? "Menyiapkan…"
    : phase === "uploading" ? "Mengunggah…"
    : phase === "finishing" ? "Memverifikasi…"
    : phase === "ready" ? "Potongan terverifikasi; antre di GitHub"
    : phase === "processing" ? `GitHub: ${processingLabels[job?.stage ?? ""] ?? "Menunggu diproses"}`
    : phase === "completed" ? (job?.commitSha ? "Unggahan selesai" : "Sudah terbaru")
    : phase === "error" ? "Gagal"
    : phase === "cancelled" ? "Dibatalkan"
    : "";
  const Wrapper = embedded ? "section" : "main";
  return (
    <Wrapper className={embedded ? "up" : "up page"}>
      <style>{CSS}</style>
      {!embedded && <h1>Unggah ZIP</h1>}
      {!embedded && (
        <p className="muted">
          Unggah ZIP hingga 100 MiB ke repositori GitHub terpilih. Progres tampil di sini dan di Telegram.
        </p>
      )}

      {notice && <p className="error" role="alert">{notice}</p>}

      {token && (
        <>
          <label
            className={`drop${over ? " over" : ""}${busy || !scope ? " disabled" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy && scope) setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              if (!busy && scope) pick(e.dataTransfer?.files?.[0]);
            }}
          >
            <input
              aria-label="Pilih file ZIP atau pilih file yang sama untuk melanjutkan"
              type="file"
              accept=".zip,application/zip"
              disabled={busy || !scope}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                pick(f);
              }}
            />
            <strong>Seret file ZIP ke sini</strong>
            <span>atau ketuk untuk memilih · maksimal 100 MiB</span>
          </label>

          {(job || scope) && (
            <div className="card">
              <div className="row"><span>Repositori</span><span>{job?.repoFullName ?? scope?.repoFullName}</span></div>
              <div className="row"><span>Branch</span><span>{job?.branch ?? scope?.branch}</span></div>
              <div className="row">
                <span>File</span>
                <span>{job?.fileName ?? fileRef.current?.name ?? "Belum dipilih"}</span>
              </div>
            </div>
          )}

          {phase !== "idle" && (
            <div className="card">
              <div className="row"><span>Status</span><span>{statusText}</span></div>
              <div
                className="bar"
                aria-label="Progres unggah ZIP"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              >
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="row"><span>Progres</span><span>{total > 0 ? `${pct}%` : "—"}</span></div>
              <div className="row">
                <span>Terkirim</span>
                <span>{total > 0 ? `${(bytesDone / MB).toFixed(1)} / ${(total / MB).toFixed(1)} MB` : "—"}</span>
              </div>
              <div className="row">
                <span>Kecepatan</span>
                <span>
                  {phase === "uploading"
                    ? speed !== null
                      ? `${(speed / MB).toFixed(1)} MB/s`
                      : "mengukur…"
                    : "—"}
                </span>
              </div>
              <div className="row">
                <span>Potongan</span>
                <span>{chunkTotal > 0 ? `${chunksDone} / ${chunkTotal} (${CHUNK_LIMITS.defaultBytes / MB} MB per potongan)` : "—"}</span>
              </div>
              <div className="row"><span>Unggahan paralel</span><span>{phase === "uploading" ? concurrency : "—"}</span></div>
            </div>
          )}

          {phase === "ready" && (
            <p className="ok">
              ZIP diterima dan masuk antrean pemrosesan GitHub. Anda boleh meninggalkan halaman ini; progres juga dikirim ke Telegram.
            </p>
          )}
          {(phase === "processing" || phase === "completed") && (
            <p className="muted">
              File diproses: {job?.filesProcessed ?? 0} / {job?.filesTotal ?? "—"}.{" "}
              {phase === "completed" ? "Ditambah" : "Rencana ditambah"}: {job?.added ?? 0}, diperbarui: {job?.updated ?? 0}, tidak berubah: {job?.unchanged ?? 0}.
              {phase !== "completed" && " Perubahan belum di-commit sampai GitHub mengonfirmasi."}
            </p>
          )}
          {phase === "completed" && (
            <p className="ok" role="status">
              {job?.commitSha ? (
                <>
                  <svg className="check" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M4 10.5l4 4 8-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  GitHub mengonfirmasi commit {job.commitSha.slice(0, 7)} di {job.repoFullName} ({job.branch}).{" "}
                  {job.commitUrl && (
                    <a href={job.commitUrl} target="_blank" rel="noreferrer">Lihat commit</a>
                  )}
                </>
              ) : (
                "Sudah terbaru. Tidak ada commit yang dibuat."
              )}
            </p>
          )}
          {errorText && <p className="error" role="alert">{errorText}</p>}

          <div className="actions">
            {busy && job?.canCancel !== false && (
              <button className="btn" onClick={() => void cancel()}>Batal</button>
            )}
            {(phase === "error" || phase === "cancelled") && fileRef.current && (
              <button className="btn primary" onClick={() => fileRef.current && void start(fileRef.current)}>
                Coba lagi
              </button>
            )}
          </div>
        </>
      )}
    </Wrapper>
  );
}
