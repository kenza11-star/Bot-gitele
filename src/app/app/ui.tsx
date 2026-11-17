"use client";
import { useState } from "react";
import { formatBytes, formatTime, jobProgress, statusInfo } from "@/lib/web/format";
import { useSession, ApiFail } from "./session";
import type { Job } from "./hooks";

const P: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  upload: "M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  git: "M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 0c0 4-6 3-12 6",
  cog: "M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
};
export function Icon({ name }: { name: keyof typeof P }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}

export function ErrorNotice({ error }: { error: ApiFail | string | null }) {
  if (!error) return null;
  const msg = typeof error === "string" ? error : error.message;
  return <div className="notice bad" role="alert">{msg}</div>;
}

export function NotLinked({ installUrl }: { installUrl?: string }) {
  return (
    <div className="panel"><div className="empty">
      <strong>Akun GitHub belum terhubung</strong>
      Kirim <code>/login</code> di bot Telegram, selesaikan otorisasi, lalu muat ulang halaman ini.
      {installUrl && <p style={{ marginTop: 8 }}><a href={installUrl} target="_blank" rel="noreferrer">Instal GitHub App pada repositori</a></p>}
    </div></div>
  );
}

export function JobItem({ job, onChanged }: { job: Job; onChanged: () => void }) {
  const { call } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const info = statusInfo(job.status, job.stage);
  const pct = jobProgress(job);
  const act = async (kind: "cancel" | "retry") => {
    if (kind === "cancel" && !window.confirm("Batalkan unggahan ini? Perubahan yang belum di-commit tidak akan dikirim.")) return;
    setBusy(kind);
    setErr(null);
    try {
      await call("POST", `/api/web/jobs/${job.id}/${kind}`, {});
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiFail ? e.message : "Gagal. Coba lagi.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <li>
      <div className="top">
        <span><strong>{job.repoFullName}</strong> <span className="muted">· {job.branch}</span></span>
        <span className={`badge ${info.tone === "idle" ? "" : info.tone}`}>{info.label}</span>
      </div>
      <div className="meta">
        <span className="mono" title={job.id}>{job.id.slice(0, 8)}</span>
        <span>{job.fileName ?? "ZIP"} · {formatBytes(job.totalBytes)}</span>
        <span>{formatTime(job.createdAt)}</span>
        {job.filesTotal != null && <span>{job.filesProcessed}/{job.filesTotal} file · +{job.added} ~{job.updated} ={job.unchanged}</span>}
      </div>
      {info.open && job.status !== "created" && (
        <div
          className={`bar${pct === null ? " indeterminate" : ""}`}
          role="progressbar"
          aria-label="Progres"
          aria-valuemin={0}
          aria-valuemax={100}
          {...(pct !== null ? { "aria-valuenow": pct } : {})}
        >
          <div style={pct !== null ? { width: `${pct}%` } : undefined} />
        </div>
      )}
      {job.status === "failed" && job.error && <p className="muted" style={{ color: "var(--danger)" }}>{job.error}</p>}
      {err && <ErrorNotice error={err} />}
      <div className="actions">
        {job.commitUrl && <a className="btn sm" href={job.commitUrl} target="_blank" rel="noreferrer">Lihat commit {job.commitSha?.slice(0, 7)}</a>}
        {job.actionsRunUrl && <a className="btn sm" href={job.actionsRunUrl} target="_blank" rel="noreferrer">Run GitHub Actions</a>}
        {job.canCancel && <button className="btn sm danger" disabled={busy !== null} onClick={() => void act("cancel")}>{busy === "cancel" ? "Membatalkan…" : "Batalkan"}</button>}
        {job.canRetry && <button className="btn sm" disabled={busy !== null} onClick={() => void act("retry")}>{busy === "retry" ? "Mengantre…" : "Coba lagi"}</button>}
      </div>
    </li>
  );
}
