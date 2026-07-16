"use client";

import {
  AlertCircle, ArrowUpRight, Bookmark, BriefcaseBusiness, CheckCircle2, ChevronDown, ChevronRight,
  CircleUserRound, Database, EyeOff, FileSearch, HeartPulse, Layers3, ListFilter, MapPin, RefreshCw,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { EvidenceView, JobsResponse, JobView } from "../types";

const navigation = [
  { key: "recommendations", label: "おすすめ", icon: FileSearch, href: "/" },
  { key: "saved", label: "保存済み", icon: Bookmark, href: "/?view=saved" },
  { key: "applied", label: "応募管理", icon: BriefcaseBusiness, href: "/?view=applied" },
];

export function Dashboard({ initialData, view, unavailable, management, initialOccupationFamilies }: {
  initialData: JobsResponse;
  view: string;
  unavailable: string | null;
  management: unknown;
  initialOccupationFamilies: string[];
}) {
  const [jobs, setJobs] = useState(initialData.jobs);
  const [selectedId, setSelectedId] = useState(initialData.jobs[0]?.canonicalJobId ?? null);
  const occupationFacets = initialData.facets?.occupations ?? [];
  const availableOccupationIds = useMemo(() => new Set(occupationFacets.map((facet) => facet.id)), [occupationFacets]);
  const [selectedOccupationFamilies, setSelectedOccupationFamilies] = useState(() =>
    initialOccupationFamilies.filter((family) => availableOccupationIds.has(family)));
  const [occupationFilterOpen, setOccupationFilterOpen] = useState(initialOccupationFamilies.length > 0);
  const [refreshMessages, setRefreshMessages] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const filteredJobs = useMemo(() => {
    if (selectedOccupationFamilies.length === 0) return jobs;
    const selectedFamilies = new Set(selectedOccupationFamilies);
    return jobs.filter((job) => selectedFamilies.has(job.occupation.primary.family)
      || job.occupation.secondary.some((occupation) => selectedFamilies.has(occupation.family)));
  }, [jobs, selectedOccupationFamilies]);
  const selected = filteredJobs.find((job) => job.canonicalJobId === selectedId) ?? filteredJobs[0] ?? null;
  const title = view === "saved" ? "保存済みの求人" : view === "applied" ? "応募管理" : "今日のおすすめ";
  const workspaceTitle = view === "discovery" ? "Discovery 候補プール" : title;
  const evidenceMap = useMemo(() => new Map(selected?.evidence.map((value) => [value.id, value]) ?? []), [selected]);

  useEffect(() => {
    const runId = initialData.recommendationRunId;
    if (runId === undefined || !initialData.jobs.some((job) => job.explanation.status === "pending")) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/recommendation-runs/${runId}/explanations`, { cache: "no-store" });
      if (!response.ok || stopped) return;
      const payload = await response.json() as { complete?: boolean; results?: Array<{
        canonicalJobVersionId: string;
        status: JobView["explanation"]["status"];
        explanation: { summary?: unknown; matched?: unknown; gaps?: unknown } | null;
        error: string | null;
      }> };
      const byVersion = new Map((payload.results ?? []).map((result) => [result.canonicalJobVersionId, result]));
      setJobs((current) => current.map((job) => {
        const result = byVersion.get(job.canonicalJobVersionId);
        if (result === undefined) return job;
        const explanation = result.explanation;
        return { ...job, explanation: {
          status: result.status,
          source: result.status === "succeeded" ? "ai" : "deterministic",
          summary: typeof explanation?.summary === "string" ? explanation.summary : null,
          matched: Array.isArray(explanation?.matched) ? explanation.matched as JobView["matched"] : null,
          gaps: Array.isArray(explanation?.gaps) ? explanation.gaps as JobView["gaps"] : null,
          error: result.error,
        } };
      }));
      if (payload.complete) window.clearInterval(timer);
    }, 3_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [initialData.jobs, initialData.recommendationRunId]);

  function updateOccupationFilter(next: string[]) {
    setSelectedOccupationFamilies(next);
    const url = new URL(window.location.href);
    if (next.length > 0) url.searchParams.set("occupation", next.join(","));
    else url.searchParams.delete("occupation");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function toggleOccupationFamily(family: string) {
    updateOccupationFilter(selectedOccupationFamilies.includes(family)
      ? selectedOccupationFamilies.filter((value) => value !== family)
      : [...selectedOccupationFamilies, family]);
  }

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
        <Link href="/?view=discovery" className={view === "discovery" ? "nav-link active" : "nav-link"}><Layers3 size={19} /><span>Discovery</span></Link>
        <Link href="/?view=review" className={view === "review" ? "nav-link active" : "nav-link"}><AlertCircle size={19} /><span>要確認</span></Link>
      </nav>
      <div className="privacy-block"><HeartPulse size={17} /><div><strong>プライベート</strong><span>証拠を優先して表示</span></div></div>
    </aside>

    <section className="workspace">
      <header className="workspace-header">
        <div><p className="eyebrow">{view === "discovery" ? "UNTRUSTED CANDIDATES" : "VERIFIED JOBS"}</p><h1>{workspaceTitle}</h1></div>
        <div className="sync-status"><RefreshCw size={15} className={pending ? "spin" : ""} /><span>最終集計 {formatTime(initialData.generatedAt)}</span><i />正常</div>
      </header>
      {unavailable !== null ? <EmptyState title="推薦 API に接続できません" detail={`${unavailable} — API と PostgreSQL の起動状態を確認してください。`} /> :
       view === "profile" || view === "sources" || view === "review" || view === "discovery" ? <ManagementView view={view} data={management} /> :
       !initialData.profileConfigured ? <EmptyState title="プロフィールが未設定です" detail="ローカルの PII 除外インポートを実行すると推薦を開始できます。" /> :
       jobs.length === 0 ? <EmptyState title="この表示に求人はありません" detail="同期後、条件に一致した検証済み求人がここに表示されます。" /> :
       <div className="results-layout">
         <section className="job-list" aria-label="求人一覧">
           <div className="list-summary"><span>{filteredJobs.length} 件{filteredJobs.length !== jobs.length ? ` / 全 ${jobs.length} 件` : ""}</span>
             <button type="button" className={selectedOccupationFamilies.length > 0 ? "filter-toggle active" : "filter-toggle"}
               aria-expanded={occupationFilterOpen} aria-controls="occupation-filter"
               onClick={() => setOccupationFilterOpen((current) => !current)}>
               <ListFilter size={15} />職種{selectedOccupationFamilies.length > 0 ? ` ${selectedOccupationFamilies.length}` : ""}<ChevronDown size={14} />
             </button>
           </div>
           {occupationFilterOpen && <OccupationFilter facets={occupationFacets} selected={selectedOccupationFamilies}
             onToggle={toggleOccupationFamily} onClear={() => updateOccupationFilter([])}
             onClose={() => setOccupationFilterOpen(false)} />}
           <div className="list-head"><span>スコア</span><span>企業・求人</span><span>ソース / 鮮度</span><span>一致理由</span></div>
           {filteredJobs.length === 0 ? <div className="filter-empty"><AlertCircle size={20} /><strong>選択した職種の求人はありません</strong>
             <p>職種を追加するか、絞り込みを解除してください。</p><button type="button" onClick={() => updateOccupationFilter([])}>すべての職種を表示</button></div>
             : filteredJobs.map((job) => <JobRow key={job.canonicalJobId} job={job} selected={job.canonicalJobId === selected?.canonicalJobId} onSelect={() => setSelectedId(job.canonicalJobId)} />)}
           {filteredJobs.length > 0 && <p className="score-footnote">スコアは公開情報と固定ルールに基づく一致度です（100点満点）。</p>}
         </section>
         {selected !== null && <JobDetail job={selected} evidenceMap={evidenceMap} pending={pending}
           refreshMessage={refreshMessages[selected.canonicalJobId] ?? null} updateState={updateState} requestRefresh={requestRefresh} />}
       </div>}
    </section>
  </main>;
}

function OccupationFilter({ facets, selected, onToggle, onClear, onClose }: {
  facets: NonNullable<JobsResponse["facets"]>["occupations"];
  selected: string[];
  onToggle: (family: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  return <section className="occupation-filter" id="occupation-filter" aria-label="職種で絞り込む">
    <header><div><strong>職種で絞り込む</strong><span>複数選択は OR 条件です</span></div>
      <button type="button" className="filter-close" onClick={onClose} aria-label="職種フィルターを閉じる"><X size={16} /></button>
    </header>
    <div className="occupation-options">
      {facets.map((facet) => <button key={facet.id} type="button"
        className={selected.includes(facet.id) ? "occupation-option selected" : "occupation-option"}
        aria-pressed={selected.includes(facet.id)} onClick={() => onToggle(facet.id)}>
        <span><i />{facet.label}</span><b>{facet.count}</b>
      </button>)}
    </div>
    <footer><span>{selected.length === 0 ? "すべての職種を表示中" : `${selected.length} 職種を選択中`}</span>
      {selected.length > 0 && <button type="button" onClick={onClear}>選択を解除</button>}
    </footer>
  </section>;
}

function ManagementView({ view, data }: { view: string; data: unknown }) {
  if (view === "discovery") {
    const payload = asRecord(data);
    const summary = asRecord(payload.summary);
    const candidates = Array.isArray(payload.candidates) ? payload.candidates.map(asRecord) : [];
    const metrics = [
      ["有効候補", summary.valid], ["全候補", summary.total], ["公式出口解決済み", summary.resolved],
      ["正式化済み", summary.promoted], ["勤務地不明", summary.unknown_location], ["候補公開日あり", summary.published_known],
      ["候補公開日不明", summary.published_unknown], ["正式公開日不明", summary.canonical_published_unknown],
      ["正式公開日競合", summary.canonical_published_conflicting], ["正式更新日不明", summary.canonical_updated_unknown],
      ["正式更新日競合", summary.canonical_updated_conflicting], ["正式締切不明", summary.canonical_deadline_unknown],
      ["正式締切競合", summary.canonical_deadline_conflicting],
    ];
    return <section className="management-page discovery-page"><header><h2>求人単位 Discovery 漏斗</h2>
      <p>候補は推薦に入りません。公式ソース関係と正式データチェーンを通過した求人だけが推薦画面に表示されます。</p></header>
      <div className="discovery-metrics">{metrics.map(([label, value]) => <article key={String(label)}>
        <span>{String(label)}</span><strong>{Number(value ?? 0).toLocaleString("ja-JP")}</strong>
      </article>)}</div>
      <div className="discovery-table"><div className="discovery-candidate-row head">
        <span>企業・求人</span><span>場所</span><span>來源</span><span>状態</span><span>観測</span>
      </div>{candidates.map((candidate) => <article className="discovery-candidate-row" key={String(candidate.id)}>
        <div><strong>{String(candidate.company_name ?? "—")}</strong><span>{String(candidate.title ?? "—")}</span></div>
        <span>{String(candidate.location_text ?? "—")}<small>{String(candidate.location_state ?? "unknown")}</small></span>
        <span>{String(candidate.source_family ?? "—")}<small>{String(candidate.origin_kind ?? "—")}</small></span>
        <span>{String(candidate.state ?? "—")}<small>{String(candidate.priority ?? "p2")}</small></span>
        <span>{formatDateTime(candidate.last_seen_at)}<small>{Number(candidate.observation_count ?? 0)} 回</small></span>
      </article>)}</div>
    </section>;
  }
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
  return <ReviewManagement rows={rows} />;
}

function ReviewManagement({ rows }: { rows: Array<Record<string, unknown>> }) {
  const [detail, setDetail] = useState<{ task: Record<string, unknown>; sections: Array<Record<string, unknown>> } | null>(null);
  const [sectionId, setSectionId] = useState("");
  const [quote, setQuote] = useState("");
  const [message, setMessage] = useState("");
  const [loading, startReviewTransition] = useTransition();
  const openRows = rows.filter((row) => row.state === "open");

  function openTask(id: string) {
    startReviewTransition(async () => {
      setMessage("");
      const response = await fetch(`/api/field-review-tasks/${id}`, { cache: "no-store" });
      if (!response.ok) { setMessage("审核详情を取得できませんでした。"); return; }
      const payload = await response.json() as { task: Record<string, unknown>; sections: Array<Record<string, unknown>> };
      setDetail(payload);
      const field = String(payload.task.field_name ?? "");
      const preferred = payload.sections.find((section) => sectionKindForField(field).includes(String(section.section_kind)))
        ?? payload.sections[0];
      setSectionId(String(preferred?.id ?? ""));
      setQuote(String(preferred?.section_text ?? ""));
    });
  }

  function chooseSection(id: string) {
    setSectionId(id);
    const section = detail?.sections.find((candidate) => candidate.id === id);
    setQuote(String(section?.section_text ?? ""));
  }

  function resolveTask() {
    if (detail === null || sectionId === "" || quote.trim() === "") return;
    startReviewTransition(async () => {
      const taskId = String(detail.task.id);
      const response = await fetch(`/api/field-review-tasks/${taskId}/resolve`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sectionId, quote: quote.trim(), rawValue: quote.trim(),
          normalizedCandidate: quote.trim(), requirementKind: "mentioned" }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { message?: string | string[] };
        setMessage(Array.isArray(error.message) ? error.message.join(" / ") : error.message ?? "選択した原文を構造化できませんでした。");
        return;
      }
      setMessage("原文を根拠に Manual Extraction を作成し、推薦準備状態を更新しました。");
      setDetail(null);
    });
  }

  return <section className="management-page"><header><h2>要確認</h2>
    <p>同期異常と、正社員・勤務地などの解析未解決項目を分けて確認します。字段の解決では必ず同じ Raw Version の原文を選びます。</p></header>
    {openRows.length === 0 ? <EmptyState title="未処理の確認項目はありません" detail="解析や同期で人の判断が必要になると、証拠候補と理由がここに記録されます。" /> : <div className="review-list">
      {openRows.map((row, index) => <article key={String(row.id ?? index)}><AlertCircle size={18} /><div>
        <strong>{row.task_kind === "job_field" ? `${fieldLabel(String(row.field_name ?? ""))}: ${unknownReasonLabel(String(row.reason ?? ""))}` : String(row.reason ?? "要確認")}</strong>
        <p>{String(row.tenant_key ?? "ソース不明")} · {formatDateTime(row.created_at)}</p></div>
        {row.task_kind === "job_field" ? <button type="button" disabled={loading} onClick={() => openTask(String(row.id))}>原文を選択</button>
          : <span>{String(row.state ?? "open")}</span>}
      </article>)}
    </div>}
    {detail !== null && <section className="field-review-editor"><header><div><strong>{fieldLabel(String(detail.task.field_name ?? ""))}</strong>
      <span>{unknownReasonLabel(String(detail.task.reason ?? ""))}</span></div><button type="button" onClick={() => setDetail(null)}><X size={16} /></button></header>
      <label>原文 Section<select value={sectionId} onChange={(event) => chooseSection(event.target.value)}>
        {detail.sections.map((section) => <option key={String(section.id)} value={String(section.id)}>
          {String(section.heading ?? section.section_kind)} · {String(section.section_text ?? "").slice(0, 50)}
        </option>)}
      </select></label>
      <label>採用する原文 Quote<textarea value={quote} onChange={(event) => setQuote(event.target.value)} rows={6} /></label>
      <p>Quote は選択した Section に逐字で存在する必要があります。保存時に住所・給与・雇用形態を再度確定的に正規化します。</p>
      <button type="button" className="review-resolve" disabled={loading || quote.trim() === ""} onClick={resolveTask}>この原文で解決</button>
    </section>}
    {message !== "" && <p className="review-message" aria-live="polite">{message}</p>}
  </section>;
}

function InfoGroup({ title, values }: { title: string; values: string[] }) {
  return <section className="info-group"><h3>{title}</h3>{values.length === 0 ? <p>未設定</p> : <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>}</section>;
}

function JobRow({ job, selected, onSelect }: { job: JobView; selected: boolean; onSelect: () => void }) {
  const reason = job.matched[0]?.message ?? job.unknowns[0]?.message ?? "追加確認が必要です";
  return <article className={selected ? "job-row selected" : "job-row"}>
    <button className="job-row-select" onClick={onSelect} type="button"
      aria-label={`${job.companyName} ${job.title} の詳細を表示`} aria-pressed={selected} />
    <span className="row-score"><strong>{job.score}</strong><small>{job.score >= 75 ? "高い一致" : job.score >= 55 ? "一致" : "要確認"}</small></span>
    <span className="row-main"><b>{job.companyName}</b><strong>{job.title}</strong><small className="row-occupation">{job.occupation.primary.roleLabel}</small><small><MapPin size={13} /> {locationLabel(job)} <em>・</em> {employmentLabel(job)}</small></span>
    <span className="row-source"><a href={job.applicationUrl} target="_blank" rel="noreferrer"
      aria-label={`${job.companyName} の公式 ${sourceLabel(job.sourceKind)} 求人を開く`}>
      <b>公式 {sourceLabel(job.sourceKind)} <ArrowUpRight size={13} /></b>
    </a><small>{displayDateLabel(job)}</small></span>
    <span className="row-reason"><b>{reason}</b><small>{job.gaps.length > 0 ? `ギャップ ${job.gaps.length}件` : job.unknowns.length > 0 ? `不明点 ${job.unknowns.length}件` : "確認済み"}</small></span>
  </article>;
}

function JobDetail({ job, evidenceMap, pending, updateState, refreshMessage, requestRefresh }: {
  job: JobView; evidenceMap: Map<string, EvidenceView>; pending: boolean;
  updateState: (job: JobView, patch: { saved?: boolean; hidden?: boolean; applied?: boolean }) => void;
  refreshMessage: string | null;
  requestRefresh: (job: JobView) => void;
}) {
  const displayedMatched = job.explanation.status === "succeeded" && job.explanation.matched !== null
    ? job.explanation.matched : job.matched;
  const displayedGaps = job.explanation.status === "succeeded" && job.explanation.gaps !== null
    ? job.explanation.gaps : job.gaps;
  const citedEvidence = [...new Set([...displayedMatched, ...displayedGaps].flatMap((item) => item.evidenceIds))]
    .map((id) => evidenceMap.get(id)).filter((value): value is EvidenceView => value !== undefined);
  return <aside className="job-detail">
    <div className="detail-scroll">
      <header className="detail-header"><p>{job.companyName}</p><span className="detail-occupation">{job.occupation.primary.familyLabel} / {job.occupation.primary.roleLabel}</span><h2>{job.title}</h2>
        <div className="detail-meta"><span>{locationLabel(job)}</span><i /> <span>{employmentLabel(job)}</span><i />
          <span>{displayDateLabel(job)}</span><strong><small>スコア</small>{job.score}</strong></div>
      </header>
      <section className="detail-section"><h3>スコア内訳</h3><div className="score-grid">
        {job.scoreBreakdown.map((part) => <div className="score-line" key={part.key} title={part.rationale}>
          <span>{part.label}</span><div><i style={{ width: `${part.maximum === 0 ? 0 : part.score / part.maximum * 100}%` }} /></div><b>{part.score}<small>/{part.maximum}</small></b>
        </div>)}
      </div></section>
      <section className="detail-section"><h3>掲載日時</h3><div className="date-facts">
        <p><span>表示基準</span><b>{displayDateLabel(job)}</b></p>
        <p><span>公式ソース更新</span><b>{dateFactLabel(job.dates.sourceUpdated)}</b></p>
        <p><span>応募締切</span><b>{dateFactLabel(job.dates.validThrough)}</b></p>
        <p><span>最新原文取得</span><b>{formatDateTime(job.dates.fetchedAt)}</b></p>
      </div></section>
      {job.explanation.summary !== null && <section className="detail-section ai-summary"><h3>AI 要約</h3><p>{job.explanation.summary}</p></section>}
      {job.explanation.status === "pending" && <p className="explanation-status"><RefreshCw size={13} className="spin" />推薦理由を生成中（固定ルールの説明を表示しています）</p>}
      {job.explanation.status === "failed" && <p className="explanation-status caution">AI 説明を生成できなかったため、固定ルールの説明を表示しています。</p>}
      <Explanation title="推薦理由" items={displayedMatched} evidenceMap={evidenceMap} tone="positive" fieldStates={job.fieldStates} />
      <Explanation title="ギャップ・不明点" items={[...displayedGaps, ...job.unknowns]} evidenceMap={evidenceMap} tone="caution" fieldStates={job.fieldStates} />
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

function Explanation({ title, items, evidenceMap, tone, fieldStates }: {
  title: string;
  items: JobView["matched"];
  evidenceMap: Map<string, EvidenceView>;
  tone: string;
  fieldStates: JobView["fieldStates"];
}) {
  return <section className={`detail-section explanation ${tone}`}><h3>{title}</h3>
    {items.length === 0 ? <p className="empty-copy">該当項目はありません。</p> : <ul>{items.slice(0, 6).map((item, index) => <li key={`${item.field}-${index}`}>
      <span>{item.message}</span>{item.evidenceIds[0] !== undefined && evidenceMap.has(item.evidenceIds[0]) ? <a href={`#evidence-${item.evidenceIds[0]}`}>根拠 <ChevronRight size={13} /></a> : <small>{fieldStateLabel(fieldStates[item.field])}</small>}
    </li>)}</ul>}
  </section>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <section className="empty-state"><AlertCircle size={25} /><h2>{title}</h2><p>{detail}</p></section>;
}

