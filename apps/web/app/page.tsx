import { redirect } from "next/navigation";
import { Dashboard } from "./ui/dashboard";
import { hasAccess } from "../lib/access";
import type { JobsResponse } from "./types";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (!await hasAccess()) redirect("/signin");
  const view = (await searchParams).view ?? "recommendations";
  let data: JobsResponse = { profileConfigured: false, jobs: [] };
  let unavailable: string | null = null;
  let management: unknown = null;
  try {
    const response = await fetch(`${apiBaseUrl()}/agent/jobs?view=${encodeURIComponent(view)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`API ${response.status}`);
    data = await response.json() as JobsResponse;
    const path = view === "profile" ? "/agent/profile" : view === "sources" ? "/admin/sources"
      : view === "review" ? "/admin/review-tasks" : null;
    if (path !== null) {
      const managementResponse = await fetch(`${apiBaseUrl()}${path}`, { cache: "no-store" });
      if (!managementResponse.ok) throw new Error(`Management API ${managementResponse.status}`);
      management = await managementResponse.json() as unknown;
    }
  } catch (error) {
    unavailable = error instanceof Error ? error.message : "API unavailable";
  }
  return <Dashboard initialData={data} view={view} unavailable={unavailable} management={management} />;
}

function apiBaseUrl(): string {
  return (process.env.API_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
}
