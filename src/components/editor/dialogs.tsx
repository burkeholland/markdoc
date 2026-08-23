"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, Kbd } from "@/components/ui/primitives";
import { shortcut } from "@/lib/utils";

export function LinkDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: { href: string; text: string } | null;
  onSubmit: (href: string, text: string) => void;
  onRemove?: () => void;
}) {
  const [href, setHref] = useState("");
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) {
      setHref(initial?.href ?? "");
      setText(initial?.text ?? "");
    }
  }, [open, initial]);
  const normalize = (v: string) => {
    const t = v.trim();
    if (!t) return t;
    if (/^(https?:|mailto:|#|\/|\.)/i.test(t)) return t;
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(t)) return `https://${t}`;
    return t;
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={initial?.href ? "Edit link" : "Insert link"}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!href.trim()) return;
            onSubmit(normalize(href), text.trim());
            onOpenChange(false);
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
            URL
            <input className="input" placeholder="https://example.com" value={href} onChange={(e) => setHref(e.target.value)} autoFocus data-testid="link-url" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
            Text
            <input className="input" placeholder="Link text (optional)" value={text} onChange={(e) => setText(e.target.value)} data-testid="link-text" />
          </label>
          <div className="flex items-center justify-between pt-1">
            {initial?.href && onRemove ? (
              <button
                type="button"
                className="btn btn-ghost text-danger"
                onClick={() => {
                  onRemove();
                  onOpenChange(false);
                }}
              >
                Remove link
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={!href.trim()} data-testid="link-submit">
                Apply
              </button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ImageDialog({
  open,
  onOpenChange,
  onSubmit,
  onUpload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (src: string, alt: string) => void;
  /** Uploads a chosen file and returns the URL to use; when absent the Upload button is hidden. */
  onUpload?: (file: File) => Promise<{ url: string; alt?: string }>;
}) {
  const [src, setSrc] = useState("");
  const [alt, setAlt] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setSrc("");
      setAlt("");
      setError(null);
      setUploading(false);
    }
  }, [open]);
  const chooseFile = async (file: File | undefined) => {
    if (!file || !onUpload) return;
    setError(null);
    setUploading(true);
    try {
      const result = await onUpload(file);
      setSrc(result.url);
      setAlt((current) => current || result.alt || file.name.replace(/\.[a-z0-9]{2,5}$/i, ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Insert image" description="Paste the address of an image or upload one. Alt text describes the image for people who can't see it.">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!src.trim()) return;
            onSubmit(src.trim(), alt.trim());
            onOpenChange(false);
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
            Image URL
            <div className="flex gap-2">
              <input className="input flex-1" placeholder="https://…/image.png" value={src} onChange={(e) => setSrc(e.target.value)} autoFocus data-testid="image-url" />
              {onUpload && (
                <>
                  <button type="button" className="btn btn-outline shrink-0" onClick={() => fileInput.current?.click()} disabled={uploading} data-testid="image-upload">
                    {uploading ? "Uploading…" : "Upload…"}
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                    className="hidden"
                    onChange={(e) => void chooseFile(e.target.files?.[0])}
                    data-testid="image-file"
                  />
                </>
              )}
            </div>
          </label>
          {error && (
            <div className="text-sm text-danger" role="alert" data-testid="image-upload-error">
              {error}
            </div>
          )}
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
            Alt text
            <input className="input" placeholder="Describe the image" value={alt} onChange={(e) => setAlt(e.target.value)} data-testid="image-alt" />
          </label>
          {src.trim() && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src.trim()} alt="" className="max-h-40 rounded-lg border border-line object-contain" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!src.trim()} data-testid="image-submit">
              Insert
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TableDialog({ open, onOpenChange, onSubmit }: { open: boolean; onOpenChange: (open: boolean) => void; onSubmit: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState<{ r: number; c: number }>({ r: 3, c: 3 });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Insert table" description="Pick a size. The first row becomes the header.">
        <div className="flex flex-col items-center gap-3">
          <div className="grid grid-cols-8 gap-1" onMouseLeave={() => setHover({ r: 3, c: 3 })} data-testid="table-grid">
            {Array.from({ length: 6 }, (_, r) =>
              Array.from({ length: 8 }, (_, c) => (
                <button
                  key={`${r}-${c}`}
                  type="button"
                  className={`h-6 w-6 rounded border ${r < hover.r && c < hover.c ? "border-accent bg-accent-soft" : "border-line-2 bg-surface"}`}
                  onMouseEnter={() => setHover({ r: r + 1, c: c + 1 })}
                  onClick={() => {
                    onSubmit(r + 1, c + 1);
                    onOpenChange(false);
                  }}
                  aria-label={`${r + 1} by ${c + 1}`}
                />
              )),
            )}
          </div>
          <div className="text-sm text-ink-3">
            {hover.r} rows × {hover.c} columns
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function NameVersionDialog({ open, onOpenChange, onSubmit }: { open: boolean; onOpenChange: (open: boolean) => void; onSubmit: (title: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setTitle("");
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Name this version" description="Named versions stay easy to find in the history.">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) return;
            setBusy(true);
            try {
              await onSubmit(title.trim());
              onOpenChange(false);
            } finally {
              setBusy(false);
            }
          }}
        >
          <input className="input" placeholder="e.g. Draft sent for review" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus data-testid="version-name" />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()} data-testid="version-name-submit">
              Save version
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: "Formatting",
    items: [
      ["Bold", "Mod-B"],
      ["Italic", "Mod-I"],
      ["Strikethrough", "Mod-Shift-X"],
      ["Inline code", "Mod-`"],
      ["Link", "Mod-K"],
      ["Heading 1–6 / Paragraph", "Mod-Alt-1…6 / 0"],
      ["Bulleted list", "Mod-Shift-8"],
      ["Numbered list", "Mod-Shift-7"],
      ["Task list", "Mod-Shift-9"],
      ["Quote", "Mod-Shift-."],
      ["Code block", "Mod-Alt-C"],
    ],
  },
  {
    group: "Editing",
    items: [
      ["Undo / Redo", "Mod-Z / Mod-Shift-Z"],
      ["Line break", "Shift-Enter"],
      ["Indent / outdent list item", "Tab / Shift-Tab"],
      ["Add comment", "Mod-Alt-M"],
      ["Find", "Mod-F"],
      ["Find and replace", "Mod-H"],
      ["Next / previous match", "Enter / Shift-Enter"],
      ["Close find", "Esc"],
    ],
  },
  {
    group: "Tables",
    items: [
      ["Next / previous cell", "Tab / Shift-Tab"],
      ["Row below / above", "Mod-Alt-↓ / ↑"],
      ["Column right / left", "Mod-Alt-→ / ←"],
      ["Delete row", "Mod-Alt-⌫"],
      ["Delete column", "Mod-Alt-Shift-⌫"],
      ["New row from the last cell", "Enter"],
      ["Delete empty table", "⌫"],
    ],
  },
  {
    group: "Blocks",
    items: [["Insert block menu", "/"]],
  },
  {
    group: "Markdown shortcuts in the preview",
    items: [
      ["Heading", "# + space"],
      ["List", "- or 1. + space"],
      ["Task", "- [ ] + space"],
      ["Quote", "> + space"],
      ["Code block", "``` + language"],
      ["Divider", "---"],
    ],
  },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts" wide>
        <div className="grid gap-6 sm:grid-cols-2">
          {SHORTCUTS.map((g) => (
            <div key={g.group}>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">{g.group}</div>
              <ul className="flex flex-col gap-1.5">
                {g.items.map(([label, keys]) => (
                  <li key={label} className="flex items-center justify-between gap-3 text-sm text-ink-2">
                    <span>{label}</span>
                    <Kbd>{shortcut(keys)}</Kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
