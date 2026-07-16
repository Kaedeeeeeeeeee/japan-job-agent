import { sql, type Kysely } from "kysely";
import type { AiFactCandidate, EnrichableJobField } from "../../contracts/src/index.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";
import type { AiProvider, RetrievedSection } from "./ai-provider.js";

interface SectionRow {
  id: string;
  canonical_document_id: string;
  section_kind: string;
  heading: string | null;
  section_text: string;
  ordinal: number;
}

const FIELD_KINDS: Record<EnrichableJobField, string[]> = {
  employmentTypes: ["title", "employment"],
  locations: ["location"],
  compensation: ["compensation"],
  skills: ["skills", "required_requirements", "preferred_requirements"],
  languages: ["languages", "required_requirements", "preferred_requirements"],
  experienceRequirements: ["experience", "required_requirements", "preferred_requirements"],
};
const FIELD_KEYWORDS: Record<EnrichableJobField, string[]> = {
  employmentTypes: ["雇用形態", "正社員", "契約社員", "employment", "full-time"],
  locations: ["勤務地", "勤務場所", "住所", "リモート", "location", "remote"],
  compensation: ["給与", "年収", "月給", "時給", "salary", "compensation"],
  skills: ["スキル", "必須", "歓迎", "skill", "requirements"],
  languages: ["日本語", "英語", "JLPT", "TOEIC", "language", "Japanese", "English"],
  experienceRequirements: ["経験", "年以上", "experience", "years"],
};

export class JobLocalRag {
  constructor(
    private readonly db: Kysely<OutboxDatabase>,
    private readonly provider?: AiProvider,
  ) {}

  async retrieve(sourceJobVersionId: string, fields: readonly EnrichableJobField[], limitPerField = 4): Promise<{
    documentId: string;
    title: string;
    sections: RetrievedSection[];
  }> {
    const documentResult = await sql<{ id: string; title: string }>`SELECT id,title FROM canonical_documents
      WHERE source_job_version_id=${sourceJobVersionId}::uuid ORDER BY created_at DESC,id DESC LIMIT 1`.execute(this.db);
    const document = documentResult.rows[0];
    if (document === undefined) throw new Error(`Canonical Document for ${sourceJobVersionId} does not exist`);
    const rows = await sql<SectionRow>`SELECT id,canonical_document_id,section_kind,heading,section_text,ordinal
      FROM canonical_document_sections WHERE canonical_document_id=${document.id}::uuid ORDER BY ordinal`.execute(this.db);
    const selected = new Map<string, SectionRow>();
    for (const field of fields) {
      for (const row of rankSections(rows.rows, field).slice(0, limitPerField)) selected.set(row.id, row);
    }
    if (selected.size === 0 && this.provider !== undefined && rows.rows.length > 0) {
      const query = fields.flatMap((field) => FIELD_KEYWORDS[field]).join(" ");
      const embedding = (await this.provider.embed([query])).vectors[0];
      if (embedding !== undefined) {
        const vector = vectorLiteral(embedding);
        const semantic = await sql<SectionRow>`SELECT section.id,section.canonical_document_id,section.section_kind,
          section.heading,section.section_text,section.ordinal
          FROM canonical_document_section_embeddings embedded
          JOIN canonical_document_sections section ON section.id=embedded.canonical_document_section_id
          WHERE section.canonical_document_id=${document.id}::uuid
            AND embedded.model_key=${this.provider.embeddingModelKey}
            AND embedded.dimensions=${embedding.length}
          ORDER BY embedded.embedding <=> ${vector}::vector LIMIT ${Math.max(1, limitPerField * fields.length)}`.execute(this.db);
        for (const row of semantic.rows) selected.set(row.id, row);
      }
    }
    return { documentId: document.id, title: document.title, sections: [...selected.values()]
      .sort((left, right) => left.ordinal - right.ordinal).slice(0, 8).map((row) => ({
        id: row.id, kind: row.section_kind, heading: row.heading, text: row.section_text,
      })) };
  }
}

export function rankSections(rows: readonly SectionRow[], field: EnrichableJobField): SectionRow[] {
  const kinds = new Set(FIELD_KINDS[field]);
  const keywords = FIELD_KEYWORDS[field];
  return rows.map((row) => ({ row, score: (kinds.has(row.section_kind) ? 100 : 0)
    + keywords.reduce((score, keyword) => score + (includesFolded(`${row.heading ?? ""}\n${row.section_text}`, keyword) ? 10 : 0), 0) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.row.ordinal - right.row.ordinal)
    .map(({ row }) => row);
}

export function validateFactCandidates(
  candidates: readonly AiFactCandidate[],
  sections: readonly RetrievedSection[],
  requestedFields: readonly EnrichableJobField[],
): AiFactCandidate[] {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const fields = new Set(requestedFields);
  const output: AiFactCandidate[] = [];
  for (const candidate of candidates) {
    if (!fields.has(candidate.field)) throw new Error(`AI candidate attempted to overwrite non-requested field ${candidate.field}`);
    const section = byId.get(candidate.sectionId);
    if (section === undefined) throw new Error(`AI candidate referenced a section outside the current Raw Version: ${candidate.sectionId}`);
    if (!section.text.includes(candidate.quote)) throw new Error(`AI candidate quote is not in section ${candidate.sectionId}`);
    if (!candidate.quote.includes(candidate.rawValue) && !candidate.rawValue.includes(candidate.quote)) {
      throw new Error(`AI candidate rawValue is not supported by its quote for ${candidate.field}`);
    }
    output.push(candidate);
  }
  return output;
}

function includesFolded(value: string, keyword: string): boolean {
  return value.toLocaleLowerCase("ja").includes(keyword.toLocaleLowerCase("ja"));
}

export function vectorLiteral(vector: readonly number[]): string {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) throw new Error("Invalid embedding vector");
  return `[${vector.join(",")}]`;
}
