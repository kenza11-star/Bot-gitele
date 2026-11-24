"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useSession, ApiFail } from "../session";
import { useApi, type Me } from "../hooks";
import { ErrorNotice, Icon, NotLinked } from "../ui";

interface Hit { id: number; fullName: string; description: string | null; stars: number; language: string | null; url: string; avatar: string }

const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

/** Live search across ALL public repositories on GitHub. Each keystroke (debounced) refreshes the list. */
export default function GithubSearchPage() {
  const { call } = useSession();
  const me = useApi<Me>("/api/web/me");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState(0);
  const [gen, setGen] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setHits([]);
      setTotal(0);
      setStatus("idle");
      setErr(null);
      return;
    }
    let live = true;
    const ctl = new AbortController();
    setStatus("loading");
    // GitHub search allows ~30 requests/minute, so wait a beat after the last keystroke.
    const t = window.setTimeout(async () => {
      try {
        const r = await call<{ items: Hit[]; total: number }>("GET", `/api/web/github-search?q=${encodeURIComponent(term)}`, undefined, ctl.signal);
        if (!live) return;
        setHits(r.items);
        setTotal(r.total);
        setGen((g) => g + 1);
        setStatus("done");
        setErr(null);
      } catch (e) {
        if (!live || (e instanceof DOMException && e.name === "AbortError")) return;
        setStatus("error");
        setErr(e instanceof ApiFail ? e.message : "Pencarian gagal. Coba lagi.");
      }
    }, 280);
    return () => {
      live = false;
      ctl.abort();
      window.clearTimeout(t);
    };
  }, [q, call]);

  return (
    <div className="stack">
      <div className="page-head"><div><h1>Cari di GitHub</h1><p>Cari semua repositori publik di GitHub berdasarkan nama.</p></div></div>
      <ErrorNotice error={me.error} />
      {me.data && !me.data.github && <NotLinked installUrl={me.data.installUrl} />}
      {me.data?.github && (
        <section className="panel rs" aria-labelledby="gs-title">
          <header><h2 id="gs-title">Pencarian</h2>{status === "done" && <span className="muted rs-count">{total.toLocaleString("id-ID")} hasil</span>}</header>
          <div className="body rs-body">
            <label className={`rs-box${status === "loading" ? " busy" : ""}`} onClick={() => input.current?.focus()}>
              <Icon name="search" />
              <input ref={input} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ketik nama repo…" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-label="Cari repositori publik GitHub" autoFocus />
              {q && <button type="button" className="rs-clear" aria-label="Hapus pencarian" onClick={() => { setQ(""); input.current?.focus(); }}>×</button>}
            </label>
            {err && <p className="rs-err" role="alert">{err}</p>}
            <ul className={`gs-list${status === "loading" ? " dim" : ""}`} key={gen}>
              {hits.map((h, i) => (
                <li key={h.id} className="rs-row" style={{ "--i": Math.min(i, 12) } as CSSProperties}>
                  <a className="gs-item" href={h.url} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={h.avatar} alt="" width={36} height={36} loading="lazy" />
                    <span className="gs-body">
                      <span className="gs-name">{h.fullName}</span>
                      {h.description && <span className="gs-desc">{h.description}</span>}
                      <span className="gs-meta">
                        <span><Icon name="star" />{compact(h.stars)}</span>
                        {h.language && <span>{h.language}</span>}
                      </span>
                    </span>
                    <Icon name="ext" />
                  </a>
                </li>
              ))}
            </ul>
            {status === "idle" && <div className="rs-empty">Mulai mengetik, hasil muncul di sini.</div>}
            {status === "done" && hits.length === 0 && <div className="rs-empty">Tidak ada repo publik yang cocok dengan “{q.trim()}”.</div>}
          </div>
        </section>
      )}
    </div>
  );
}
