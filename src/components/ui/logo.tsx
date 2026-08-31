import { cn } from "@/lib/utils";

/** The Markdoc mark (public/brand/mark.svg): a document with a folded corner and the `#` heading glyph. Follows the accent token. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width="32" height="32" className={className} aria-hidden>
      <path d="M9 2h12l9 9v12a7 7 0 0 1-7 7H9a7 7 0 0 1-7-7V9a7 7 0 0 1 7-7z" fill="var(--color-accent)" />
      <path d="M21 2v6a3 3 0 0 0 3 3h6z" fill="var(--color-on-accent)" fillOpacity="0.42" />
      <path d="M10 13.5h13M9 19.5h13M14.5 9.5l-2 13M20 9.5l-2 13" stroke="var(--color-on-accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/** Mark + name, for the dashboard and landing headers. */
export function Wordmark({ className, nameClassName }: { className?: string; nameClassName?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <Logo className="h-8 w-8" />
      <span className={cn("wordmark text-lg font-semibold text-ink", nameClassName)}>Markdoc</span>
    </span>
  );
}
