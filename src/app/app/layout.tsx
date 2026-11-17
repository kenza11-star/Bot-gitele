"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SessionProvider, useSession } from "./session";
import { Icon } from "./ui";
import { useApi, type Me } from "./hooks";

const NAV = [
  { href: "/app", label: "Dasbor", icon: "home" },
  { href: "/app/upload", label: "Unggah", icon: "upload" },
  { href: "/app/activity", label: "Aktivitas", icon: "list" },
  { href: "/app/github", label: "GitHub", icon: "git" },
  { href: "/app/settings", label: "Pengaturan", icon: "cog" },
] as const;

function SignedOut() {
  return (
    <main className="land" style={{ maxWidth: 520, paddingTop: 72 }}>
      <h1>Masuk lewat Telegram</h1>
      <p className="muted" style={{ marginTop: 8 }}>
        Dashboard tidak memakai kata sandi. Kirim <code>/web</code> ke bot Kyn-X, lalu ketuk tombol “Open dashboard”. Tautan berlaku 8 jam dan hanya untuk akun Telegram Anda.
      </p>
      <div className="cta"><Link className="btn" href="/">Kembali ke beranda</Link></div>
    </main>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { token, ready } = useSession();
  const me = useApi<Me>("/api/web/me");
  if (!ready) return null;
  if (!token) return <SignedOut />;
  return (
    <div className="shell">
      <aside className="side">
        <Link className="brand" href="/"><span className="mark" aria-hidden="true">K</span>Kyn-X</Link>
        <nav className="nav" aria-label="Navigasi dashboard">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={path === n.href ? "page" : undefined}>
              <Icon name={n.icon} />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="who">{me.data?.github ? <>GitHub: <strong>{me.data.github.login}</strong></> : "GitHub belum terhubung"}</div>
      </aside>
      <main className="main" id="konten">{children}</main>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
