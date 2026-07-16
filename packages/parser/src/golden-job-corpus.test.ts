import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ParserContext, SourceJobVersion, SourceKind } from "../../contracts/src/index.js";
import { DeterministicJobParser, type ParsedJob } from "./deterministic-job-parser.js";

const SOURCE_KINDS: readonly SourceKind[] = [
  "greenhouse", "schema_org", "manual", "hrmos", "herp", "jobcan", "airwork", "engage", "talentio",
  "smartrecruiters", "lever", "ashby", "workday",
];

const HIGH_RISK_VARIANTS = [
  { label: "tokyo-permanent", employment: "正社員", expectedEmployment: "permanent", location: "東京都渋谷区", prefecture: "東京都" },
  { label: "niigata-permanent", employment: "正社員", expectedEmployment: "permanent", location: "新潟県燕市吉田下中野1535番地5", prefecture: "新潟県" },
  { label: "osaka-permanent", employment: "正規社員", expectedEmployment: "permanent", location: "大阪府大阪市北区", prefecture: "大阪府" },
  { label: "fukuoka-permanent", employment: "FULL_TIME", expectedEmployment: "permanent", location: "福岡県福岡市博多区", prefecture: "福岡県" },
  { label: "hokkaido-permanent", employment: "正社員", expectedEmployment: "permanent", location: "北海道札幌市中央区", prefecture: "北海道" },
  { label: "kanagawa-fixed", employment: "契約社員", expectedEmployment: "fixed_term", location: "神奈川県横浜市西区", prefecture: "神奈川県" },
  { label: "kyoto-fixed", employment: "有期雇用", expectedEmployment: "fixed_term", location: "京都府京都市中京区", prefecture: "京都府" },
  { label: "remote-japan", employment: "正社員", expectedEmployment: "permanent", location: "日本国内フルリモート", prefecture: null },
] as const;

interface GoldenCase {
  id: string;
  sourceKind: SourceKind;
  expectedEmployment: string;
  expectedPrefecture: string | null;
  expectedRemoteScope: "japan" | null;
  version: SourceJobVersion;
  context: ParserContext;
}

const GOLDEN_CASES: GoldenCase[] = SOURCE_KINDS.flatMap((sourceKind) => HIGH_RISK_VARIANTS.map((variant) => {
  const payload = JSON.stringify({
    title: `業務改善スペシャリスト ${sourceKind} ${variant.label}`,
    employmentType: variant.employment,
    location: { name: variant.location },
    salary: "月給22万円〜25万円",
    requirements: "必須: Microsoft Word、Microsoft Excel、日本語JLPT N2",
    description: "業務プロセスの改善、資料作成、関係者との調整を担当します。",
  });
  const raw = new TextEncoder().encode(payload);
  const id = `${sourceKind}:${variant.label}`;
  return {
    id,
    sourceKind,
    expectedEmployment: variant.expectedEmployment,
    expectedPrefecture: variant.prefecture,
    expectedRemoteScope: variant.prefecture === null ? "japan" : null,
    version: {
      id: randomUUID(), sourceJobRecordId: randomUUID(), rawHash: sha256(raw), contentHash: sha256(raw),
      canonicalizationVersion: "golden-synthetic-v1", raw,
      sourceUrl: `https://fixture.invalid/${sourceKind}/${variant.label}`,
      fetchedAt: "2026-07-14T00:00:00.000Z",
    },
    context: {
      source: { id: randomUUID(), sourceKind, tenantKey: `golden-${sourceKind}`, baseUrl: "https://fixture.invalid" },
      localeHints: ["ja-JP"],
    },
  } satisfies GoldenCase;
}));

describe("hybrid parser CI Golden Set", () => {
  it("contains approximately 100 minimized cases stratified by every Source Adapter", () => {
    expect(GOLDEN_CASES).toHaveLength(104);
    expect(new Set(GOLDEN_CASES.map((fixture) => fixture.sourceKind))).toEqual(new Set(SOURCE_KINDS));
  });

  it("meets the high-risk employment/location precision and recall gates", async () => {
    let expectedFacts = 0;
    let predictedFacts = 0;
    let truePositiveFacts = 0;
    const failures: string[] = [];

    for (const fixture of GOLDEN_CASES) {
      const result = await new DeterministicJobParser().parse(fixture.version, fixture.context);
      if (result.status !== "succeeded") {
        failures.push(`${fixture.id}: parser status ${result.status}`);
        expectedFacts += 2;
        continue;
      }
      const structured = result.structured as ParsedJob;

      expectedFacts += 2;
      if (structured.employmentTypes.state !== "unknown") {
        predictedFacts += 1;
        if (structured.employmentTypes.state === "known"
          && structured.employmentTypes.values.includes(fixture.expectedEmployment)) truePositiveFacts += 1;
        else failures.push(`${fixture.id}: employment ${JSON.stringify(structured.employmentTypes)}`);
      } else failures.push(`${fixture.id}: employment unknown`);

      if (structured.locations.state !== "unknown") {
        predictedFacts += 1;
        const locationMatched = structured.locations.state === "known"
          && structured.locations.values.some((location) => fixture.expectedPrefecture === null
            ? location.remoteScope === fixture.expectedRemoteScope
            : location.countryCode === "JP" && location.prefecture === fixture.expectedPrefecture);
        if (locationMatched) truePositiveFacts += 1;
        else failures.push(`${fixture.id}: location ${JSON.stringify(structured.locations)}`);
      } else failures.push(`${fixture.id}: location unknown`);

      expect(structured.compensation, `${fixture.id}: compensation`).toMatchObject({
        state: "known", values: [{ period: "month", minimumAmount: 220000, maximumAmount: 250000 }],
      });
      expect(structured.skills, `${fixture.id}: skills`).toMatchObject({ state: "known" });
      expect(structured.languages, `${fixture.id}: languages`).toMatchObject({ state: "known" });
    }

    const precision = truePositiveFacts / Math.max(1, predictedFacts);
    const recall = truePositiveFacts / expectedFacts;
    expect(failures, failures.join("\n")).toEqual([]);
    expect(precision).toBeGreaterThanOrEqual(0.99);
    expect(recall).toBeGreaterThanOrEqual(0.95);
  });
});

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
