import { auth } from "../auth";

export async function hasAccess(): Promise<boolean> {
  if (process.env.NODE_ENV !== "production" && process.env.AUTH_BYPASS_LOCAL === "true") return true;
  const session = await auth();
  return session?.githubLogin?.toLowerCase() === (process.env.ALLOWED_GITHUB_LOGIN ?? "Kaedeeeeeeeeee").toLowerCase();
}
