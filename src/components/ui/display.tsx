"use client";

import * as React from "react";
import { cn, initials } from "@/lib/utils";

/* ---------------- Avatar ---------------- */

export function Avatar({
  name,
  src,
  color,
  size = 36,
  className,
  title,
}: {
  name: string;
  src?: string | null;
  color?: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const style: React.CSSProperties = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.36)) };
  if (color) style.boxShadow = `0 0 0 2px var(--color-surface), 0 0 0 4px ${color}`;
  return (
    <span className={cn("avatar", className)} style={style} title={title ?? name}>
      <AvatarContent key={src} name={name} src={src} color={color} size={size} />
    </span>
  );
}

function AvatarContent({ name, src, color, size }: {
  name: string;
  src?: string | null;
  color?: string;
  size: number;
}) {
  const [failed, setFailed] = React.useState(false);
  return src && !failed ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={name} width={size} height={size} className="h-full w-full object-cover" onError={() => setFailed(true)} referrerPolicy="no-referrer" />
  ) : (
    <span style={color ? { color } : undefined}>{initials(name)}</span>
  );
}

/* ---------------- Misc ---------------- */

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("h-4 w-4 animate-spin text-ink-3", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function EmptyState({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 text-ink-4">{icon}</div>}
      <div className="text-sm font-medium text-ink-2">{title}</div>
      {children && <div className="max-w-xs text-[13px] text-ink-3">{children}</div>}
    </div>
  );
}
