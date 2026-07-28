import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}

export async function ensureDb() {
  if (!env.DB) {
    throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  }

  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        company TEXT NOT NULL DEFAULT '',
        website TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        zone TEXT,
        mode TEXT NOT NULL DEFAULT 'demo',
        result_json TEXT,
        manager_decision TEXT,
        agent_model TEXT,
        reviewer_model TEXT,
        requested_model TEXT,
        sent_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS order_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        order_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'done',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS order_events_order_id_idx ON order_events (order_id)",
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS orders_status_created_at_idx ON orders (status, created_at)",
    ),
  ]);

  const columns = await env.DB.prepare("PRAGMA table_info(orders)").all<{
    name: string;
  }>();
  const names = new Set(columns.results.map((column) => column.name));
  const additions: D1PreparedStatement[] = [];
  if (!names.has("requested_model")) {
    additions.push(
      env.DB.prepare("ALTER TABLE orders ADD COLUMN requested_model TEXT"),
    );
  }
  if (!names.has("sent_at")) {
    additions.push(env.DB.prepare("ALTER TABLE orders ADD COLUMN sent_at TEXT"));
  }
  if (additions.length) await env.DB.batch(additions);
}
