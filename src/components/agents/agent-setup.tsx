"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ExternalLink, KeyRound, Loader2, TriangleAlert } from "lucide-react";
import { api, ApiError, apiErrorText, type ApiTokenDto } from "@/lib/api";
import { DEFAULT_KEY_NAME, mcpSetup } from "@/lib/agent-clients";
import { hasConnected, lastSeenAt, uniqueKeyName } from "@/lib/agent-keys";
import { AGENT_DOCS_URL, SCOPES, TOKEN_SCOPE_LABEL, TOKEN_SCOPE_SUMMARY, type TokenScopeName } from "@/lib/mcp";
import { cn } from "@/lib/utils";
import { ConnectedBanner, InviteBlock, InviteBody, inviteTitle, type DocRef } from "./agent-parts";
import { CopyBlock } from "./copy-block";

const POLL_MS = 3_000;
const POLL_LIMIT_MS = 10 * 60_000;

const EXPIRY_CHOICES = [
  { value: "30", label: "30 days", phrase: "expires in 30 days" },
  { value: "90", label: "90 days", phrase: "expires in 90 days" },
  { value: "365", label: "1 year", phrase: "expires in a year" },
  { value: "never", label: "Never", phrase: "never expires" },
] as const;
type ExpiryValue = (typeof EXPIRY_CHOICES)[number]["value"];

interface CreatedKey {
  id: string;
  /** The secret. Held in this component's state only: never stored, never in a URL, gone when it unmounts. */
  key: string;
  name: string;
  scope: TokenScopeName;
}

export interface AgentSetupProps {
  origin: string;
  tokens: ApiTokenDto[] | null;
  /** Heading level for setup content; defaults to 3 inside the agent dialog. */
  headingLevel?: 3 | 4;
  /** Re-reads the key list. Also called on a timer while waiting for the agent to connect. */
  reload: () => Promise<void>;
  /** The document the agent will join. Without one (Settings) the last step is a general check-in. */
  doc?: DocRef;
  /** Called once a key exists, so a host can keep this flow on screen while the key list refreshes. */
  onKeyCreated?: () => void;
}

function Step({ n, title, state, children, headingLevel }: { n: number; title: string; state: "idle" | "active" | "done"; children: ReactNode; headingLevel: 3 | 4 }) {
  const id = useId();
  const Heading = headingLevel === 3 ? "h3" : "h4";
  return (
    <section className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3" aria-labelledby={id}>
      <span
        aria-hidden="true"
        className={cn(
          "mt-px flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
          state === "active" && "bg-accent text-on-accent",
          state === "done" && "bg-accent-soft text-accent",
          state === "idle" && "bg-surface-3 text-ink-2",
        )}
      >
        {state === "done" ? <Check size={13} strokeWidth={3} /> : n}
      </span>
      <div className="min-w-0">
        <Heading id={id} className="text-sm font-semibold leading-6 text-ink">
          {title}
        </Heading>
        <div className="mt-1.5 flex flex-col gap-2.5">{children}</div>
      </div>
    </section>
  );
}

