import { sql, type SQL } from "drizzle-orm";
import { ensureDb, getDb } from "@/db";
import { orderResultHistory, orders } from "@/db/schema";
import type { AgentResult } from "@/lib/demo-engine";

type HistoryReason =
  | "Первое решение"
  | "Ответ клиента учтён"
  | "Склад перечитан"
  | "Поставщик перечитан"
  | "Поставщик и склад перечитаны"
  | "Решение рабочей модели"
  | "Вариант руководителя подтверждён"
  | "Карточка продолжила работу";

function resultRoute(result: AgentResult) {
  if (result.route) return result.route;
  if (result.zone === "red") return "manager";
  if (result.zone === "yellow") return "needs_info";
  return "ready";
}

type ResultHistoryInput = {
  orderId: string;
  roundNo: number;
  result: AgentResult;
  status: string;
  reason: HistoryReason;
  sourceKey: string;
  inventorySnapshot?: unknown;
  agentModel?: string | null;
  reviewerModel?: string | null;
};

function resultHistoryValues({
  orderId,
  roundNo,
  result,
  status,
  reason,
  sourceKey,
  inventorySnapshot,
  agentModel,
  reviewerModel,
}: ResultHistoryInput) {
  return {
    orderId,
    roundNo,
    zone: result.zone,
    route: resultRoute(result),
    status,
    reason,
    replySubject: result.reply.subject,
    replyBody: result.reply.body,
    zoneReason: result.zoneReason,
    optionsJson: JSON.stringify(result.options),
    resultJson: JSON.stringify(result),
    inventorySnapshotJson:
      inventorySnapshot === undefined
        ? null
        : typeof inventorySnapshot === "string"
          ? inventorySnapshot
          : JSON.stringify(inventorySnapshot),
    agentModel: agentModel?.slice(0, 120) || null,
    reviewerModel: reviewerModel?.slice(0, 120) || null,
    sourceKey: sourceKey.slice(0, 180),
  };
}

export function insertResultHistoryWhen(
  db: ReturnType<typeof getDb>,
  input: ResultHistoryInput,
  condition: SQL,
) {
  const values = resultHistoryValues(input);
  return db
    .insert(orderResultHistory)
    .select(
      db
        .select({
          id: sql<number>`null`.as("id"),
          orderId: sql<string>`${values.orderId}`.as("order_id"),
          roundNo: sql<number>`${values.roundNo}`.as("round_no"),
          zone: sql<string>`${values.zone}`.as("zone"),
          route: sql<string>`${values.route}`.as("route"),
          status: sql<string>`${values.status}`.as("status"),
          reason: sql<string>`${values.reason}`.as("reason"),
          replySubject: sql<string>`${values.replySubject}`.as("reply_subject"),
          replyBody: sql<string>`${values.replyBody}`.as("reply_body"),
          zoneReason: sql<string>`${values.zoneReason}`.as("zone_reason"),
          optionsJson: sql<string>`${values.optionsJson}`.as("options_json"),
          resultJson: sql<string>`${values.resultJson}`.as("result_json"),
          inventorySnapshotJson:
            sql<string | null>`${values.inventorySnapshotJson}`.as(
              "inventory_snapshot_json",
            ),
          agentModel: sql<string | null>`${values.agentModel}`.as("agent_model"),
          reviewerModel: sql<string | null>`${values.reviewerModel}`.as(
            "reviewer_model",
          ),
          sourceKey: sql<string>`${values.sourceKey}`.as("source_key"),
          createdAt: sql<string>`CURRENT_TIMESTAMP`.as("created_at"),
        })
        .from(orders)
        .where(condition),
    )
    .onConflictDoNothing({
      target: [orderResultHistory.orderId, orderResultHistory.sourceKey],
    });
}

export async function appendResultHistory(input: ResultHistoryInput) {
  await ensureDb();
  await getDb()
    .insert(orderResultHistory)
    .values(resultHistoryValues(input))
    .onConflictDoNothing({
      target: [orderResultHistory.orderId, orderResultHistory.sourceKey],
    });
}
