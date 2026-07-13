import { ArrowRight, LockKeyhole } from "lucide-react";
import { signIn } from "../../auth";

export default function SignInPage() {
  return <main className="signin-shell">
    <section className="signin-panel">
      <div className="brand-mark" aria-hidden="true">日</div>
      <p className="eyebrow">PRIVATE WORKSPACE</p>
      <h1>Japan Job Agent</h1>
      <p>検証済みの公式求人を、あなたのプロフィールと原文エビデンスで整理します。</p>
      <form action={async () => { "use server"; await signIn("github", { redirectTo: "/" }); }}>
        <button className="apply-button" type="submit">GitHub でログイン <ArrowRight size={18} /></button>
      </form>
      <p className="privacy-note"><LockKeyhole size={15} /> 許可された単一アカウントのみアクセスできます</p>
    </section>
  </main>;
}
