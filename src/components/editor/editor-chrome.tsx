import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  CODE_COLUMN_BOX,
  CODE_COLUMN_SPLIT,
  HEADER_BOX,
  MAIN_BOX,
  PANE_LABEL_ROW_BOX,
  PANES_BOX,
  RAIL_BOX,
  RAIL_COLLAPSED_BOX,
  RICH_COLUMN_BOX,
  RICH_COLUMN_SPLIT,
  RICH_SCROLLER_BOX,
  SHELL_BOX,
  STATUS_BOX,
  TOOLBAR_BOX,
} from "./chrome-classes";

/**
 * The editor shell's empty chrome, at the shell's exact outer boxes (`chrome-classes.ts`), phone-correct by
 * itself so nothing moves when the shell takes over: the outline rail is absent below `md` (the shell's
 * phone drawer), the 40 px collapsed strip from `md` to `lg` (the shell closes the rail below `TABLET_MAX`)
 * and the open 224 px rail from `lg`; the code column is hidden below `md` like the shell's `split` layout.
 * Nothing in here is focusable.
 *
 * Two places paint it: the document page until the shell's chunks have loaded (`editor-client.tsx`, with
 * the landmarks the shell has and the preview as `children`), and the dashboard from the click on a
 * document until that page arrives (`opening-document.tsx`, `decorative`: plain boxes, since the
 * dashboard's own landmarks are still in the page).
 */
export function EditorChrome({ decorative = false, children, ...rest }: { decorative?: boolean; children?: ReactNode; "data-testid"?: string; "aria-busy"?: boolean; "aria-hidden"?: boolean }) {
  const Header = decorative ? "div" : "header";
  const Main = decorative ? "div" : "main";
  const Footer = decorative ? "div" : "footer";
  return (
    <div className={SHELL_BOX} {...rest}>
      <Header className={HEADER_BOX} />
      <div className={TOOLBAR_BOX} />
      <Main id={decorative ? undefined : "editor-main"} className={MAIN_BOX}>
        <div className={cn(RAIL_COLLAPSED_BOX, "max-md:hidden lg:hidden")} />
        <div className={cn(RAIL_BOX, "max-lg:hidden")} />
        <div className={PANES_BOX}>
          <div className={cn(CODE_COLUMN_BOX, CODE_COLUMN_SPLIT, "max-md:hidden")} />
          <div className={cn(RICH_COLUMN_BOX, RICH_COLUMN_SPLIT)}>
            <div className={PANE_LABEL_ROW_BOX}>
              <span className="pane-label">Preview</span>
            </div>
            <div className={RICH_SCROLLER_BOX}>{children}</div>
          </div>
        </div>
      </Main>
      <Footer className={STATUS_BOX} />
    </div>
  );
}
