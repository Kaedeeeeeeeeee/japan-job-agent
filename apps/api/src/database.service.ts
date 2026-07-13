import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import pg, { type QueryResultRow } from "pg";

const { Pool } = pg;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool = new Pool({ connectionString: requiredDatabaseUrl() });

  query<T extends QueryResultRow>(text: string, values: readonly unknown[] = []) {
    return this.pool.query<T>(text, [...values]);
  }

  async transaction<T>(operation: (query: DatabaseService["query"]) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const query: DatabaseService["query"] = (text, values = []) => client.query(text, [...values]);
      const result = await operation(query);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (value === undefined) throw new Error("DATABASE_URL is required for the API");
  return value;
}

