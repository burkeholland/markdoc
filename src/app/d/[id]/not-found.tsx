import type { Metadata } from "next";
import { NoAccess } from "@/components/access/no-access";

// Signed-in visitors reach this through notFound() in ./page.tsx (signed-out ones are sent to /login).
export const metadata: Metadata = {
  title: "No access",
  openGraph: { images: [] },
  twitter: { images: [] },
};

export default function DocumentNotFound() {
  return <NoAccess />;
}
