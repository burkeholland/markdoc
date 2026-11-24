import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/ui/logo";
import { GitHubIcon } from "@/components/ui/github-icon";
import { SignInLinkContent } from "@/components/ui/sign-in-link-content";
import styles from "./landing.module.css";

function SignIn({ children, large = false }: { children?: ReactNode; large?: boolean }) {
  return (
    <Link href="/login" className={`btn btn-primary ${styles.signIn} ${large ? styles.large : ""}`}>
      <SignInLinkContent>
        {children ?? <><GitHubIcon size={16} /><span className="sm:hidden">Sign in</span><span className="hidden sm:inline">Sign in with GitHub</span></>}
      </SignInLinkContent>
    </Link>
  );
}

function Avatar({ person }: { person: "burke" | "priya" | "sam" }) {
  return <span className={`${styles.avatar} ${styles[person]}`}>{ { burke: "BH", priya: "PR", sam: "SK" }[person]}</span>;
}

function Comment() {
  return (
    <div className={styles.comment}>
      <div className={styles.who}><Avatar person="sam" />Sam <span>2m</span></div>
      What happens if two people edit the same line offline?
      <div className={styles.reply}>
        <div className={styles.who}><Avatar person="priya" />Priya <span>now</span></div>
        Both edits are kept. Writing it up now.
      </div>
    </div>
  );
}

function Caret({ person, children }: { person: "burke" | "priya"; children: ReactNode }) {
  return <span className={`${styles.caret} ${styles[person]}`}><i>{children}</i></span>;
}

const sourceLines: ReactNode[] = [
  <><span className={styles.punctuation}># </span><strong>Offline mode launch</strong></>,
  "",
  <>Ship offline editing to everyone by <strong>**March 14**</strong>.</>,
  "Edits save on your device and merge when",
  <>you&apos;re back online.<Caret person="burke">Burke</Caret></>,
  "",
  <><span className={styles.punctuation}>## </span><strong>What changes</strong></>,
  "",
  "- Edits save locally when you lose signal",
  <>- <span className={styles.selection}>Changes merge when you reconnect</span><Caret person="priya">Priya</Caret></>,
  <>- No more <span className={styles.code}>`Reconnecting...`</span> banner</>,
  "",
  <><span className={styles.punctuation}>## </span><strong>Owners</strong></>,
  "",
  "| Item           | Owner | Status    |",
  "|----------------|-------|-----------|",
  "| Sync conflicts | Priya | In review |",
  "| Help page      | Sam   | Draft     |",
  "",
  <span key="quote" className={styles.punctuation}>&gt; Keep the banner copy short.</span>,
];

function EditorPreview() {
  return (
    <div className={styles.editor} aria-hidden="true">
      <div className={styles.editorBar}>
        <span className={styles.crumb}>Library /</span>
        <span className={styles.editorTitle}>Offline mode launch</span>
        <span className={styles.saved}>Saved</span>
        <span className={styles.spacer} />
        <div className={styles.segment}><span>Source</span><b>Split</b><span>Preview</span></div>
        <div className={styles.avatars}><Avatar person="burke" /><Avatar person="priya" /><Avatar person="sam" /></div>
        <span className={`${styles.mockButton} ${styles.suggesting}`}>Suggesting</span>
        <span className={`${styles.mockButton} ${styles.primary}`}>Share</span>
      </div>
      <div className={styles.editorBody}>
        <div className={styles.source}>
          {sourceLines.map((line, index) => <div key={index}><span className={styles.lineNumber}>{index + 1}</span>{line || "\u00a0"}</div>)}
        </div>
        <div className={styles.preview}>
          <div className={styles.document}>
            <div className={styles.documentTitle}>Offline mode launch</div>
            <p>Ship offline editing to everyone by <strong>March 14</strong>. Edits save on your device and merge when you&apos;re back online.</p>
            <div className={styles.documentHeading}>What changes</div>
            <ul>
              <li>Edits save locally when you lose signal</li>
              <li><mark>Changes merge when you reconnect</mark></li>
              <li>No more <del>&quot;Reconnecting...&quot;</del> <ins>&quot;Offline&quot;</ins> banner</li>
            </ul>
            <div className={styles.documentHeading}>Owners</div>
            <table><thead><tr><th>Item</th><th>Owner</th><th>Status</th></tr></thead><tbody><tr><td>Sync conflicts</td><td>Priya</td><td>In review</td></tr><tr><td>Help page</td><td>Sam</td><td>Draft</td></tr></tbody></table>
          </div>
          <div className={styles.gutter}>
            <Comment />
            <div className={styles.comment}>
              <div className={styles.who}><Avatar person="sam" />Sam suggested</div>
              Replace &quot;Reconnecting...&quot; with &quot;Offline&quot;
              <div className={styles.suggestionActions}><span className={styles.primary}>Accept</span><span>Reject</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <div className={styles.landing}>
      <header className={`app-header ${styles.header} ${styles.wrap}`}>
        <Wordmark />
        <span className={styles.spacer} />
        <SignIn />
      </header>
      <main>
        <section className={`${styles.hero} ${styles.wrap}`} aria-labelledby="landing-title">
          <h1 id="landing-title">Markdown,<br />together.</h1>
          <div>
            <p className={styles.lede}>Write, preview, edit, comment – all in realtime with your team or agent</p>
            <div className={styles.cta}><SignIn large>Start writing</SignIn><span className={styles.note}>Free while in preview. Uses your GitHub account.</span></div>
          </div>
        </section>
        <section className={`${styles.wrap} ${styles.shot}`} aria-label="Markdoc split editor with live collaborators, comments and suggestions">
          <EditorPreview />
        </section>
      </main>
      <footer className={`${styles.footer} ${styles.wrap}`}><span>Markdoc</span><span className={styles.spacer} /><a href="https://github.com/burkeholland/markdoc">GitHub</a></footer>
    </div>
  );
}
