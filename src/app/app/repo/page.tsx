"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession, ApiFail } from "../session";
import { ErrorNotice, Icon } from "../ui";
import { Modal } from "../modal";
import { formatBytes } from "@/lib/web/format";

interface Item { name: string; path: string; type: "file" | "dir"; size: number }
interface Listing {
  repo: { id: number; fullName: string; defaultBranch: string; private: boolean };
  branch: string;
  path: string;
  items: Item[];
  branches?: string[];
}
type Dialog =
  | { kind: "rename"; item: Item }
  | { kind: "delete"; item: Item }
  | { kind: "repo-rename" }
  | { kind: "repo-delete" };

function RepoFiles() {
  const { call } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const path = params.get("path") ?? "";
  const branch = params.get("branch") ?? "";
  const [data, setData] = useState<Listing | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const go = useCallback(
    (next: { path?: string; branch?: string }) => {
      const q = new URLSearchParams({ id });
      const p = next.path ?? "";
      const b = next.branch ?? branch;
      if (p) q.set("path", p);
      if (b) q.set("branch", b);
      router.push(`/app/repo?${q.toString()}`);
    },
    [id, branch, router],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ id, path, branches: "1" });
      if (branch) q.set("branch", branch);
      const r = await call<Listing>("GET", `/api/web/repo/contents?${q.toString()}`);
      setData(r);
      if (r.branches) setBranches(r.branches);
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiFail ? e.message : "Gagal memuat isi repo.");
    } finally {
      setLoading(false);
    }
  }, [call, id, path, branch]);
  useEffect(() => {
    if (id) void load();
  }, [id, load]);

  const open = (d: Dialog) => {
    setErr(null);
    setNotice(null);
    setText(d.kind === "rename" ? d.item.name : d.kind === "repo-rename" ? (data?.repo.fullName.split("/")[1] ?? "") : "");
    setDialog(d);
  };
  const close = () => !busy && setDialog(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setDialog(null);
    } catch (e) {
      setErr(e instanceof ApiFail ? e.message : "Gagal. Coba lagi.");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!dialog || !data) return;
    const dir = path ? `${path}/` : "";
    if (dialog.kind === "rename")
      return run(async () => {
        await call("POST", "/api/web/repo/files", { id, branch: data.branch, op: "rename", path: dialog.item.path, newPath: `${dir}${text.trim()}` });
        setNotice(`“${dialog.item.name}” diganti jadi “${text.trim()}”.`);
        await load();
      });
    if (dialog.kind === "delete")
      return run(async () => {
        await call("POST", "/api/web/repo/files", { id, branch: data.branch, op: "delete", path: dialog.item.path });
        setNotice(`“${dialog.item.name}” dihapus.`);
        await load();
      });
    if (dialog.kind === "repo-rename")
      return run(async () => {
        await call("POST", "/api/web/repo/rename", { id, name: text.trim() });
        setNotice("Nama repo diganti.");
        await load();
      });
    return run(async () => {
      await call("POST", "/api/web/repo/delete", { id, confirm: text.trim() });
      router.replace("/app");
    });
  };

  const crumbs = path ? path.split("/") : [];
  const repoName = data?.repo.fullName ?? "Repositori";
  const dialogTitle =
    dialog?.kind === "rename" ? "Ganti nama" : dialog?.kind === "delete" ? "Hapus" : dialog?.kind === "repo-rename" ? "Ganti nama repo" : "Hapus repo";
  const confirmOk =
    dialog?.kind === "repo-delete" ? text.trim() === data?.repo.fullName : dialog?.kind === "delete" ? true : text.trim().length > 0;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p><Link href="/app">← Dasbor</Link></p>
          <h1 className="fm-title">{repoName}</h1>
          {data && (
            <p className="fm-badges">
              <span className="badge">{data.repo.private ? "privat" : "publik"}</span>
              <a href={`https://github.com/${data.repo.fullName}`} target="_blank" rel="noreferrer">Buka di GitHub</a>
            </p>
          )}
        </div>
      </div>
      <ErrorNotice error={dialog ? null : err} />
      {notice && <div className="notice ok" role="status">{notice}</div>}

      <section className="panel" aria-labelledby="fm-h">
        <header>
          <h2 id="fm-h">Berkas</h2>
          {branches.length > 0 && (
            <select aria-label="Branch" className="fm-branch" value={data?.branch ?? ""} onChange={(e) => go({ branch: e.target.value })}>
              {(data && !branches.includes(data.branch) ? [data.branch, ...branches] : branches).map((b) => <option key={b}>{b}</option>)}
            </select>
          )}
        </header>
        <nav className="fm-crumbs" aria-label="Lokasi">
          <button type="button" onClick={() => go({})} disabled={!path}>{data?.repo.fullName.split("/")[1] ?? "repo"}</button>
          {crumbs.map((c, i) => (
            <span key={crumbs.slice(0, i + 1).join("/")}>
              <i aria-hidden="true">/</i>
              <button type="button" disabled={i === crumbs.length - 1} onClick={() => go({ path: crumbs.slice(0, i + 1).join("/") })}>{c}</button>
            </span>
          ))}
        </nav>
        {loading && !data ? <div className="empty">Memuat…</div> : data && data.items.length === 0 ? (
          <div className="empty"><strong>Folder kosong</strong></div>
        ) : (
          <ul className={`fm-list${loading ? " dim" : ""}`}>
            {data?.items.map((it) => (
              <li key={it.path} className="fm-row">
                {it.type === "dir" ? (
                  <button type="button" className="fm-main" onClick={() => go({ path: it.path })}>
                    <Icon name="folder" /><span className="fm-name">{it.name}</span>
                  </button>
                ) : (
                  <a className="fm-main" href={`https://github.com/${data.repo.fullName}/blob/${encodeURIComponent(data.branch)}/${it.path.split("/").map(encodeURIComponent).join("/")}`} target="_blank" rel="noreferrer">
                    <Icon name="file" /><span className="fm-name">{it.name}</span><small>{formatBytes(it.size)}</small>
                  </a>
                )}
                <span className="fm-acts">
                  <button type="button" className="fm-act" aria-label={`Ganti nama ${it.name}`} onClick={() => open({ kind: "rename", item: it })}><Icon name="edit" /></button>
                  <button type="button" className="fm-act bad" aria-label={`Hapus ${it.name}`} onClick={() => open({ kind: "delete", item: it })}><Icon name="trash" /></button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="rp-h">
        <header><h2 id="rp-h">Repositori</h2></header>
        <div className="body actions">
          <button className="btn" disabled={!data} onClick={() => open({ kind: "repo-rename" })}>Ganti nama repo</button>
          <button className="btn danger" disabled={!data} onClick={() => open({ kind: "repo-delete" })}>Hapus repo</button>
        </div>
      </section>

      {dialog && data && (
        <Modal title={dialogTitle} onClose={close}>
          {dialog.kind === "delete" && (
            <p className="muted">
              Hapus <strong>{dialog.item.name}</strong>{dialog.item.type === "dir" ? " beserta seluruh isinya" : ""} dari branch <code>{data.branch}</code>? Dibuat 1 commit; bisa dikembalikan lewat riwayat Git.
            </p>
          )}
          {dialog.kind === "rename" && (
            <label className="field"><span>Nama baru</span>
              <input type="text" value={text} onChange={(e) => setText(e.target.value)} autoFocus autoCapitalize="none" spellCheck={false} />
              <small className="muted">Isi dengan <code>folder/nama</code> untuk memindahkan.</small>
            </label>
          )}
          {dialog.kind === "repo-rename" && (
            <label className="field"><span>Nama repo baru</span>
              <input type="text" value={text} onChange={(e) => setText(e.target.value)} autoFocus autoCapitalize="none" spellCheck={false} />
              <small className="muted">Tautan lama ke repo ini akan dialihkan GitHub, tapi sebaiknya perbarui remote Git Anda.</small>
            </label>
          )}
          {dialog.kind === "repo-delete" && (
            <>
              <p className="muted">Repo <strong>{data.repo.fullName}</strong> dihapus permanen beserta isi, issue, dan riwayatnya. Ketik nama lengkap untuk konfirmasi.</p>
              <label className="field"><span>Nama repo</span>
                <input type="text" value={text} onChange={(e) => setText(e.target.value)} autoFocus autoCapitalize="none" spellCheck={false} placeholder={data.repo.fullName} />
              </label>
            </>
          )}
          {err && <p className="rs-err" role="alert">{err}</p>}
          <div className="actions mdl-actions">
            <button className="btn" disabled={busy} onClick={close}>Batal</button>
            <button
              className={`btn ${dialog.kind === "delete" || dialog.kind === "repo-delete" ? "danger" : "primary"}`}
              disabled={busy || !confirmOk}
              onClick={() => void submit()}
            >
              {busy ? "Memproses…" : dialog.kind === "delete" || dialog.kind === "repo-delete" ? "Hapus" : "Simpan"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function RepoPage() {
  return (
    <Suspense fallback={<div className="empty">Memuat…</div>}>
      <RepoFiles />
    </Suspense>
  );
}
