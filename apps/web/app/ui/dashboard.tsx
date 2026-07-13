"use client";

import {
  AlertCircle, ArrowUpRight, Bookmark, BriefcaseBusiness, CheckCircle2, ChevronRight,
  CircleUserRound, Database, EyeOff, FileSearch, HeartPulse, ListFilter, MapPin, RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import type { EvidenceView, JobsResponse, JobView } from "../types";

const navigation = [
  { key: "recommendations", label: "おすすめ", icon: FileSearch, href: "/" },
  { key: "saved", label: "保存済み", icon: Bookmark, href: "/?view=saved" },
  { key: "applied", label: "応募管理", icon: BriefcaseBusiness, href: "/?view=applied" },
];

export function Dashboard({ initialData, view, unavailable, management }: { initialData: JobsResponse; view: string; unavailable: string | null; management: unknown }) {
  const [jobs, setJobs] = useState(initialData.jobs);
  const [selectedId, setSelectedId] = useState(initialData.jobs[0]?.canonicalJobId ?? null);
  const [refreshMessages, setRefreshMessages] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const selected = jobs.find((job) => job.canonicalJobId === selectedId) ?? jobs[0] ?? null;
  const title = view === "saved" ? "保存済みの求人" : view === "applied" ? "応募管理" : "今日のおすすめ";
  const evidenceMap = useMemo(() => new Map(selected?.evidence.map((value) => [value.id, value]) ?? []), [selected]);

  function updateState(job: JobView, patch: { saved?: boolean; hidden?: boolean; applied?: boolean }) {
    startTransition(async () => {
      const response = await fetch(`/api/jobs/${job.canonicalJobId}/state`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
      });
      if (!response.ok) return;
      const next = await response.json() as JobView["state"] & { refresh: JobView["refresh"] };
      setJobs((current) => current.map((item) => item.canonicalJobId === job.canonicalJobId
        ? { ...item, state: { saved: next.saved, hidden: next.hidden, appliedAt: next.appliedAt }, refresh: next.refresh }
        : item)
        .filter((item) => view !== "recommendations" || !item.state.hidden));
    });
  }

  function requestRefresh(job: JobView) {
    startTransition(async () => {
      setRefreshMessages((current) => ({ ...current, [job.canonicalJobId]: "更新を開始しています…" }));
      const response = await fetch(`/api/jobs/${job.canonicalJobId}/refresh`, { method: "POST" });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { error?: string; message?: string; reason?: string };
        setRefreshMessages((current) => ({
          ...current,
          [job.canonicalJobId]: refreshErrorLabel(error.reason ?? error.error ?? error.message),
        }));
        return;
      }
      const result = await response.json() as { deduplicated?: boolean; request?: { status?: string } };
      const duplicateMessage = result.request?.status === "succeeded"
        ? "同じ時間帯に公式情報を確認済みです。"
        : "同じソースの更新が進行中です。";
      setRefreshMessages((current) => ({
        ...current,
        [job.canonicalJobId]: result.deduplicated ? duplicateMessage : "公式ソースの更新を受け付けました。",
      }));
      setJobs((current) => current.map((item) => item.canonicalJobId === job.canonicalJobId
        ? { ...item, refresh: { ...item.refresh, eligible: false } }
        : item));
    });
  }

  return <main className="app-shell">
    <aside className="sidebar">
      <Link className="brand" href="/"><span className="brand-mark">日</span><span>Japan<br />Job Agent</span></Link>
      <nav aria-label="メインナビゲーション">
        {navigation.map(({ key, label, icon: Icon, href }) => <Link key={key} href={href} className={view === key ? "nav-link active" : "nav-link"}>
          <Icon size={19} strokeWidth={1.7} /><span>{label}</span>
        </Link>)}
        <div className="nav-separator" />
        <Link href="/?view=profile" className={view === "profile" ? "nav-link active" : "nav-link"}><CircleUserRound size={19} /><span>プロフィール</span></Link>
        <Link href="/?view=sources" className={view === "sources" ? "nav-link active" : "nav-link"}><Database size={19} /><span>ソース管理</span></Link>
        <Link href="/?view=review" className={view === "review" ? "nav-link active" : "nav-link"}><AlertCircle size={19} /><span>要確認</span></Link>
      </nav>
      <div className="privacy-block"><HeartPulse size={17} /><div><strong>プライベート</strong><span>証拠を優先して表示</span></div></div>
    </aside>

    <section className="workspace">
      <header className="workspace-header">
        <div><p className="eyebrow">VERIFIED JOBS</p><h1>{title}</h1></div>
        <div className="sync-status"><RefreshCw size={15} className={pending ? "spin" : ""} /><span>最終集計 {formatTime(initialData.generatedAt)}</span><i />正常</div>
      </header>
      {unavailable !== null ? <EmptyState title="推薦 API に接続できません" detail={`${unavailable} — API と PostgreSQL の起動状態を確認してください。`} /> :
       view === "profile" || view === "sources" || view === "review" ? <ManagementView view={view} data={management} /> :
       !initialData.profileConfigured ? <EmptyState title="プロフィールが未設定です" detail="ローカルの PII 除外インポートを実行すると推薦を開始できます。" /> :
       jobs.length === 0 ? <EmptyState title="この表示に求人はありません" detail="同期後、条件に一致した検証済み求人がここに表示されます。" /> :
       <div className="results-layout">
         <section className="job-list" aria-label="求人一覧">
           <div className="list-summary"><span>{jobs.length} 件</span><span><ListFilter size={15} /> スコア順</span></div>
           <div className="list-head"><span>スコア</span><span>企業・求人</span><span>ソース / 鮮度</span><span>一致理由</span></div>
           {jobs.map((job) => <JobRow key={job.canonicalJobId} job={job} selected={job.canonicalJobId === selected?.canonicalJobId} onSelect={() => setSelectedId(job.canonicalJobId)} />)}
           <p className="score-footnote">スコアは公開情報と固定ルールに基づく一致度です（100点満点）。</p>
         </section>
         {selected !== null && <JobDetail job={selected} evidenceMap={evidenceMap} pending={pending}
           refreshMessage={refreshMessages[selected.canonicalJobId] ?? null} updateState={updateState} requestRefresh={requestRefresh} />}
       </div>}
    </section>
  </main>;
}

