import { NextRequest, NextResponse } from "next/server";
import { hasAccess } from "../../../lib/access";
import { internalApiFetch } from "../../../lib/internal-api";

export async function GET(request: NextRequest) {
  if (!await hasAccess()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const view = request.nextUrl.searchParams.get("view") ?? "recommendations";
  const response = await internalApiFetch(`/agent/jobs?view=${encodeURIComponent(view)}`, { cache: "no-store" });
  return new NextResponse(await response.text(), { status: response.status, headers: { "content-type": "application/json" } });
}
