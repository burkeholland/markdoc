"use client";

import { ChevronDown } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Menu, MenuCheckboxItem, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/primitives";
import { PREVIEW_FONTS, isPreviewFont, previewFontStore, setPreviewFont } from "@/lib/preview-font";
import { previewCodeWrapStore, setPreviewCodeWrap } from "@/lib/preview-code-wrap";

/** Display preferences only: shared by this browser's previews, never written to a document. */
export function PreviewMenu() {
  const font = useSyncExternalStore(previewFontStore.subscribe, previewFontStore.getSnapshot, previewFontStore.getServerSnapshot);
  const wrap = useSyncExternalStore(previewCodeWrapStore.subscribe, previewCodeWrapStore.getSnapshot, previewCodeWrapStore.getServerSnapshot);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="preview-menu-trigger" aria-label="Preview settings" data-testid="preview-menu-trigger">
          View
          <ChevronDown size={13} aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent className="w-64 max-w-[calc(100vw-16px)] p-1.5" data-testid="preview-menu">
        <MenuCheckboxItem aria-label="Wrap code blocks" checked={wrap} onCheckedChange={(checked) => setPreviewCodeWrap(checked === true)}>
          Wrap code blocks
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuLabel>Preview font</MenuLabel>
        <MenuRadioGroup value={font} onValueChange={(value) => isPreviewFont(value) && setPreviewFont(value)}>
          {PREVIEW_FONTS.map((f) => (
            <MenuRadioItem key={f.id} value={f.id} data-testid={`preview-font-${f.id}`}>
              <span className="font-semibold" style={{ fontFamily: f.family }}>
                {f.label}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