function ManagementView({ view, data }: { view: string; data: unknown }) {
  if (view === "profile") {
    const row = asRecord(data);
    const profile = asRecord(row.structured_profile);
    return <section className="management-page"><header><h2>実プロフィール</h2><p>PII を保存しない allowlist 抽出結果と、固定された求職方針です。</p></header>
      <div className="management-grid">
        <InfoGroup title="応募トラック" values={asStrings(profile.targetChannels)} />
        <InfoGroup title="正規化スキル" values={asStrings(profile.normalizedSkills)} />
        <InfoGroup title="言語" values={Array.isArray(profile.languages) ? profile.languages.map((value) => {
          const language = asRecord(value); return `${String(language.code ?? "—")} · ${String(language.level ?? "—")}`;
        }) : []} />
        <InfoGroup title="経験シグナル" values={asStrings(profile.experienceSignals)} />
      </div><p className="management-footnote">Profile Version: {String(row.profile_version_id ?? "—")} · 原本の履歴書はリポジトリにもクラウドにも保存されません。</p>
    </section>;
  }
  const rows = Array.isArray(data) ? data.map(asRecord) : [];
  if (view === "sources") return <section className="management-page"><header><h2>ソース管理</h2><p>公式関係、同期状態、健全性を同じ監査面で確認します。</p></header>
    <div className="management-table"><div className="management-row head"><span>ソース</span><span>種別</span><span>検証</span><span>ヘルス</span><span>最終同期</span></div>
      {rows.map((row, index) => <div className="management-row" key={String(row.id ?? index)}><strong>{String(row.tenant_key ?? "—")}</strong><span>{String(row.source_kind ?? "—")}</span><span>{String(row.verification_state ?? "—")}</span><span>{String(row.health_state ?? "—")}</span><span>{formatDateTime(row.last_sync_at)}</span></div>)}
    </div></section>;
  return <section className="management-page"><header><h2>要確認</h2><p>サーキットブレーカー、Schema 変更、異常同期は人工確認に回り、求人を自動で閉じません。</p></header>
    {rows.length === 0 ? <EmptyState title="未処理の確認項目はありません" detail="異常同期が検出されると、原因と同期実行 ID がここに記録されます。" /> : <div className="review-list">
      {rows.map((row, index) => <article key={String(row.id ?? index)}><AlertCircle size={18} /><div><strong>{String(row.reason ?? "要確認")}</strong><p>{String(row.tenant_key ?? "ソース不明")} · {formatDateTime(row.created_at)}</p></div><span>{String(row.state ?? "open")}</span></article>)}
    </div>}
  </section>;
}

