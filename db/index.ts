import { env } from "cloudflare:workers";
import { sql, type SQL } from "drizzle-orm";
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

type ConditionalOrderEvent = {
  orderId: string;
  stage: string;
  title: string;
  detail?: string;
  state?: string;
  createdAt?: string;
};

export function insertOrderEventWhen(
  db: ReturnType<typeof getDb>,
  event: ConditionalOrderEvent,
  condition: SQL,
) {
  return db.insert(schema.orderEvents).select(
    db
      .select({
        id: sql<number>`null`.as("id"),
        orderId: sql<string>`${event.orderId}`.as("order_id"),
        stage: sql<string>`${event.stage}`.as("stage"),
        title: sql<string>`${event.title}`.as("title"),
        detail: sql<string>`${event.detail ?? ""}`.as("detail"),
        state: sql<string>`${event.state ?? "done"}`.as("state"),
        createdAt: event.createdAt
          ? sql<string>`${event.createdAt}`.as("created_at")
          : sql<string>`CURRENT_TIMESTAMP`.as("created_at"),
      })
      .from(schema.orders)
      .where(condition),
  );
}

let ensureDbPromise: Promise<void> | null = null;

async function initializeDb() {
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
        action_token_hash TEXT,
        manager_decision TEXT,
        agent_model TEXT,
        reviewer_model TEXT,
        requested_model TEXT,
        attachment_json TEXT,
        conversation_json TEXT,
        round_no INTEGER NOT NULL DEFAULT 1,
        inventory_snapshot_json TEXT,
        manager_option_id TEXT,
        manager_decided_at TEXT,
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
      CREATE TABLE IF NOT EXISTS order_result_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        order_id TEXT NOT NULL,
        round_no INTEGER NOT NULL DEFAULT 1,
        zone TEXT NOT NULL,
        route TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        reply_subject TEXT NOT NULL DEFAULT '',
        reply_body TEXT NOT NULL DEFAULT '',
        zone_reason TEXT NOT NULL DEFAULT '',
        options_json TEXT NOT NULL DEFAULT '[]',
        result_json TEXT NOT NULL DEFAULT '{}',
        inventory_snapshot_json TEXT,
        agent_model TEXT,
        reviewer_model TEXT,
        source_key TEXT,
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
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS inventory_items (
        sku TEXT PRIMARY KEY NOT NULL,
        stock_kg INTEGER NOT NULL CHECK (stock_kg >= 0),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS inventory_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        sku TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        before_stock_kg INTEGER NOT NULL CHECK (before_stock_kg >= 0),
        after_stock_kg INTEGER NOT NULL CHECK (after_stock_kg >= 0),
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS order_events_order_id_idx ON order_events (order_id)",
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS orders_status_created_at_idx ON orders (status, created_at)",
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS order_result_history_order_id_idx ON order_result_history (order_id)",
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS order_result_history_created_at_idx ON order_result_history (created_at)",
    ),
    env.DB.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS inventory_changes_sku_revision_idx ON inventory_changes (sku, revision)",
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS inventory_changes_created_at_idx ON inventory_changes (created_at)",
    ),
    env.DB.prepare(`
      INSERT OR IGNORE INTO inventory_items (sku, stock_kg, revision)
      VALUES
        ('КР-001', 300, 1),
        ('КР-002', 900, 1),
        ('КР-003', 420, 1),
        ('КР-004', 1260, 1),
        ('КР-005', 180, 1)
    `),
  ]);

  const columns = await env.DB.prepare("PRAGMA table_info(orders)").all<{
    name: string;
  }>();
  const names = new Set(columns.results.map((column) => column.name));
  const additions: Array<{ name: string; statement: D1PreparedStatement }> = [];
  if (!names.has("action_token_hash")) {
    additions.push({
      name: "action_token_hash",
      statement: env.DB.prepare(
        "ALTER TABLE orders ADD COLUMN action_token_hash TEXT",
      ),
    });
  }
  if (!names.has("requested_model")) {
    additions.push({
      name: "requested_model",
      statement: env.DB.prepare(
        "ALTER TABLE orders ADD COLUMN requested_model TEXT",
      ),
    });
  }
  if (!names.has("sent_at")) {
    additions.push({
      name: "sent_at",
      statement: env.DB.prepare("ALTER TABLE orders ADD COLUMN sent_at TEXT"),
    });
  }
  if (!names.has("attachment_json")) {
    additions.push({
      name: "attachment_json",
      statement: env.DB.prepare(
        "ALTER TABLE orders ADD COLUMN attachment_json TEXT",
      ),
    });
  }
  if (!names.has("conversation_json")) {
    additions.push({
      name: "conversation_json",
      statement: env.DB.prepare(
        "ALTER TABLE orders ADD COLUMN conversation_json TEXT",
      ),
    });
  }
  if (!names.has("round_no")) {
    additions.push({
      name: "round_no",
      statement: env.DB.prepare(
        "ALTER TABLE orders ADD COLUMN round_no INTEGER NOT NULL DEFAULT 1",
      ),
    });
  }
  if (!names.has("inventory_snapshot_json")) {
    additions.push({
      name: "inventory_snapshot_json",
      statement: env.DB.prepare(
        "ALTER TABLE orders ADD COLUMN inventory_snapshot_json TEXT",
      ),
    });
  }
  if (!names.has("manager_option_id")) {
    additions.push({
      name: "manager_option_id",
      statement: env.DB.prepare(
        "ALTER TABLE orders ADD COLUMN manager_option_id TEXT",
      ),
    });
  }
  if (!names.has("manager_decided_at")) {
    additions.push({
      name: "manager_decided_at",
      statement: env.DB.prepare(
        "ALTER TABLE orders ADD COLUMN manager_decided_at TEXT",
      ),
    });
  }

  for (const addition of additions) {
    try {
      await addition.statement.run();
    } catch (error) {
      const refreshed = await env.DB.prepare("PRAGMA table_info(orders)").all<{
        name: string;
      }>();
      if (!refreshed.results.some((column) => column.name === addition.name)) {
        throw error;
      }
    }
  }

  const historyColumns = await env.DB.prepare(
    "PRAGMA table_info(order_result_history)",
  ).all<{ name: string }>();
  const historyNames = new Set(
    historyColumns.results.map((column) => column.name),
  );
  const historyAdditions: Array<{
    name: string;
    statement: D1PreparedStatement;
  }> = [
    {
      name: "result_json",
      statement: env.DB.prepare(
        "ALTER TABLE order_result_history ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}'",
      ),
    },
    {
      name: "inventory_snapshot_json",
      statement: env.DB.prepare(
        "ALTER TABLE order_result_history ADD COLUMN inventory_snapshot_json TEXT",
      ),
    },
    {
      name: "agent_model",
      statement: env.DB.prepare(
        "ALTER TABLE order_result_history ADD COLUMN agent_model TEXT",
      ),
    },
    {
      name: "reviewer_model",
      statement: env.DB.prepare(
        "ALTER TABLE order_result_history ADD COLUMN reviewer_model TEXT",
      ),
    },
    {
      name: "source_key",
      statement: env.DB.prepare(
        "ALTER TABLE order_result_history ADD COLUMN source_key TEXT",
      ),
    },
  ].filter((addition) => !historyNames.has(addition.name));

  for (const addition of historyAdditions) {
    try {
      await addition.statement.run();
    } catch (error) {
      const refreshed = await env.DB.prepare(
        "PRAGMA table_info(order_result_history)",
      ).all<{ name: string }>();
      if (!refreshed.results.some((column) => column.name === addition.name)) {
        throw error;
      }
    }
  }

  await env.DB.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS order_result_history_source_key_idx ON order_result_history (order_id, source_key)",
  ).run();
}

export function ensureDb() {
  if (!env.DB) {
    return Promise.reject(
      new Error("Cloudflare D1 binding `DB` is unavailable."),
    );
  }
  if (!ensureDbPromise) {
    ensureDbPromise = initializeDb().catch((error) => {
      ensureDbPromise = null;
      throw error;
    });
  }
  return ensureDbPromise;
}
