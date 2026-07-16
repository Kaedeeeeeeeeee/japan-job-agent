import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DiscoveryPage } from "../packages/contracts/src/index.js";
import type { OutboxDatabase } from "../packages/db/src/outbox.js";
import { importJetroOfpPages, parseJetroOfpPage } from "../packages/discovery/src/jetro-ofp.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("DATABASE_URL is required");
const fetchedAt = new Date().toISOString();
const pages: DiscoveryPage[] = [];
let pageNumber: number | null = 1;

while (pageNumber !== null) {
  const url = new URL("https://www.jetro.go.jp/hrportal/company.html");
  url.searchParams.set("page", String(pageNumber));
  url.searchParams.set("region", "all");
  const response = await fetch(url, {
    headers: { accept: "text/html", "user-agent": "JapanJobAgent/0.2 (+private personal use)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`JETRO OFP returned ${response.status} for page ${pageNumber}`);
  const parsed = parseJetroOfpPage(await response.text(), url.toString(), pageNumber, fetchedAt);
  if (parsed.candidates.length === 0) throw new Error(`JETRO OFP page ${pageNumber} returned no companies`);
  pages.push(parsed);
  pageNumber = parsed.nextPage;
}

const expected = pages[0]?.providerTotal;
const count = pages.reduce((sum, page) => sum + page.candidates.length, 0);
if (expected !== undefined && expected !== count) throw new Error(`JETRO OFP total mismatch: expected ${expected}, parsed ${count}`);

const { Pool } = pg;
const db = new Kysely<OutboxDatabase>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }) });
try {
  const key = process.env.DISCOVERY_INVOCATION_KEY ?? `jetro-ofp:${fetchedAt.slice(0, 10)}`;
  const result = await importJetroOfpPages(db, pages, key);
  process.stdout.write(`${JSON.stringify({ ...result, pages: pages.length, providerTotal: expected ?? null })}\n`);
} finally {
  await db.destroy();
}

