import { redirect } from "next/navigation";
import { GitHubIcon } from "@/components/ui/primitives";
import { signIn, auth, devLoginEnabled, githubConfigured } from "@/auth";
import { Logo } from "@/components/editor/header";
import { loginReturnPath } from "./return-path";
import { embeddedDocumentPath } from "@/server/http";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const session = await auth();
  const params = await searchParams;
  const next = loginReturnPath(params.next);
  const embedPath = await embeddedDocumentPath(session?.user?.id);
  if (embedPath) redirect(embedPath);
  if (session?.user) redirect(next);
  const error = typeof params.error === "string" ? params.error : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-2 px-4 py-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-xl shadow-black/5 sm:p-8" data-testid="login-card">
        <div className="mb-6 flex items-center gap-3">
          <Logo className="h-9 w-9" />
          <div>
            <h1 className="text-xl font-semibold text-ink">Markdoc</h1>
            <p className="text-sm text-ink-3">Collaborative Markdown editing.</p>
          </div>
        </div>
        {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40">Sign in failed ({error}). Please try again.</div>}
        {githubConfigured ? (
          <form
            action={async () => {
              "use server";
              await signIn("github", { redirectTo: next });
            }}
          >
            <button type="submit" className="btn btn-primary h-11 w-full gap-2 text-base" data-testid="github-signin">
              <GitHubIcon size={18} /> Continue with GitHub
            </button>
          </form>
        ) : (
          <div className="rounded-lg border border-dashed border-line-2 px-3 py-3 text-sm text-ink-3" data-testid="github-not-configured">
            GitHub sign-in is not configured. Set <code className="font-mono text-xs">AUTH_GITHUB_ID</code> and <code className="font-mono text-xs">AUTH_GITHUB_SECRET</code>.
          </div>
        )}
        {devLoginEnabled && (
          <form
            className="mt-6 border-t border-line pt-6"
            action={async (formData) => {
              "use server";
              const login = String(formData.get("login") ?? "");
              await signIn("dev", { login, redirectTo: next });
            }}
          >
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Development login</div>
            <div className="flex flex-col gap-2 sm:flex-row" data-testid="dev-login-controls">
              <input name="login" className="input min-w-0 flex-1" placeholder="GitHub handle" defaultValue="" autoComplete="off" data-testid="dev-login" />
              <button type="submit" className="btn btn-outline w-full shrink-0 whitespace-nowrap sm:w-auto" data-testid="dev-login-submit">
                Sign in
              </button>
            </div>
            <p className="mt-2 text-xs text-ink-4">Only available when AUTH_DEV_LOGIN=1 outside production.</p>
          </form>
        )}
        <p className="mt-6 text-center text-xs text-ink-4">Markdoc asks for access to your gists and repositories so it can publish documents on your behalf.</p>
      </div>
    </main>
  );
}
