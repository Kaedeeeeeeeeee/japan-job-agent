import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import type {
  CanonicalDocument,
  CanonicalDocumentSection,
  CanonicalSectionKind,
  ParserContext,
  SourceJobVersion,
  SourceKind,
} from "../../contracts/src/index.js";

export const CANONICAL_DOCUMENT_ADAPTER_VERSION = "canonical-document-v2";
const MAX_SECTION_CHARS = 6_000;

export interface CanonicalSourceAdapter {
  key: string;
  sourceKind: SourceKind;
  build(raw: Uint8Array, version: SourceJobVersion): Omit<CanonicalDocument, "sourceJobVersionId" | "adapterKey" | "adapterVersion" | "contentHash">;
}

const SUPPORTED_SOURCE_KINDS: readonly SourceKind[] = [
  "greenhouse", "schema_org", "manual", "hrmos", "herp", "jobcan", "airwork", "engage", "talentio",
  "smartrecruiters", "lever", "ashby", "workday",
];

export const canonicalSourceAdapters: ReadonlyMap<SourceKind, CanonicalSourceAdapter> = new Map(
  SUPPORTED_SOURCE_KINDS.map((sourceKind) => [sourceKind, {
    key: `canonical-${sourceKind}`,
    sourceKind,
    build: (raw: Uint8Array, version: SourceJobVersion) => buildForSource(sourceKind, raw, version),
  }]),
);

export function buildCanonicalDocument(
  version: SourceJobVersion,
  context: ParserContext,
): CanonicalDocument {
  const adapter = canonicalSourceAdapters.get(context.source.sourceKind);
  if (adapter === undefined) throw new Error(`No Canonical Document adapter for ${context.source.sourceKind}`);
  const candidate = adapter.build(version.raw, version);
  const contentHash = sha256(stableJson({
    adapterKey: adapter.key,
    adapterVersion: CANONICAL_DOCUMENT_ADAPTER_VERSION,
    title: candidate.title,
    fullText: candidate.fullText,
    sections: candidate.sections.map((section) => ({
      kind: section.kind,
      heading: section.heading,
      ordinal: section.ordinal,
      text: section.text,
      locator: section.locator,
      textHash: section.textHash,
    })),
  }));
  return {
    sourceJobVersionId: version.id,
    adapterKey: adapter.key,
    adapterVersion: CANONICAL_DOCUMENT_ADAPTER_VERSION,
    contentHash,
    ...candidate,
  };
}

function buildForSource(sourceKind: SourceKind, raw: Uint8Array, version: SourceJobVersion) {
  const input = new TextDecoder().decode(raw);
  const trimmed = input.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return documentFromJson(JSON.parse(input) as unknown, sourceKind, version.sourceUrl);
  }
  return documentFromHtml(input, sourceKind, version.sourceUrl);
}

