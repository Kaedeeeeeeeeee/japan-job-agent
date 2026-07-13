import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

const allowedLogin = process.env.ALLOWED_GITHUB_LOGIN ?? "Kaedeeeeeeeeee";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  callbacks: {
    jwt({ token, profile }) {
      if (typeof profile?.login === "string") token.githubLogin = profile.login;
      return token;
    },
    session({ session, token }) {
      if (typeof token.githubLogin === "string") session.githubLogin = token.githubLogin;
      return session;
    },
    signIn({ profile }) {
      return typeof profile?.login === "string" && profile.login.toLowerCase() === allowedLogin.toLowerCase();
    },
  },
  pages: { signIn: "/signin", error: "/signin" },
});

declare module "next-auth" {
  interface Session { githubLogin?: string }
}