function InfoGroup({ title, values }: { title: string; values: string[] }) {
  return <section className="info-group"><h3>{title}</h3>{values.length === 0 ? <p>未設定</p> : <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>}</section>;
}

function JobRow({ job, selected, onSelect }: { job: JobView; selected: boolean; onSelect: () => void }) {
  const reason = job.matched[0]?.message ?? job.unknowns[0]?.message ?? "追加確認が必要です";
  return <button className={selected ? "job-row selected" : "job-row"} onClick={onSelect} type="button">
    <span className="row-score"><strong>{job.score}</strong><small>{job.score >= 75 ? "高い一致" : job.score >= 55 ? "一致" : "要確認"}</small></span>
    <span className="row-main"><b>{job.companyName}</b><strong>{job.title}</strong><small><MapPin size={13} /> {locationLabel(job)} <em>・</em> {employmentLabel(job)}</small></span>
    <span className="row-source"><b>公式 {sourceLabel(job.sourceKind)} <ArrowUpRight size={13} /></b><small>{formatDate(job.fetchedAt)}</small></span>
    <span className="row-reason"><b>{reason}</b><small>{job.gaps.length > 0 ? `ギャップ ${job.gaps.length}件` : job.unknowns.length > 0 ? `不明点 ${job.unknowns.length}件` : "確認済み"}</small></span>
  </button>;
}

function JobDetail({ job, evidenceMap, pending, updateState, refreshMessage, requestRefresh }: {
  job: JobView; evidenceMap: Map<string, EvidenceView>; pending: boolean;
  updateState: (job: JobView, patch: { saved?: boolean; hidden?: boolean; applied?: boolean }) => void;
  refreshMessage: string | null;
  requestRefresh: (job: JobView) => void;
}) {
  const citedEvidence = [...new Set([...job.matched, ...job.gaps].flatMap((item) => item.evidenceIds))]
    .map((id) => evidenceMap.get(id)).filter((value): value is EvidenceView => value !== undefined);
  return <aside className="job-detail">
    <div className="detail-scroll">
      <header className="detail-header"><p>{job.companyName}</p><h2>{job.title}</h2>
        <div className="detail-meta"><span>{locationLabel(job)}</span><i /> <span>{employmentLabel(job)}</span><strong><small>スコア</small>{job.score}</strong></div>
      </header>
      <section className="detail-section"><h3>スコア内訳</h3><div className="score-grid">
        {job.scoreBreakdown.map((part) => <div className="score-line" key={part.key} title={part.rationale}>
          <span>{part.label}</span><div><i style={{ width: `${part.maximum === 0 ? 0 : part.score / part.maximum * 100}%` }} /></div><b>{part.score}<small>/{part.maximum}</small></b>
        </div>)}
      </div></section>
      <Explanation title="推薦理由" items={job.matched} evidenceMap={evidenceMap} tone="positive" />
      <Explanation title="ギャップ・不明点" items={[...job.gaps, ...job.unknowns]} evidenceMap={evidenceMap} tone="caution" />
      <section className="detail-section evidence-section"><h3>原文エビデンス <span>公式ソースより</span></h3>
        {citedEvidence.length === 0 ? <p className="empty-copy">引用可能な原文を再解析中です。</p> : citedEvidence.slice(0, 8).map((evidence) => <article id={`evidence-${evidence.id}`} key={evidence.id}>
          <blockquote>「{evidence.quote}」</blockquote><a href={evidence.sourceUrl} target="_blank" rel="noreferrer">原文を確認 <ArrowUpRight size={13} /></a>
        </article>)}
      </section>
    </div>
    <footer className="detail-actions">
      <button type="button" disabled={pending} className={job.state.saved ? "text-action active" : "text-action"} onClick={() => updateState(job, { saved: !job.state.saved })}><Bookmark size={17} />保存</button>
      <button type="button" disabled={pending} className="text-action" onClick={() => updateState(job, { hidden: true })}><EyeOff size={17} />非表示</button>
      <button type="button" disabled={pending} className={job.state.appliedAt !== null ? "text-action active" : "text-action"} onClick={() => updateState(job, { applied: job.state.appliedAt === null })}><CheckCircle2 size={17} />応募済み</button>
      {(job.state.saved || job.state.appliedAt !== null) ? <button type="button" disabled={pending || !job.refresh.eligible}
        className="text-action" title={refreshPolicyLabel(job.refresh)} onClick={() => requestRefresh(job)}>
        <RefreshCw size={17} className={pending ? "spin" : ""} />{job.refresh.eligible ? "公式情報を更新" : job.refresh.stale ? "更新受付済み" : "最新"}
      </button> : null}
      <a className="apply-button" href={job.applicationUrl} target="_blank" rel="noreferrer">公式サイトで応募 <ArrowUpRight size={17} /></a>
      <span className="refresh-feedback" aria-live="polite">{refreshMessage}</span>
    </footer>
  </aside>;
}