function documentFromHtml(input: string, sourceKind: SourceKind, sourceUrl: string) {
  const $ = load(input);
  for (const element of $('script[type="application/ld+json"]').toArray()) {
    try {
      const value = JSON.parse($(element).text()) as unknown;
      const posting = findJobPostingObject(value);
      if (posting !== null) return documentFromJson(posting, sourceKind, sourceUrl);
    } catch {
      // Ignore unrelated or malformed JSON-LD and continue with visible HTML.
    }
  }
  const talentioProps = $("[data-react-props]").first().attr("data-react-props");
  if (talentioProps !== undefined) {
    try {
      const value = JSON.parse(talentioProps) as unknown;
      const page = isObject(value) && isObject(value.recruitmentOpenPage) ? value.recruitmentOpenPage : null;
      if (page !== null) return documentFromTalentioPage(page, sourceKind, sourceUrl);
    } catch {
      // Continue with visible HTML if the embedded prop contract changes.
    }
  }
  const title = cleanText($("h1").first().text())
    || cleanText($('meta[property="og:title"]').first().attr("content") ?? "")
    || cleanText($("title").first().text());
  if (title === "") throw new Error("Canonical Document requires a title");

  const sections: CanonicalDocumentSection[] = [];
  const seen = new Set<string>();
  const append = (kind: CanonicalSectionKind, heading: string | null, text: string, locator: Record<string, unknown>) => {
    const cleaned = cleanText(text);
    if (cleaned === "") return;
    for (const chunk of chunkText(cleaned)) {
      const textHash = sha256(chunk.text);
      const dedupKey = `${kind}\0${textHash}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      sections.push({ kind, heading: heading === null ? null : cleanText(heading), ordinal: sections.length,
        text: chunk.text, locator: { ...locator, sourceUrl, chunkIndex: chunk.index,
          charStart: chunk.start, charEnd: chunk.end }, textHash });
    }
  };

  append("title", "title", title, { kind: "css", selector: "h1, meta[property=og:title], title" });

  const visible = load(input);
  visible("script,style,noscript,nav,footer,header,svg").remove();
  const root = visible("main").first().length > 0 ? visible("main").first() : visible("body").first();
  const fullVisibleText = cleanText(root.text());

  root.find("section").each((index, element) => {
    const node = visible(element);
    const heading = cleanText(node.find("h2,h3").first().text());
    const sectionText = cleanText(node.text());
    if (sectionText.length < 2) return;
    append(classifySection(heading, sectionText), heading || null, sectionText,
      { kind: "css", selector: cssLocator(visible, element), sectionIndex: index, sourceKind });
  });

  root.find("h3").each((index, element) => {
    const headingNode = visible(element);
    const heading = cleanText(headingNode.text());
    const container = headingNode.parent();
    const sectionText = cleanText(container.text());
    const parentHeading = cleanText(container.closest("section").find("h2").first().text());
    if (sectionText.length < 2) return;
    append(classifySection(`${parentHeading} ${heading}`, sectionText), heading || null, sectionText,
      { kind: "css", selector: cssLocator(visible, container.get(0)), headingIndex: index, sourceKind });
  });

  root.find("dl").each((index, element) => {
    const node = visible(element);
    const heading = cleanText(node.find("dt").first().text());
    const value = cleanText(node.find("dd").first().text());
    const parentHeading = cleanText(node.closest("section").find("h2").first().text());
    if (value === "") return;
    const combinedHeading = `${parentHeading} ${heading}`.trim();
    const forcedOther = /会社情報|company\s+information/i.test(parentHeading) && /住所|address/i.test(heading);
    append(forcedOther ? "other" : classifySection(combinedHeading, value), heading || null, value,
      { kind: "css", selector: cssLocator(visible, element), rowIndex: index, sourceKind });
  });

  root.find(".job-info li,.jobInfo li,[class*=summary] li").each((index, element) => {
    const value = cleanText(visible(element).text());
    if (value === "") return;
    const kind = classifySection("", value);
    if (kind !== "other") append(kind, null, value,
      { kind: "css", selector: cssLocator(visible, element), summaryIndex: index, sourceKind });
  });

  const metaDates = ["datePublished", "article:published_time", "dateModified", "article:modified_time", "validThrough"]
    .flatMap((name) => {
      const value = $(`meta[name="${name}"],meta[property="${name}"]`).first().attr("content");
      return value === undefined || value.trim() === "" ? [] : [`${name}: ${value.trim()}`];
    });
  if (metaDates.length > 0) append("dates", "metadata", metaDates.join("\n"), { kind: "meta", sourceKind });

  if (sections.length === 1 && fullVisibleText !== "") {
    append("other", null, fullVisibleText, { kind: "css", selector: root.is("main") ? "main" : "body", sourceKind });
  }
  const fullText = cleanText([title, fullVisibleText].join("\n"));
  if (fullText.length < 20) throw new Error("Canonical Document has insufficient visible job content");
  return { title, fullText, sections };
}

function documentFromJson(input: unknown, sourceKind: SourceKind, sourceUrl: string) {
  const root = unwrapJobObject(input);
  const title = firstText(root, ["title", "name", "text", "jobTitle"]);
  if (title === "") throw new Error("Canonical JSON document requires a title");
  const sections: CanonicalDocumentSection[] = [];
  const seen = new Set<string>();
  const append = (kind: CanonicalSectionKind, heading: string | null, value: unknown, jsonPath: string) => {
    const text = valueText(value);
    if (text === "") return;
    for (const chunk of chunkText(text)) {
      const textHash = sha256(chunk.text);
      const key = `${kind}\0${textHash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sections.push({ kind, heading, ordinal: sections.length, text: chunk.text,
        locator: { kind: "json_path", path: jsonPath, sourceKind, sourceUrl, chunkIndex: chunk.index,
          charStart: chunk.start, charEnd: chunk.end }, textHash });
    }
  };
  append("title", "title", title, "$.title");

  const paths: Array<[CanonicalSectionKind, string, string[]]> = [
    ["employment", "employment", ["employmentType", "typeOfEmployment", "commitment", "employment_type"]],
    ["location", "location", ["location", "locations", "jobLocation", "workplace", "workLocation"]],
    ["compensation", "compensation", ["baseSalary", "salary", "compensation", "salaryRange"]],
    ["responsibilities", "responsibilities", ["responsibilities", "description", "descriptionHtml", "descriptionPlain", "content"]],
    ["required_requirements", "requirements", ["requirements", "qualifications", "minimumQualifications"]],
    ["preferred_requirements", "preferred", ["preferredQualifications", "preferredRequirements"]],
    ["skills", "skills", ["skills", "skill", "technologies"]],
    ["languages", "languages", ["languages", "languageRequirements"]],
    ["experience", "experience", ["experience", "experienceRequirements"]],
    ["dates", "dates", ["datePosted", "publishedAt", "published_at", "releasedDate", "updatedAt", "updated_at", "validThrough", "expiresAt"]],
  ];
  for (const [kind, heading, keys] of paths) {
    for (const key of keys) {
      const values = findKeyValues(root, key);
      for (const [index, value] of values.entries()) append(kind, kind === "dates" ? key : heading, value, `$..${key}[${index}]`);
    }
  }

  for (const [key, value] of Object.entries(root)) {
    const kind = classifySection(key, valueText(value));
    if (kind !== "other" && key !== "title" && key !== "name") append(kind, key, value, `$.${key}`);
  }

  for (const list of array(root.lists)) {
    if (!isObject(list)) continue;
    const heading = firstText(list, ["text", "title", "name"]);
    const content = list.content ?? list.items ?? list.values;
    append(classifySection(heading, valueText(content)), heading || null, content, "$.lists[*]");
  }

  const fullText = cleanText([title, ...sections.map((section) => section.text)].join("\n"));
  if (fullText.length < 20) throw new Error("Canonical JSON document has insufficient job content");
  return { title, fullText, sections };
}

export function classifySection(heading: string, text: string): CanonicalSectionKind {
  const label = cleanText(`${heading} ${text.slice(0, 120)}`);
  if (/会社情報|企業情報|company\s+information/i.test(heading)) return "other";
  if (/雇用形態|雇用区分|契約区分|\bemployment\b|type\s+of\s+employment/i.test(label)) return "employment";
  if (/勤務地|勤務場所|就業場所|住所|アクセス|location|workplace|work\s*location/i.test(label)) return "location";
  if (/給与|報酬|年収|月給|時給|日給|salary|compensation|pay\s+range/i.test(label)) return "compensation";
  if (/スキル|技術|skills?|technolog/i.test(heading)) return "skills";
  if (/言語|語学|日本語|英語|languages?|JLPT|TOEIC/i.test(heading)) return "languages";
  if (/経験|experience/i.test(heading)) return "experience";
  if (/歓迎|尚可|preferred|nice\s+to\s+have|歓迎要件/i.test(heading)) return "preferred_requirements";
  if (/必須|応募資格|応募条件|求める人材|必要条件|requirements?|qualifications?|must\s+have/i.test(heading)) return "required_requirements";
  if (/仕事内容|業務内容|職務内容|responsibilit|job\s+description|about\s+the\s+job/i.test(heading)) return "responsibilities";
  if (/掲載日|更新日|公開日|締切|date\s*(posted|published|modified)|valid\s*through/i.test(label)) return "dates";
  return "other";
}

function documentFromTalentioPage(page: Record<string, unknown>, sourceKind: SourceKind, sourceUrl: string) {
  const title = firstText(page, ["name", "title"]);
  const normalized: Record<string, unknown> = { title };
  const detailLists = [...array(page.requisitionDetails), ...array(page.jobDescriptionDetails)];
  for (const detail of detailLists) {
    if (!isObject(detail)) continue;
    const name = firstText(detail, ["name", "title"]);
    const value = detail.value ?? detail.content;
    if (name === "" || value === undefined) continue;
    normalized[name] = value;
  }
  return documentFromJson(normalized, sourceKind, sourceUrl);
}

function findJobPostingObject(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPostingObject(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isObject(value)) return null;
  const type = value["@type"];
  if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return value;
  const graph = value["@graph"];
  return graph === undefined ? null : findJobPostingObject(graph);
}

function cssLocator($: CheerioAPI, rawElement: unknown): string {
  if (rawElement === undefined || rawElement === null) return "unknown";
  const node = $(rawElement as never);
  const id = node.attr("id");
  if (id !== undefined && id !== "") return `#${cssEscape(id)}`;
  const tagName = String(node.prop("tagName") ?? "div").toLowerCase();
  const classes = (node.attr("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 2);
  const classSuffix = classes.map((value) => `.${cssEscape(value)}`).join("");
  const parent = node.parent();
  const sameTags = parent.children(tagName);
  const index = Math.max(0, sameTags.index(node));
  return `${tagName}${classSuffix}:nth-of-type(${index + 1})`;
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character.codePointAt(0)?.toString(16) ?? ""} `);
}

function unwrapJobObject(input: unknown): Record<string, unknown> {
  if (Array.isArray(input)) {
    const first = input.find(isObject);
    return first ?? {};
  }
  if (!isObject(input)) return {};
  for (const key of ["job", "jobPosting", "posting", "data"]) {
    const nested = input[key];
    if (isObject(nested) && firstText(nested, ["title", "name", "text", "jobTitle"]) !== "") return nested;
  }
  return input;
}

function findKeyValues(root: unknown, wanted: string, depth = 0): unknown[] {
  if (depth > 8 || root === null || typeof root !== "object") return [];
  if (Array.isArray(root)) return root.flatMap((value) => findKeyValues(value, wanted, depth + 1));
  const record = root as Record<string, unknown>;
  return Object.entries(record).flatMap(([key, value]) => [
    ...(key === wanted ? [value] : []),
    ...findKeyValues(value, wanted, depth + 1),
  ]);
}

function firstText(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const result = valueText(value[key]);
    if (result !== "") return result;
  }
  return "";
}

function valueText(value: unknown): string {
  if (typeof value === "string") return htmlText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return cleanText(value.map(valueText).filter(Boolean).join("\n"));
  if (isObject(value)) return cleanText(Object.entries(value).flatMap(([key, item]) => {
    const rendered = valueText(item);
    return rendered === "" ? [] : [`${key}: ${rendered}`];
  }).join("\n"));
  return "";
}

function htmlText(input: string): string {
  let markup = input;
  if (/&lt;\/?[a-z][^&]*&gt;/i.test(input)) {
    const decoded = load(`<main>${input}</main>`)("main").text();
    if (/<\/?[a-z][^>]*>/i.test(decoded)) markup = decoded;
  }
  if (!/<\/?[a-z][^>]*>/i.test(markup)) return cleanText(markup);
  const $ = load(`<main>${markup}</main>`);
  $("script,style,noscript,img,picture,source,video,audio,svg").remove();
  $("p,div,li,section,article,h1,h2,h3,h4,h5,h6,br").each((_, element) => { $(element).append("\n"); });
  return cleanText($("main").text());
}

function chunkText(value: string): Array<{ text: string; index: number; start: number; end: number }> {
  if (value.length <= MAX_SECTION_CHARS) return [{ text: value, index: 0, start: 0, end: value.length }];
  const chunks: Array<{ text: string; index: number; start: number; end: number }> = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + MAX_SECTION_CHARS);
    if (end < value.length) {
      const newline = value.lastIndexOf("\n", end);
      if (newline > start + MAX_SECTION_CHARS / 2) end = newline;
    }
    const raw = value.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const text = raw.trim();
    if (text !== "") chunks.push({ text, index: chunks.length, start: start + leading, end: end - trailing });
    start = end < value.length && value[end] === "\n" ? end + 1 : end;
  }
  return chunks;
}

function cleanText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n").trim();
}

function array(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
