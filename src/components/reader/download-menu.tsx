"use client";

import { ChevronDown, Download, FileCode2, FileText } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { navigateTo } from "@/lib/nav";

/** "Download" split button: Markdown, HTML or PDF through the existing export route. */
export function DownloadMenu({ docId }: { docId: string }) {
  const href = (format: "md" | "html" | "pdf") => `/api/documents/${docId}/export?format=${format}&download=1`;
  return (
    <div className="flex items-stretch">
      <button
        type="button"
        className="btn btn-sm btn-outline reader-split-main gap-1.5"
        aria-label="Download Markdown"
        onClick={() => navigateTo(href("md"))}
        data-testid="reader-download"
      >
        <Download size={14} />
        <span className="hidden sm:inline">Download</span>
      </button>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="btn btn-sm btn-outline reader-split-more" aria-label="Download as…" data-testid="reader-download-menu">
            <ChevronDown size={14} className="shrink-0" />
          </button>
        </MenuTrigger>
        <MenuContent align="end" className="w-48">
          <MenuItem icon={<Download size={15} />} onSelect={() => navigateTo(href("md"))} data-testid="reader-download-md">
            Markdown
          </MenuItem>
          <MenuItem icon={<FileCode2 size={15} />} onSelect={() => navigateTo(href("html"))} data-testid="reader-download-html">
            HTML
          </MenuItem>
          <MenuItem icon={<FileText size={15} />} onSelect={() => navigateTo(href("pdf"))} data-testid="reader-download-pdf">
            PDF
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
