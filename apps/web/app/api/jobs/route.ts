import { NextRequest, NextResponse } from "next/server";
import { hasAccess } from "../../../lib/access";

export async function GET(request: NextRequest) {
  if (!await hasAccess()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const view = request.nextUrl.searchParams.get("view") ?? "recommendations";
  const response = await fetch(`${apiBaseUrl()}/agent/jobs?view=${encodeURIComponent(view)}`, { cache: "no-store" });
  return new NextResponse(await response.text(), { status: response.status, headers: { "content-type": "application/json" } });
}

function apiBaseUrl(): string {
  return (process.env.API_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
}
