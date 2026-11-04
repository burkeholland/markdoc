const LABEL_SELECTOR = ".md-remote-caret-label, .cm-ySelectionInfo";
const CLIPPING_OVERFLOW = new Set(["auto", "clip", "hidden", "scroll"]);

function clippingAncestor(label: HTMLElement, root: HTMLElement): HTMLElement {
  for (let ancestor = label.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const overflowX = label.ownerDocument.defaultView?.getComputedStyle(ancestor).overflowX;
    if (overflowX && CLIPPING_OVERFLOW.has(overflowX)) return ancestor;
  }
  return root;
}

export function fitRemoteCaretLabels(root: HTMLElement): void {
  for (const label of root.querySelectorAll<HTMLElement>(LABEL_SELECTOR)) {
    label.style.removeProperty("--md-remote-caret-label-shift-x");
    if (label.dataset.mdCaretLabelConstrained !== undefined) {
      label.style.removeProperty("max-width");
      label.style.removeProperty("white-space");
      label.style.removeProperty("overflow-wrap");
      delete label.dataset.mdCaretLabelConstrained;
    }

    const pane = clippingAncestor(label, root);
    const paneRect = pane.getBoundingClientRect();
    const left = paneRect.left + pane.clientLeft;
    const right = left + pane.clientWidth;
    const availableWidth = right - left - 4;
    const naturalRect = label.getBoundingClientRect();
    if (availableWidth <= 0 || naturalRect.width <= 0) continue;

    if (naturalRect.width > availableWidth) {
      label.style.maxWidth = `${availableWidth}px`;
      label.style.whiteSpace = "normal";
      label.style.overflowWrap = "anywhere";
      label.dataset.mdCaretLabelConstrained = "";
    }

    const rect = label.getBoundingClientRect();
    const minLeft = left + 2;
    const maxLeft = right - 2 - rect.width;
    const targetLeft = Math.max(minLeft, Math.min(rect.left, maxLeft));
    const shift = targetLeft - rect.left;
    if (Math.abs(shift) >= 0.5) {
      label.style.setProperty("--md-remote-caret-label-shift-x", `${shift}px`);
    }
  }
}

export function watchRemoteCaretLabels(root: HTMLElement): () => void {
  const document = root.ownerDocument;
  let resizeObserver: ResizeObserver | null = null;
  const observedLabels = new Set<HTMLElement>();
  const fit = () => {
    fitRemoteCaretLabels(root);
    if (!resizeObserver) return;
    const labels = new Set(root.querySelectorAll<HTMLElement>(LABEL_SELECTOR));
    for (const label of observedLabels) {
      if (!labels.has(label)) {
        resizeObserver.unobserve(label);
        observedLabels.delete(label);
      }
    }
    for (const label of labels) {
      if (!observedLabels.has(label)) {
        resizeObserver.observe(label);
        observedLabels.add(label);
      }
    }
  };
  if (typeof ResizeObserver !== "undefined") resizeObserver = new ResizeObserver(fit);
  resizeObserver?.observe(root);
  document.addEventListener("scroll", fit, true);
  document.defaultView?.addEventListener("resize", fit);
  fit();

  return () => {
    resizeObserver?.disconnect();
    document.removeEventListener("scroll", fit, true);
    document.defaultView?.removeEventListener("resize", fit);
  };
}
