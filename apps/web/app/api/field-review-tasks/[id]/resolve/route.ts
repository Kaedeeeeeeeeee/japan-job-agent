import { NextResponse } from "next/server";
import { hasAccess } from "../../../../../lib/access";
import { internalApiFetch } from "../../../../../lib/internal-api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!await hasAccess()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const response = await internalApiFetch(`/admin/field-review-tasks/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  });
  return new NextResponse(await response.text(), { status: response.status, headers: { "content-type": "application/json" } });
}
