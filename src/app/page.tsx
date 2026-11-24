import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { auth, githubConfigured } from "@/auth";
import { Landing } from "@/components/landing/landing";
import { Dashboard } from "@/components/dashboard/dashboard";
import { getGitHubToken, listDocumentsForUser } from "@/server/documents";
import { DEFAULT_DASHBOARD_SORT, SORT_COOKIE, isDashboardSort } from "@/lib/dashboard-sort";
import { embeddedDocumentPath } from "@/server/http";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await auth();
  const embedPath = await embeddedDocumentPath(session?.user?.id);
  if (embedPath) redirect(embedPath);
  if (session?.user?.id) {
    const user = { id: session.user.id, login: session.user.login ?? null, name: session.user.name ?? null, image: session.user.image ?? null };
    const [docs, token, cookieStore] = await Promise.all([listDocumentsForUser(user), getGitHubToken(user.id), cookies()]);
    // The saved sort travels in a cookie so the server renders the cards in that order (#165).
    const savedSort = cookieStore.get(SORT_COOKIE)?.value;
    return (
      <Dashboard
        user={{ id: user.id, name: user.name ?? user.login ?? "You", login: user.login, image: user.image }}
        documents={docs.map((d) => ({ ...d, updatedAt: d.updatedAt.toISOString(), createdAt: d.createdAt.toISOString(), lastOpenedAt: d.lastOpenedAt?.toISOString() ?? null, deletedAt: null }))}
        githubAvailable={!!token}
        githubConfigured={githubConfigured}
        initialSort={isDashboardSort(savedSort) ? savedSort : DEFAULT_DASHBOARD_SORT}
      />
    );
  }
  return <Landing />;
}