function Explanation({ title, items, evidenceMap, tone }: { title: string; items: JobView["matched"]; evidenceMap: Map<string, EvidenceView>; tone: string }) {
  return <section className={`detail-section explanation ${tone}`}><h3>{title}</h3>
    {items.length === 0 ? <p className="empty-copy">該当項目はありません。</p> : <ul>{items.slice(0, 6).map((item, index) => <li key={`${item.field}-${index}`}>
      <span>{item.message}</span>{item.evidenceIds[0] !== undefined && evidenceMap.has(item.evidenceIds[0]) ? <a href={`#evidence-${item.evidenceIds[0]}`}>根拠 <ChevronRight size={13} /></a> : <small>原文不明</small>}
    </li>)}</ul>}
  </section>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <section className="empty-state"><AlertCircle size={25} /><h2>{title}</h2><p>{detail}</p></section>;
}

function sourceLabel(kind: string): string { return kind === "greenhouse" ? "Greenhouse" : kind === "schema_org" ? "JobPosting" : "手動確認"; }
function formatDate(value: string): string { return new Intl.DateTimeFormat("ja-JP", { month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function formatTime(value?: string): string { return value === undefined ? "—" : new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatDateTime(value: unknown): string { return typeof value === "string" || value instanceof Date ? new Intl.DateTimeFormat("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—"; }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function asStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function locationLabel(job: JobView): string {
  const value = job.scoreBreakdown.find((item) => item.key === "location_remote");
  return value?.score === value?.maximum ? "東京圏 / 国内リモート" : "勤務地を確認";
}
function employmentLabel(job: JobView): string {
  const value = job.scoreBreakdown.find((item) => item.key === "employment");
  return value?.score === value?.maximum ? "正社員" : "雇用形態を確認";
}
function refreshPolicyLabel(refresh: JobView["refresh"]): string {
  if (refresh.eligible) return "公式ソースを今すぐ再確認します";
  if (refresh.reason === "source_not_stale") return `次回更新可能: ${formatDateTime(refresh.staleAt)}`;
  if (refresh.reason === "save_or_apply_required") return "保存または応募済みにすると、古い公式情報を再確認できます";
  if (refresh.reason === "source_not_refreshable") return "このソースはオンデマンド更新の対象外です";
  return "現在は更新できません";
}
function refreshErrorLabel(reason?: string): string {
  if (reason === "source_not_stale") return "公式情報はまだ最新です。";
  if (reason === "save_or_apply_required") return "保存または応募済みの求人だけ更新できます。";
  if (reason === "source_not_refreshable") return "このソースは更新対象外です。";
  if (reason === "recent_refresh_failed") return "直近の更新に失敗しました。定期同期の状態を確認してください。";
  return "更新を開始できませんでした。時間を置いて再試行してください。";
}
