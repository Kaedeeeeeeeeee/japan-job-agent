import { createHash } from "node:crypto";
import { load } from "cheerio";
import { sql, type Kysely } from "kysely";
import type { CorpusPriority, DiscoveryCandidate, DiscoveryPage } from "../../contracts/src/index.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";

const OFP_BASE_URL = "https://www.jetro.go.jp";

export function parseJetroOfpPage(
  html: string,
  sourceUrl: string,
  page: number,
  fetchedAt: string,
): DiscoveryPage {
  const $ = load(html);
  const candidates: DiscoveryCandidate[] = [];

  $("table tr").each((_index, row) => {
    const link = $(row).find('th a[href*="/hrportal/company/detail/"]').first();
    const href = link.attr("href");
    const displayName = cleanText(link.text());
    const externalKey = href?.match(/\/detail\/(\d+)\.html/)?.[1];
    if (href === undefined || externalKey === undefined || displayName === "") return;

    const iconAlts = $(row).find("img[alt]").map((_i, image) => $(image).attr("alt") ?? "").get();
    const rolesCell = $(row).find('[aria-labelledby="jinzai"]').closest("td");
    const industryCell = $(row).find('[aria-labelledby="gyoshu"]').closest("td");
    const desiredRoleLabels = rolesCell.find("li").map((_i, item) => cleanText($(item).text())).get().filter(Boolean);
    const industryLabels = splitLabels(industryCell.find("ul").text());
    const hiringInterest = iconAlts.includes("採用希望あり");
    const internshipAvailable = iconAlts.includes("インターン受け入れあり");
    const englishSupport = iconAlts.includes("英語対応可能") || iconAlts.includes("英語のみでの対応可能");
    const evidenceQuote = [
      hiringInterest ? "採用希望あり" : "採用希望なし",
      internshipAvailable ? "インターン受け入れあり" : "インターン受け入れなし",
      englishSupport ? "英語対応可能" : "英語対応不可",
    ].join(" / ");

    candidates.push({
      externalKey,
      displayName,
      detailUrl: new URL(href, OFP_BASE_URL).toString(),
      prefecture: null,
      industryLabels,
      desiredRoleLabels,
      priority: classifyPriority(industryLabels, desiredRoleLabels),
      hiringInterest,
      internshipAvailable,
      englishSupport,
      evidenceQuote,
    });
  });

  const providerTotalText = $('[name="totalHit"]').attr("value")
    ?? $(".elem_pagination_info, .result_count, .search_result_count").first().text();
  const providerTotalMatch = providerTotalText.match(/\d+/);
  const nextHref = $('a.pagenext[href*="page="]').attr("href");
  const nextPageMatch = nextHref?.match(/[?&]page=(\d+)/);
  const result: DiscoveryPage = {
    candidates,
    page,
    nextPage: nextPageMatch == null ? null : Number(nextPageMatch[1]),
    fetchedAt,
    sourceUrl,
  };
  if (providerTotalMatch !== null) result.providerTotal = Number(providerTotalMatch[0]);
  return result;
}

export interface DiscoveryImportResult {
  runId: string;
  candidateCount: number;
  replayed: boolean;
}

export interface JetroOfpCompanyDetail {
  externalKey: string;
  displayName: string;
  detailUrl: string;
  officialSiteUrl: string | null;
  recruitmentUrl: string | null;
  hiringInterest: boolean;
  internshipAvailable: boolean;
  englishSupport: boolean;
  industryLabels: string[];
  prefecture: string | null;
  fetchedAt: string;
}

export function parseJetroOfpDetail(
  html: string,
  detailUrl: string,
  fetchedAt: string,
): JetroOfpCompanyDetail {
  const $ = load(html);
  const externalKey = new URL(detailUrl).pathname.match(/\/detail\/(\d+)\.html/)?.[1];
  if (externalKey === undefined) throw new Error(`Invalid JETRO OFP detail URL: ${detailUrl}`);
  const heading = cleanText($(".hrportal_company_title h1").first().text()).replace(/^高度外国人材関心企業\s*/, "");
  if (heading === "") throw new Error(`JETRO OFP detail ${externalKey} has no company name`);
  const officialSiteUrl = labeledExternalLink($, "企業サイトを見る");
  const recruitmentUrl = labeledExternalLink($, "企業にコンタクトする");
  const points = cleanText($(".hrportal_company_point").first().text());
  const infoItems = $(".elem_text_list_term dl.item").toArray();
  const industryItem = infoItems.find((item) => cleanText($(item).find("dt").text()) === "業種");
  const prefectureItem = infoItems.find((item) => cleanText($(item).find("dt").text()) === "所在地");
  return {
    externalKey,
    displayName: heading,
    detailUrl,
    officialSiteUrl,
    recruitmentUrl,
    hiringInterest: /採用希望有/.test(points),
    internshipAvailable: /インターン\s*受け入れ有/.test(points),
    englishSupport: !/英語対応不可/.test(points) && /英語/.test(points),
    industryLabels: industryItem === undefined ? [] : $(industryItem).find("dd li").map((_i, item) => cleanText($(item).text())).get().filter(Boolean),
    prefecture: prefectureItem === undefined ? null : cleanText($(prefectureItem).find("dd").text()) || null,
    fetchedAt,
  };
}

