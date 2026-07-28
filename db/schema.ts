import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  managerDecision: text("manager_decision"),
  agentModel: text("agent_model"),
  reviewerModel: text("reviewer_model"),
  requestedModel: text("requested_model"),
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

export const systemState = sqliteTable("system_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
