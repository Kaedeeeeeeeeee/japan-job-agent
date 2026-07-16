import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { CanonicalDocument, CanonicalDocumentSection } from "../../contracts/src/index.js";
import type { OutboxDatabase } from "../../db/src/outbox.js";

interface DocumentRow {
  id: string;
  content_hash: string;
}

interface SectionRow {
  id: string;
  section_kind: CanonicalDocumentSection["kind"];
  heading: string | null;
  ordinal: number;
  section_text: string;
  locator: Record<string, unknown>;
  text_hash: string;
}

export class CanonicalDocumentService {
  constructor(private readonly db: Kysely<OutboxDatabase>) {}

  async materialize(document: CanonicalDocument): Promise<CanonicalDocument> {
    const documentId = randomUUID();
    const persistedId = await this.db.transaction().execute(async (trx) => {
      const inserted = await sql<{ id: string }>`INSERT INTO canonical_documents(
          id,source_job_version_id,adapter_key,adapter_version,title,full_text,content_hash
        ) VALUES (
          ${documentId}::uuid,${document.sourceJobVersionId}::uuid,${document.adapterKey},${document.adapterVersion},
          ${document.title},${document.fullText},${document.contentHash}
        ) ON CONFLICT(source_job_version_id,adapter_key,adapter_version) DO NOTHING RETURNING id`.execute(trx);
      if (inserted.rows[0] === undefined) {
        const existing = await sql<DocumentRow>`SELECT id,content_hash FROM canonical_documents
          WHERE source_job_version_id=${document.sourceJobVersionId}::uuid
            AND adapter_key=${document.adapterKey} AND adapter_version=${document.adapterVersion}`.execute(trx);
        const row = existing.rows[0];
        if (row === undefined) throw new Error("Canonical Document disappeared after idempotent insert");
        if (row.content_hash !== document.contentHash) {
          throw new Error(`Canonical Document drift for ${document.sourceJobVersionId} at ${document.adapterVersion}`);
        }
        return row.id;
      }
      for (const section of document.sections) {
        await sql`INSERT INTO canonical_document_sections(
            id,canonical_document_id,section_kind,heading,ordinal,section_text,locator,text_hash
          ) VALUES (
            ${randomUUID()}::uuid,${documentId}::uuid,${section.kind},${section.heading},${section.ordinal},
            ${section.text},${JSON.stringify(section.locator)}::jsonb,${section.textHash}
          )`.execute(trx);
      }
      return documentId;
    });
    return this.load(persistedId);
  }

  async load(documentId: string): Promise<CanonicalDocument> {
    const result = await sql<{
      id: string;
      source_job_version_id: string;
      adapter_key: string;
      adapter_version: string;
      title: string;
      full_text: string;
      content_hash: string;
    }>`SELECT id,source_job_version_id,adapter_key,adapter_version,title,full_text,content_hash
      FROM canonical_documents WHERE id=${documentId}::uuid`.execute(this.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Canonical Document ${documentId} does not exist`);
    const sections = await sql<SectionRow>`SELECT id,section_kind,heading,ordinal,section_text,locator,text_hash
      FROM canonical_document_sections WHERE canonical_document_id=${documentId}::uuid ORDER BY ordinal`.execute(this.db);
    return {
      id: row.id,
      sourceJobVersionId: row.source_job_version_id,
      adapterKey: row.adapter_key,
      adapterVersion: row.adapter_version,
      title: row.title,
      fullText: row.full_text,
      contentHash: row.content_hash,
      sections: sections.rows.map((section) => ({
        id: section.id,
        kind: section.section_kind,
        heading: section.heading,
        ordinal: section.ordinal,
        text: section.section_text,
        locator: section.locator,
        textHash: section.text_hash,
      })),
    };
  }
}