export async function importJetroOfpPages(
  db: Kysely<OutboxDatabase>,
  pages: readonly DiscoveryPage[],
  idempotencyKey: string,
): Promise<DiscoveryImportResult> {
  if (pages.length === 0) throw new Error("At least one OFP page is required");
  const candidates = pages.flatMap((page) => page.candidates);
  const providerTotal = pages[0]?.providerTotal;
  const rawHash = createHash("sha256").update(JSON.stringify(pages)).digest("hex");

  return db.transaction().execute(async (trx) => {
    const inserted = await sql<{ id: string }>`INSERT INTO discovery_import_runs(
      discovery_source_id,idempotency_key,status,page_count,provider_total,discovered_count,raw_hash,validation_result
    ) SELECT id,${idempotencyKey},'running',${pages.length},${providerTotal ?? null},${candidates.length},${rawHash},
      ${JSON.stringify({ allPagesCompleted: pages.at(-1)?.nextPage === null })}::jsonb
      FROM discovery_sources WHERE source_key='jetro-ofp'
      ON CONFLICT(discovery_source_id,idempotency_key) DO NOTHING RETURNING id`.execute(trx);
    const runId = inserted.rows[0]?.id;
    if (runId === undefined) {
      const existing = await sql<{ id: string; discovered_count: number }>`SELECT r.id,r.discovered_count
        FROM discovery_import_runs r JOIN discovery_sources s ON s.id=r.discovery_source_id
        WHERE s.source_key='jetro-ofp' AND r.idempotency_key=${idempotencyKey}`.execute(trx);
      const row = existing.rows[0];
      if (row === undefined) throw new Error("OFP discovery source is not seeded");
      return { runId: row.id, candidateCount: row.discovered_count, replayed: true };
    }

    for (const page of pages) {
      const payload = JSON.stringify(page);
      const payloadHash = createHash("sha256").update(payload).digest("hex");
      await sql`INSERT INTO discovery_import_pages(
        discovery_import_run_id,page_number,source_url,payload_hash,raw_payload,fetched_at
      ) VALUES (${runId}::uuid,${page.page},${page.sourceUrl},${payloadHash},${payload}::jsonb,${page.fetchedAt}::timestamptz)`.execute(trx);
    }

    for (const candidate of candidates) {
      const normalizedName = normalizeCompanyName(candidate.displayName);
      const upserted = await sql<{ id: string }>`INSERT INTO company_discovery_candidates(
        discovery_source_id,external_key,display_name,normalized_name,detail_url,industry_labels,
        desired_role_labels,priority,first_seen_at,last_seen_at,last_import_run_id
      ) SELECT id,${candidate.externalKey},${candidate.displayName},${normalizedName},${candidate.detailUrl},
        ${candidate.industryLabels}::text[],${candidate.desiredRoleLabels}::text[],${candidate.priority}::corpus_priority,
        ${pages[0]?.fetchedAt}::timestamptz,${pages[0]?.fetchedAt}::timestamptz,${runId}::uuid
        FROM discovery_sources WHERE source_key='jetro-ofp'
        ON CONFLICT(discovery_source_id,external_key) DO UPDATE SET
          display_name=excluded.display_name,normalized_name=excluded.normalized_name,detail_url=excluded.detail_url,
          industry_labels=excluded.industry_labels,desired_role_labels=excluded.desired_role_labels,
          priority=excluded.priority,last_seen_at=excluded.last_seen_at,last_import_run_id=excluded.last_import_run_id,
          updated_at=now() RETURNING id`.execute(trx);
      const candidateId = upserted.rows[0]?.id;
      if (candidateId === undefined) throw new Error(`Failed to upsert OFP candidate ${candidate.externalKey}`);
      const observedAt = pages[0]?.fetchedAt;
      await insertSignal(trx, candidateId, "foreign_talent_interest", candidate.hiringInterest, candidate, observedAt);
      await insertSignal(trx, candidateId, "english_support", candidate.englishSupport, candidate, observedAt);
    }

    await sql`UPDATE discovery_import_runs SET status='succeeded',finished_at=now() WHERE id=${runId}::uuid`.execute(trx);
    return { runId, candidateCount: candidates.length, replayed: false };
  });
}

async function insertSignal(
  db: Kysely<OutboxDatabase>,
  candidateId: string,
  signalKind: "foreign_talent_interest" | "english_support",
  value: boolean,
  candidate: DiscoveryCandidate,
  observedAt: string | undefined,
): Promise<void> {
  if (observedAt === undefined) throw new Error("Discovery page is missing fetchedAt");
  await sql`INSERT INTO company_foreign_hiring_signals(
    discovery_candidate_id,signal_kind,value_state,value,source_url,quoted_text,locator,observed_at
  ) VALUES (
    ${candidateId}::uuid,${signalKind}::foreign_hiring_signal_kind,'known',${value},${candidate.detailUrl},
    ${candidate.evidenceQuote},${JSON.stringify({ source: "jetro-ofp", externalKey: candidate.externalKey })}::jsonb,
    ${observedAt}::timestamptz
  ) ON CONFLICT DO NOTHING`.execute(db);
}

function classifyPriority(industries: readonly string[], roles: readonly string[]): CorpusPriority {
  const text = [...industries, ...roles].join(" ").toLowerCase();
  if (/情報通信|ソフトウェア|e[\s-]?c|電子商取引|エンジニア|ai|データ/.test(text)) return "p0";
  if (/専門サービス|コンサル|人事|採用|労務|経営/.test(text)) return "p1";
  return "p2";
}

function normalizeCompanyName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ja").replace(/[\s　]+/g, "").trim();
}

function splitLabels(value: string): string[] {
  return cleanText(value).split(/[、,]/).map(cleanText).filter(Boolean);
}

function cleanText(value: string): string {
  return value.replace(/[\s　]+/g, " ").trim();
}

function labeledExternalLink($: ReturnType<typeof load>, label: string): string | null {
  const anchor = $("a[href]").toArray().find((element) => cleanText($(element).text()).includes(label));
  const href = anchor === undefined ? undefined : $(anchor).attr("href");
  if (href === undefined || !/^https?:\/\//.test(href)) return null;
  return href;
}
