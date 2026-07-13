import "server-only";

export function internalApiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = process.env.API_INTERNAL_TOKEN;
  if (process.env.NODE_ENV === "production" && (token === undefined || token.length < 32)) {
    throw new Error("API_INTERNAL_TOKEN must contain at least 32 characters in production");
  }
  const headers = new Headers(init.headers);
  if (token !== undefined && token !== "") headers.set("authorization", `Bearer ${token}`);
  return fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
}

function apiBaseUrl(): string {
  return (process.env.API_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
}
