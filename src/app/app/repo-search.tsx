"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useSession, ApiFail } from "./session";
import { Icon } from "./ui";

interface Hit { id: number; fullName: string; defaultBranch: string; private: boolean }

/** Live search across the repositories the GitHub App can reach. Every keystroke (debounced) refreshes the list. */
export function RepoSearch({ selectedId, onPicked }: { selectedId: number | null; onPicked: () => Promise<void> | void }) {
  const { call } = useSession();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [gen, setGen] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    let live = true;
    const ctl = new AbortController();
    setStatus("loading");
    const t = window.setTimeout(async () => {
      try {
        const r = await call<{ repos: Hit[]; total: number }>("GET", `/api/web/repos/search?q=${encodeURIComponent(term)}`, undefined, ctl.signal);
        if (!live) return;
        setHits(r.repos);
        setTotal(r.total);
        setGen((g) => g + 1);
        setStatus("done");
        setErr(null);
      } catch (e) {
        if (!live || (e instanceof DOMException && e.name === "AbortError")) return;
        setStatus("error");
        setErr(e instanceof ApiFail ? e.message : "Pencarian gagal. Coba lagi.");
      }
    }, 160);
    return () => {
      live = false;
      ctl.abort();
      window.clearTimeout(t);
    };
  }, [q, call]);

  const pick = async (h: Hit) => {
    setBusy(h.id);
    setErr(null);
    try {
      // Keep it as the upload target too, then open its files.
      await call("POST", "/api/web/selection", { repoId: h.id });
      await onPicked();
      router.push(`/app/repo?id=${h.id}`);
    } catch (e) {
      setErr(e instanceof ApiFail ? e.message : "Gagal membuka repositori.");
      setBusy(null);
    }
  };

  const input = useRef<HTMLInputElement>(null);
  return (
    <section className="panel rs" aria-labelledby="rs-title">
      <header><h2 id="rs-title">Cari repositori</h2>{total !== null && <span className="muted rs-count">{total} tersedia</span>}</header>
      <div className="body rs-body">
        <label className={`rs-box${status === "loading" ? " busy" : ""}`} onClick={() => input.current?.focus()}>
          <Icon name="search" />
          <input
            ref={input}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ketik nama repo…"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-label="Cari repositori"
          />
          {q && <button type="button" className="rs-clear" aria-label="Hapus pencarian" onClick={() => { setQ(""); input.current?.focus(); }}>×</button>}
        </label>
        {err && <p className="rs-err" role="alert">{err}</p>}
        <ul className={`rs-list${status === "loading" ? " dim" : ""}`} key={gen}>
          {hits.map((h, i) => (
            <li key={h.id} className={`rs-row${selectedId === h.id ? " sel" : ""}`} style={{ "--i": Math.min(i, 12) } as CSSProperties}>
              <button type="button" onClick={() => void pick(h)} disabled={busy !== null}>
                <span className="rs-name"><Icon name={h.private ? "lock" : "globe"} /><span>{h.fullName}</span></span>
                <span className="rs-meta">{selectedId === h.id ? "Terpilih" : busy === h.id ? "Membuka…" : h.defaultBranch}</span>
              </button>
            </li>
          ))}
        </ul>
        {status === "done" && hits.length === 0 && (
          <div className="rs-empty">{q.trim() ? `Tidak ada repo yang cocok dengan “${q.trim()}”.` : "Belum ada repositori yang diizinkan."}</div>
        )}
      </div>
    </section>
  );
}
