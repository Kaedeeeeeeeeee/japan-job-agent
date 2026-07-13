import type { Kysely, Transaction } from "kysely";

export interface OutboxDatabase {
  outbox_events: {
    id: string;
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    payload: unknown;
    dedup_key: string;
    available_at: Date;
    locked_at: Date | null;
    lock_owner: string | null;
    attempt_count: number;
    last_error: string | null;
    published_at: Date | null;
    created_at: Date;
  };
  processed_outbox_events: {
    consumer_name: string;
    event_id: string;
    processed_at: Date;
  };
}

export async function claimOutboxEvents(
  db: Kysely<OutboxDatabase>,
  workerId: string,
  limit: number,
): Promise<OutboxDatabase["outbox_events"][]> {
  return db.transaction().execute(async (trx) => {
    const events = await trx.selectFrom("outbox_events")
      .selectAll()
      .where("published_at", "is", null)
      .where("available_at", "<=", new Date())
      .where((eb) => eb.or([
        eb("locked_at", "is", null),
        eb("locked_at", "<", new Date(Date.now() - 5 * 60_000)),
      ]))
      .orderBy("created_at", "asc")
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
    if (events.length === 0) return [];
    const ids = events.map((event) => event.id);
    const lockedAt = new Date();
    await trx.updateTable("outbox_events")
      .set({ locked_at: lockedAt, lock_owner: workerId, attempt_count: (eb) => eb("attempt_count", "+", 1) })
      .where("id", "in", ids)
      .execute();
    return events.map((event) => ({ ...event, locked_at: lockedAt, lock_owner: workerId }));
  });
}

export async function consumeOnce(
  trx: Transaction<OutboxDatabase>,
  consumerName: string,
  eventId: string,
  effect: () => Promise<void>,
): Promise<boolean> {
  const inserted = await trx.insertInto("processed_outbox_events")
    .values({ consumer_name: consumerName, event_id: eventId, processed_at: new Date() })
    .onConflict((oc) => oc.columns(["consumer_name", "event_id"]).doNothing())
    .returning("event_id")
    .executeTakeFirst();
  if (inserted === undefined) return false;
  await effect();
  return true;
}

