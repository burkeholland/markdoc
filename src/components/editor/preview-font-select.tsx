"use client";

import { ChevronDown } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Menu, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/primitives";
import { PREVIEW_FONTS, isPreviewFont, previewFontStore, setPreviewFont } from "@/lib/preview-font";

/** The preview's font choice: a compact "Aa" button that opens a menu showing each face in itself. Saved in this browser. */
export function PreviewFontSelect() {
  const font = useSyncExternalStore(previewFontStore.subscribe, previewFontStore.getSnapshot, previewFontStore.getServerSnapshot);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="preview-font-trigger" aria-label="Preview font" data-testid="preview-font-select">
          Aa
          <ChevronDown size={13} aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent className="w-72 max-w-[calc(100vw-16px)] p-1.5" data-testid="preview-font-menu">
        <MenuLabel>Preview font</MenuLabel>
        <MenuRadioGroup value={font} onValueChange={(value) => isPreviewFont(value) && setPreviewFont(value)}>
          {PREVIEW_FONTS.map((f) => (
            <MenuRadioItem key={f.id} value={f.id} description={f.description} data-testid={`preview-font-${f.id}`}>
              <span className="font-semibold" style={{ fontFamily: f.family }}>
                {f.kind} · {f.label}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
