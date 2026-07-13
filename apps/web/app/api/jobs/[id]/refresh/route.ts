import { NextResponse } from "next/server";
import { hasAccess } from "../../../../../lib/access";
import { internalApiFetch } from "../../../../../lib/internal-api";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await hasAccess()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const response = await internalApiFetch(`/agent/jobs/${encodeURIComponent(id)}/refresh`, {
    method: "POST",
    cache: "no-store",
  });
  return new NextResponse(await response.text(), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}
