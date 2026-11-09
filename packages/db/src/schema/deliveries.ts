import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Durable local deliveries. Successful rows remain as deduplication receipts. */
export const deliveries = pgTable(
  "deliveries",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("deliveries_available_idx").on(t.completedAt, t.availableAt)],
);