export function AgentSetup({ origin, tokens, reload, doc, onKeyCreated, headingLevel = 3 }: AgentSetupProps) {
  const uid = useId();
  const optionsId = `${uid}-options`;
  const [scope, setScope] = useState<TokenScopeName>("comment");
  const [onlyThisDoc, setOnlyThisDoc] = useState(Boolean(doc));
  const [expires, setExpires] = useState<ExpiryValue>("90");
  const [typedName, setTypedName] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [previousTokens, setPreviousTokens] = useState(tokens);
  const copyButton = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);

  const keyName = typedName ?? uniqueKeyName(DEFAULT_KEY_NAME, tokens);
  const expiry = EXPIRY_CHOICES.find((choice) => choice.value === expires) ?? EXPIRY_CHOICES[1];
  const summary = `${TOKEN_SCOPE_LABEL[scope]} · ${onlyThisDoc && doc ? "this document only" : "all your documents"} · ${expiry.phrase}`;
  const row = created ? tokens?.find((key) => key.id === created.id) : undefined;
  const connected = Boolean(row && hasConnected(row));
  const setup = mcpSetup({ origin, key: created?.key });

  // Wait for a refreshed list: the creation response arrives before reload adds the new key.
  if (tokens !== previousTokens) {
    setPreviousTokens(tokens);
    if (created && tokens !== null && !row) setCreated(null);
  }

  // Watch for the agent's first request so the result of pasting the command shows up right here.
  useEffect(() => {
    if (!created || connected) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > POLL_LIMIT_MS) clearInterval(timer);
      else void reload();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [created, connected, reload]);

  useEffect(() => {
    if (created) copyButton.current?.focus();
  }, [created]);

  const create = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await api.tokens.create(keyName.trim(), expires === "never" ? null : Number(expires), {
        scope,
        documentIds: onlyThisDoc && doc ? [doc.id] : null,
      });
      setCreated({ id: res.token.id, key: res.token.token, name: res.token.name, scope: res.token.scope });
      onKeyCreated?.();
      void reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // The name is taken: say so in this screen's words, show the field, and keep whatever was typed.
        setError("Another key already has that name. Choose a different one.");
        setOptionsOpen(true);
        void reload();
      } else {
        setError(apiErrorText(e, "Could not create the key."));
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  // The agent has used the key: the command has done its job, so it (and the secret) leave the screen.
  if (created && connected && row) {
    return (
      <div className="flex flex-col gap-5" data-testid="agent-setup" data-state="connected">
        <ConnectedBanner names={[row.name]} lastSeen={lastSeenAt(row)} />
        <InviteBlock doc={doc} headingLevel={headingLevel} />
        <div className="border-t border-line pt-4">
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => {
              setCreated(null);
              setError(null);
            }}
            data-testid="agent-connect-another"
          >
            Connect another agent
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5" data-testid="agent-setup" data-state={created ? "waiting" : "new"}>
      <Step n={1} title="Add Markdoc to your agent" state="active" headingLevel={headingLevel}>
        {created ? (
          <>
            <p className="text-sm text-ink-2">Paste this into your agent&apos;s MCP config. It is the same for every MCP client.</p>
            <CopyBlock value={setup.config} label="Copy MCP config" primary testId="agent-setup-snippet" copyTestId="agent-setup-copy" buttonRef={copyButton} />
            <details className="text-sm">
              <summary className="w-fit cursor-pointer select-none py-1 text-xs font-medium text-ink-2 hover:text-ink">Adding it through a form instead?</summary>
              <div className="mt-2 flex flex-col gap-2" data-testid="agent-setup-fields">
                <p className="text-xs text-ink-3">Add a remote (HTTP) server with this URL and an Authorization header.</p>
                <CopyBlock value={setup.url} label="Copy server URL" testId="agent-setup-url" />
                <CopyBlock value={setup.authorization} label="Copy Authorization header" testId="agent-setup-header" />
              </div>
            </details>
            <p className="flex items-start gap-1.5 text-xs text-ink-2">
              <TriangleAlert size={14} className="mt-px shrink-0 text-warning" aria-hidden="true" />
              This contains your key. It is shown only once, so copy it before you close this.
            </p>
            <p role="status" data-testid="agent-connection" data-state="waiting" className="flex items-center gap-2 text-xs text-ink-3">
              <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden="true" />
              Waiting for your agent to connect. Start a new session after you add it.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-ink-2">Create a key for your agent. Markdoc then shows the MCP config to paste.</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <button type="button" className="btn btn-primary gap-2" onClick={() => void create()} disabled={busy || !keyName.trim()} data-testid="agent-create-key">
                {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}
                Create access key
              </button>
              <span className="text-xs text-ink-3" data-testid="agent-key-summary">
                {summary}
              </span>
              <button
                type="button"
                className="inline-flex min-h-6 items-center text-xs font-medium text-accent hover:underline"
                aria-expanded={optionsOpen}
                aria-controls={optionsId}
                onClick={() => setOptionsOpen((open) => !open)}
                data-testid="agent-options-toggle"
              >
                {optionsOpen ? "Hide options" : "Change"}
              </button>
            </div>
            {optionsOpen && (
              <div id={optionsId} className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-3" data-testid="agent-options">
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="mb-1 text-xs font-semibold text-ink-2">What can it do?</legend>
                  {SCOPES.map((value) => (
                    <label key={value} className="flex min-h-6 cursor-pointer items-start gap-2 text-sm">
                      <input
                        type="radio"
                        name={`${uid}-scope`}
                        checked={scope === value}
                        onChange={() => setScope(value)}
                        className="mt-1 accent-accent"
                        data-testid={`agent-scope-${value}`}
                      />
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium text-ink">{TOKEN_SCOPE_LABEL[value]}</span>
                        <span className="text-xs text-ink-3">{TOKEN_SCOPE_SUMMARY[value]}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                {doc && (
                  <label className="flex min-h-6 cursor-pointer items-start gap-2 text-sm">
                    <input type="checkbox" checked={onlyThisDoc} onChange={(e) => setOnlyThisDoc(e.target.checked)} className="mt-1 accent-accent" data-testid="agent-only-doc" />
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium text-ink">Only this document</span>
                      <span className="text-xs text-ink-3">Other documents stay off limits.</span>
                    </span>
                  </label>
                )}
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                  <label className="flex flex-col gap-1 text-xs font-semibold text-ink-2">
                    Name
                    <input className="input font-normal" value={keyName} onChange={(e) => setTypedName(e.target.value)} maxLength={80} data-testid="agent-key-name" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-semibold text-ink-2">
                    Expires
                    <select className="select font-normal" value={expires} onChange={(e) => setExpires(e.target.value as ExpiryValue)} data-testid="agent-expires">
                      {EXPIRY_CHOICES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            )}
            {error && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger wrap-anywhere dark:bg-red-950/40" role="alert" data-testid="agent-error">
                {error}
              </div>
            )}
          </>
        )}
      </Step>

      <Step n={2} title={inviteTitle(doc)} state="idle" headingLevel={headingLevel}>
        {created ? <InviteBody doc={doc} primary={false} /> : <p className="text-xs text-ink-3">Once your agent is connected, you get a sentence to paste into it.</p>}
      </Step>

      <a
        className="inline-flex min-h-6 items-center gap-1 self-start text-xs font-medium text-accent hover:underline"
        href={AGENT_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        data-testid="agent-docs-link"
      >
        Agent docs <ExternalLink size={13} aria-hidden="true" />
      </a>
    </div>
  );
}
