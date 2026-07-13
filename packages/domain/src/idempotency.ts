import { createHash, randomUUID } from "node:crypto";
import type { ExtractionCandidate, JobParser, ParserContext, SourceJobVersion } from "../../contracts/src/index.js";

export interface StoredRawVersion extends SourceJobVersion {}

export interface StoredExtraction {
  id: string;
  sourceJobVersionId: string;
  parserKey: string;
  parserVersion: string;
  schemaVersion: string;
  extractionHash: string;
  candidate: ExtractionCandidate;
}

export class VersionStore {
  readonly rawVersions: StoredRawVersion[] = [];
  readonly extractions: StoredExtraction[] = [];

  putRaw(version: StoredRawVersion): StoredRawVersion {
    const existing = this.rawVersions.find(
      (item) => item.sourceJobRecordId === version.sourceJobRecordId && item.rawHash === version.rawHash,
    );
    if (existing !== undefined) return existing;
    this.rawVersions.push(version);
    return version;
  }

  async extract(
    version: StoredRawVersion,
    parser: JobParser,
    context: ParserContext,
  ): Promise<StoredExtraction> {
    const existing = this.extractions.find((item) =>
      item.sourceJobVersionId === version.id
      && item.parserKey === parser.parserKey
      && item.parserVersion === parser.parserVersion
      && item.schemaVersion === parser.schemaVersion,
    );
    if (existing !== undefined) return existing;
    const candidate = await parser.parse(version, context);
    const extractionHash = createHash("sha256").update(stableJson(candidate)).digest("hex");
    const stored: StoredExtraction = {
      id: randomUUID(),
      sourceJobVersionId: version.id,
      parserKey: parser.parserKey,
      parserVersion: parser.parserVersion,
      schemaVersion: parser.schemaVersion,
      extractionHash,
      candidate,
    };
    this.extractions.push(stored);
    return stored;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(
      ([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

