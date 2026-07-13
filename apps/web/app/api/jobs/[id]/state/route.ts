import { NextRequest, NextResponse } from "next/server";
import { hasAccess } from "../../../../../lib/access";
import { internalApiFetch } from "../../../../../lib/internal-api";

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!await hasAccess()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const response = await internalApiFetch(`/agent/jobs/${encodeURIComponent(id)}/state`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: await request.text(), cache: "no-store",
  });
  return new NextResponse(await response.text(), { status: response.status, headers: { "content-type": "application/json" } });
}
