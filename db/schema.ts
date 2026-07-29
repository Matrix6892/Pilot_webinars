import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  company: text("company").notNull().default(""),
  website: text("website").notNull().default(""),
  status: text("status").notNull().default("queued"),
  zone: text("zone"),
  mode: text("mode").notNull().default("demo"),
  resultJson: text("result_json"),
  actionTokenHash: text("action_token_hash"),
  managerDecision: text("manager_decision"),
  agentModel: text("agent_model"),
  reviewerModel: text("reviewer_model"),
  requestedModel: text("requested_model"),
  attachmentJson: text("attachment_json"),
  conversationJson: text("conversation_json"),
  roundNo: integer("round_no").notNull().default(1),
  inventorySnapshotJson: text("inventory_snapshot_json"),
  managerOptionId: text("manager_option_id"),
  managerDecidedAt: text("manager_decided_at"),
  sentAt: text("sent_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const orderEvents = sqliteTable("order_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: text("order_id").notNull(),
  stage: text("stage").notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull().default(""),
  state: text("state").notNull().default("done"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const orderResultHistory = sqliteTable(
  "order_result_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: text("order_id").notNull(),
    roundNo: integer("round_no").notNull().default(1),
    zone: text("zone").notNull(),
    route: text("route").notNull(),
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    replySubject: text("reply_subject").notNull().default(""),
    replyBody: text("reply_body").notNull().default(""),
    zoneReason: text("zone_reason").notNull().default(""),
    optionsJson: text("options_json").notNull().default("[]"),
    resultJson: text("result_json").notNull().default("{}"),
    inventorySnapshotJson: text("inventory_snapshot_json"),
    agentModel: text("agent_model"),
    reviewerModel: text("reviewer_model"),
    sourceKey: text("source_key"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("order_result_history_order_id_idx").on(table.orderId),
    index("order_result_history_created_at_idx").on(table.createdAt),
    uniqueIndex("order_result_history_source_key_idx").on(
      table.orderId,
      table.sourceKey,
    ),
  ],
);

export const systemState = sqliteTable("system_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const inventoryItems = sqliteTable(
  "inventory_items",
  {
    sku: text("sku").primaryKey(),
    stockKg: integer("stock_kg").notNull(),
    revision: integer("revision").notNull().default(1),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("inventory_items_stock_kg_check", sql`${table.stockKg} >= 0`),
    check("inventory_items_revision_check", sql`${table.revision} >= 1`),
  ],
);

export const inventoryChanges = sqliteTable(
  "inventory_changes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sku: text("sku").notNull(),
    revision: integer("revision").notNull(),
    beforeStockKg: integer("before_stock_kg").notNull(),
    afterStockKg: integer("after_stock_kg").notNull(),
    reason: text("reason").notNull(),
    actor: text("actor").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("inventory_changes_revision_check", sql`${table.revision} >= 1`),
    check(
      "inventory_changes_before_stock_kg_check",
      sql`${table.beforeStockKg} >= 0`,
    ),
    check(
      "inventory_changes_after_stock_kg_check",
      sql`${table.afterStockKg} >= 0`,
    ),
    uniqueIndex("inventory_changes_sku_revision_idx").on(
      table.sku,
      table.revision,
    ),
    index("inventory_changes_created_at_idx").on(table.createdAt),
  ],
);
