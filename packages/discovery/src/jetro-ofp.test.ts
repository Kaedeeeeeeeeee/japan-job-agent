import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import { importJetroOfpPages, parseJetroOfpPage } from "./jetro-ofp.js";

const fixture = `
<input name="totalHit" value="2">
<table><tbody>
<tr><th><a href="/hrportal/company/detail/100001.html">株式会社デジタル商事</a></th>
<td><img alt="採用希望あり"><img alt="インターン受け入れなし"><img alt="英語対応可能"></td>
<td><span aria-labelledby="jinzai"></span><ul><li>エンジニア</li><li>経営</li></ul></td>
<td><span aria-labelledby="gyoshu"></span><ul>EC・小売、通信・情報・ソフトウェア</ul></td></tr>
<tr><th><a href="/hrportal/company/detail/100002.html">社会福祉法人ケア</a></th>
<td><img alt="採用希望あり"><img alt="インターン受け入れあり"><img alt="英語対応不可"></td>
<td><span aria-labelledby="jinzai"></span><ul><li>その他</li></ul></td>
<td><span aria-labelledby="gyoshu"></span><ul>その他の非製造業</ul></td></tr>
</tbody></table><a class="pagenext" href="/hrportal/company.html?page=2&region=all">次へ</a>`;

describe("JETRO OFP discovery", () => {
  const page = parseJetroOfpPage(fixture, "https://www.jetro.go.jp/hrportal/company/", 1, "2026-07-13T00:00:00.000Z");

  it("parses attributable company signals without contact PII", () => {
    expect(page).toMatchObject({ providerTotal: 2, nextPage: 2 });
    expect(page.candidates).toHaveLength(2);
    expect(page.candidates[0]).toMatchObject({
      externalKey: "100001",
      displayName: "株式会社デジタル商事",
      priority: "p0",
      hiringInterest: true,
      englishSupport: true,
      industryLabels: ["EC・小売", "通信・情報・ソフトウェア"],
    });
    expect(JSON.stringify(page)).not.toMatch(/email|phone|contact/i);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe.sequential;
const { Pool } = pg;

integration("JETRO OFP persistence", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool }) });
  afterAll(async () => db.destroy());

  it("replays an import idempotently and keeps discovery outside jobs", async () => {
    const firstExternalKey = String(800_000_000 + Math.floor(Math.random() * 99_000_000));
    const secondExternalKey = String(Number(firstExternalKey) + 1);
    const isolatedFixture = fixture.replace("100001", firstExternalKey).replace("100002", secondExternalKey)
      .replace('class="pagenext"', 'class="last"');
    const page = parseJetroOfpPage(isolatedFixture, "https://www.jetro.go.jp/hrportal/company/", 1, "2026-07-13T00:00:00.000Z");
    const key = `fixture-${randomUUID()}`;
    const beforeJobs = await sql<{ count: string }>`SELECT count(*)::text count FROM source_job_records`.execute(db);
    const first = await importJetroOfpPages(db, [page], key);
    const replay = await importJetroOfpPages(db, [page], key);
    expect(first).toMatchObject({ candidateCount: 2, replayed: false });
    expect(replay).toMatchObject({ runId: first.runId, candidateCount: 2, replayed: true });
    const counts = await sql<{ candidates: string; signals: string; jobs: string }>`SELECT
      (SELECT count(*)::text FROM company_discovery_candidates WHERE last_import_run_id=${first.runId}::uuid) candidates,
      (SELECT count(*)::text FROM company_foreign_hiring_signals s JOIN company_discovery_candidates c ON c.id=s.discovery_candidate_id WHERE c.last_import_run_id=${first.runId}::uuid) signals,
      (SELECT count(*)::text FROM source_job_records) jobs`.execute(db);
    expect(counts.rows[0]?.candidates).toBe("2");
    expect(counts.rows[0]?.signals).toBe("4");
    expect(counts.rows[0]?.jobs).toBe(beforeJobs.rows[0]?.count);
  });
});
