import { and, asc, eq, lt, sql } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { ensureDb, getDb, insertOrderEventWhen } from "@/db";
import { orderEvents, orders, systemState } from "@/db/schema";
import type { AgentResult } from "@/lib/demo-engine";
import { isCompleteAgentResult } from "@/lib/agent-guard.mjs";
import { insertResultHistoryWhen } from "@/lib/result-history";

export const dynamic = "force-dynamic";

function resultStatus(result: AgentResult) {
  if (result.route === "manager") return "awaiting_approval";
  if (result.route === "needs_info") return "clarification_ready";
  return "ready_to_send";
}

function resultRoute(result: AgentResult | null) {
  if (!result) return "";
  if (result.route) return result.route;
  if (result.zone === "red") return "manager";
  if (result.zone === "yellow") return "needs_info";
  return "ready";
}

function storedResult(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as AgentResult;
  } catch {
    return null;
  }
}

function expectedToken() {
  return (env as unknown as { BRIDGE_TOKEN?: string }).BRIDGE_TOKEN?.trim() ?? "";
}

function authorized(request: Request) {
  const token = expectedToken();
  return Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`;
}

function denied() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  await ensureDb();
  const db = getDb();
  const requeued = await db
    .update(orders)
    .set({ status: "queued", updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(
      and(
        eq(orders.status, "processing"),
        lt(orders.updatedAt, sql`datetime('now', '-6 minutes')`),
      ),
    )
    .returning({ id: orders.id });
  if (requeued.length > 0) {
    await db.insert(orderEvents).values(
      requeued.map((item) => ({
        orderId: item.id,
        stage: "retry",
        title: "Карточка вернулась в очередь",
        detail:
          "Предыдущий запуск остановился. Письмо и история сохранены, обработка продолжится с теми же данными.",
      })),
    );
  }
  const [job] = await db
    .select()
    .from(orders)
    .where(eq(orders.status, "queued"))
    .orderBy(asc(orders.createdAt))
    .limit(1);

  if (!job) return Response.json({ job: null });

  const [claimedJob] = await db
    .update(orders)
    .set({ status: "processing", updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(and(eq(orders.id, job.id), eq(orders.status, "queued")))
    .returning();
  if (!claimedJob) return Response.json({ job: null });

  await db.insert(orderEvents).values({
    orderId: claimedJob.id,
    stage: "understanding",
    title: "Модель для заказов разбирает письмо",
    detail:
      "Агент собирает задачу клиента, выбирает источники и читает снимок склада этой карточки.",
    state: "active",
  });

  return Response.json({ job: claimedJob });
}

export async function POST(request: Request) {
  if (!authorized(request)) return denied();
  await ensureDb();
  const payload = (await request.json()) as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action : "";
  const db = getDb();

  if (action === "heartbeat") {
    const now = new Date().toISOString();
    await db
      .insert(systemState)
      .values({ key: "bridge-heartbeat", value: now, updatedAt: now })
      .onConflictDoUpdate({
        target: systemState.key,
        set: { value: now, updatedAt: now },
      });
    return Response.json({ ok: true, now });
  }

  const orderId = typeof payload.orderId === "string" ? payload.orderId : "";
  if (!orderId) {
    return Response.json({ error: "orderId is required" }, { status: 400 });
  }

  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      mode: orders.mode,
      roundNo: orders.roundNo,
      resultJson: orders.resultJson,
      inventorySnapshotJson: orders.inventorySnapshotJson,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) {
    return Response.json({ error: "order not found" }, { status: 404 });
  }
  if (order.status !== "processing") {
    return Response.json(
      { error: "order is not processing" },
      { status: 409 },
    );
  }

  if (action === "event") {
    await db.insert(orderEvents).values({
      orderId,
      stage: String(payload.stage ?? "agent"),
      title: String(payload.title ?? "Шаг агента").slice(0, 180),
      detail: String(payload.detail ?? "").slice(0, 1200),
      state: String(payload.state ?? "done").slice(0, 40),
    });
    return Response.json({ ok: true });
  }

  if (action === "result") {
    const result = payload.result;
    if (!isCompleteAgentResult(result)) {
      return Response.json({ error: "invalid result" }, { status: 400 });
    }
    const agentResult = result as AgentResult;
    const status = resultStatus(agentResult);
    const agentModel = String(payload.agentModel ?? "OpenCode").slice(0, 120);
    const reviewerModel = String(
      payload.reviewerModel ?? "OpenCode reviewer",
    ).slice(0, 120);
    const previousResult = storedResult(order.resultJson);
    const isInventoryRecalculation = order.mode === "opencode-recalculate";
    const historyReason = isInventoryRecalculation
      ? "Склад перечитан"
      : "Решение рабочей модели";
    const sourceKey = isInventoryRecalculation
      ? `inventory-model:${order.roundNo}`
      : `model:${order.roundNo}`;
    const transitionGuard = and(
      eq(orders.id, orderId),
      eq(orders.status, "processing"),
    )!;
    const resultJson = JSON.stringify(agentResult);
    const historyQuery = insertResultHistoryWhen(
      db,
      {
        orderId,
        roundNo: order.roundNo,
        result: agentResult,
        status,
        reason: historyReason,
        sourceKey,
        inventorySnapshot: order.inventorySnapshotJson ?? undefined,
        agentModel,
        reviewerModel,
      },
      transitionGuard,
    );
    const closeActiveEventsQuery = db
      .update(orderEvents)
      .set({ state: "done" })
      .where(
        and(
          eq(orderEvents.orderId, orderId),
          eq(orderEvents.state, "active"),
          sql`exists (select 1 from ${orders} where ${transitionGuard})`,
        ),
      );
    const decisionEventQuery = insertOrderEventWhen(
      db,
      {
        orderId,
        stage: "decision",
        title:
          isInventoryRecalculation &&
          resultRoute(previousResult) !== resultRoute(agentResult)
            ? "Свежий склад изменил решение"
            : status === "ready_to_send"
            ? "Следующий шаг: готов ответить"
            : status === "clarification_ready"
              ? "Следующий шаг: нужны детали"
              : "Следующий шаг: решает руководитель",
        detail:
          status === "awaiting_approval"
            ? "Руководитель получил подготовленные варианты."
            : status === "clarification_ready"
              ? "Агент подготовил короткие вопросы клиенту."
              : "Ответ проверен и готов к отправке.",
      },
      transitionGuard,
    );
    const updateOrderQuery = db
      .update(orders)
      .set({
        status,
        zone: agentResult.zone,
        resultJson,
        agentModel,
        reviewerModel,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(transitionGuard)
      .returning({ id: orders.id });
    const [, , , updatedOrders] = await db.batch([
      historyQuery,
      closeActiveEventsQuery,
      decisionEventQuery,
      updateOrderQuery,
    ]);
    const [updatedOrder] = updatedOrders;
    if (!updatedOrder) {
      return Response.json(
        { error: "order state changed" },
        { status: 409 },
      );
    }
    return Response.json({ ok: true, status });
  }

  if (action === "error") {
    const [failedOrder] = await db
      .update(orders)
      .set({ status: "error", updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(orders.id, orderId), eq(orders.status, "processing")))
      .returning({ id: orders.id });
    if (!failedOrder) {
      return Response.json(
        { error: "order state changed" },
        { status: 409 },
      );
    }
    await db
      .update(orderEvents)
      .set({ state: "error" })
      .where(
        and(
          eq(orderEvents.orderId, orderId),
          eq(orderEvents.state, "active"),
        ),
      );
    await db.insert(orderEvents).values({
      orderId,
      stage: "error",
      title: "Работу можно продолжить",
      detail:
        "Письмо и журнал сохранены. Запустите карточку ещё раз.",
      state: "error",
    });
    return Response.json({ ok: true });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