function sourceLabel(kind: string): string {
  return ({ greenhouse: "Greenhouse", schema_org: "JobPosting", hrmos: "HRMOS", herp: "HERP", jobcan: "Jobcan",
    airwork: "AirWork", engage: "engage", talentio: "Talentio", smartrecruiters: "SmartRecruiters",
    lever: "Lever", ashby: "Ashby", workday: "Workday", manual: "手動確認" } as Record<string, string>)[kind] ?? kind;
}
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
function displayDateLabel(job: JobView): string {
  const conflict = job.dates.published.state === "conflicting" ? "（複数ソースで相違）" : "";
  return `${job.dates.display.kind === "published" ? "公開" : "初回発見"} ${formatDate(job.dates.display.value)}${conflict}`;
}
function dateFactLabel(fact: JobView["dates"]["sourceUpdated"]): string {
  if (fact.value === null) return fact.state === "conflicting" ? "複数ソースで相違" : "記載なし";
  return `${formatDateTime(fact.value)}${fact.state === "conflicting" ? "（複数ソースで相違）" : ""}`;
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

function fieldStateLabel(state: JobView["fieldStates"][string] | undefined): string {
  if (state === undefined) return "根拠を再解析中";
  if (state.state === "conflicting") return "原文の記載が競合";
  if (state.processing) return "二次解析中";
  if (state.unknownReason === "not_mentioned") return "原文に記載なし";
  if (["low_confidence", "provider_failed"].includes(state.unknownReason ?? "")) return "解析失敗・要確認";
  if (state.unknownReason === "unsupported_format") return "未対応形式・要確認";
  return "解析待ち・要確認";
}

function fieldLabel(field: string): string {
  return ({ employmentTypes: "雇用形態", locations: "勤務地", compensation: "給与", skills: "スキル",
    languages: "言語", experienceRequirements: "経験要件" } as Record<string, string>)[field] ?? field;
}

function unknownReasonLabel(reason: string): string {
  return ({ not_mentioned: "原文に記載なし", not_parsed: "解析できず", unsupported_format: "未対応形式",
    low_confidence: "信頼度不足", provider_failed: "AI 補充失敗" } as Record<string, string>)[reason] ?? reason;
}

function sectionKindForField(field: string): string[] {
  return ({ employmentTypes: ["title", "employment"], locations: ["location"], compensation: ["compensation"],
    skills: ["skills", "required_requirements", "preferred_requirements"],
    languages: ["languages", "required_requirements", "preferred_requirements"],
    experienceRequirements: ["experience", "required_requirements", "preferred_requirements"] } as Record<string, string[]>)[field] ?? ["other"];
}
