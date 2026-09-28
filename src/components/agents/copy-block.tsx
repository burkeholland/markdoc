"use client";

import { useRef, type Ref } from "react";
import { Check, Copy } from "lucide-react";
import { useCopy } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export interface CopyBlockProps {
  value: string;
  /** Accessible name of the Copy button, e.g. "Copy setup command". */
  label: string;
  /** The block is the screen's main action: a filled Copy button instead of an outlined one. */
  primary?: boolean;
  /** A sentence to paste, not code: proportional type that wraps between words. */
  prose?: boolean;
  testId?: string;
  copyTestId?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}

/** Text to copy with a Copy button in the corner. When both copy paths fail the text is selected for Ctrl+C. */
export function CopyBlock({ value, label, primary = false, prose = false, testId, copyTestId, buttonRef }: CopyBlockProps) {
  const pre = useRef<HTMLPreElement>(null);
  const { copy, label: buttonText, copied } = useCopy(value, pre);
  return (
    <div className="relative">
      <pre
        ref={pre}
        data-testid={testId}
        className={cn(
          "select-text whitespace-pre-wrap wrap-anywhere rounded-lg border border-line bg-surface-2 py-3 pl-3 pr-24 leading-5",
          prose ? "font-sans text-[13px] text-ink" : "font-mono text-xs text-ink-2",
        )}
      >
        {value}
      </pre>
      <button
        ref={buttonRef}
        type="button"
        onClick={copy}
        aria-label={label}
        data-testid={copyTestId}
        className={cn("btn btn-sm absolute right-2 top-2 gap-1.5", primary ? "btn-primary" : "btn-outline")}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        {buttonText}
      </button>
    </div>
  );
}
