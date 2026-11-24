"use client";
import { useEffect, type ReactNode } from "react";

/** Small centered dialog. Esc or a tap outside closes it. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="mdl" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mdl-box" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
