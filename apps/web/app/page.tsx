import { redirect } from "next/navigation";
import { Dashboard } from "./ui/dashboard";
import { hasAccess } from "../lib/access";
import type { JobsResponse } from "./types";
import { internalApiFetch } from "../lib/internal-api";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: {
  searchParams: Promise<{ view?: string; occupation?: string | string[] }>;
}) {
  if (!await hasAccess()) redirect("/signin");
  const params = await searchParams;
  const view = params.view ?? "recommendations";
  const occupationParam = Array.isArray(params.occupation) ? params.occupation.join(",") : params.occupation ?? "";
  const initialOccupationFamilies = [...new Set(occupationParam.split(",").map((value) => value.trim()).filter(Boolean))];
  let data: JobsResponse = { profileConfigured: false, jobs: [] };
  let unavailable: string | null = null;
  let management: unknown = null;
  try {
    if (view === "discovery") {
      const [summaryResponse, candidatesResponse] = await Promise.all([
        internalApiFetch("/admin/discovery/jobs/summary", { cache: "no-store" }),
        internalApiFetch("/admin/discovery/jobs?limit=100", { cache: "no-store" }),
      ]);
      if (!summaryResponse.ok || !candidatesResponse.ok) {
        throw new Error(`Discovery API ${summaryResponse.status}/${candidatesResponse.status}`);
      }
      management = {
        summary: await summaryResponse.json() as unknown,
        candidates: (await candidatesResponse.json() as { candidates?: unknown }).candidates ?? [],
      };
    } else {
      const path = view === "profile" ? "/agent/profile" : view === "sources" ? "/admin/sources"
        : view === "review" ? "/admin/review-tasks" : null;
      if (path === null) {
        const response = await internalApiFetch(`/agent/jobs?view=${encodeURIComponent(view)}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`API ${response.status}`);
        data = await response.json() as JobsResponse;
      } else {
      const managementResponse = await internalApiFetch(path, { cache: "no-store" });
      if (!managementResponse.ok) throw new Error(`Management API ${managementResponse.status}`);
      management = await managementResponse.json() as unknown;
      }
    }
  } catch (error) {
    unavailable = error instanceof Error ? error.message : "API unavailable";
  }
  return <Dashboard key={view} initialData={data} view={view} unavailable={unavailable} management={management}
    initialOccupationFamilies={initialOccupationFamilies} />;
}
