import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { env } from "cloudflare:workers";
import { ensureDb, getDb, insertOrderEventWhen } from "@/db";
import { orderEvents, orders, systemState } from "@/db/schema";
import type { AgentResult } from "@/lib/demo-engine";
import { isCompleteAgentResult } from "@/lib/agent-guard.mjs";
import { isSearchResultUrl } from "@/lib/public-web-url.mjs";
import { insertResultHistoryWhen } from "@/lib/result-history";

export const dynamic = "force-dynamic";
export const JOB_LEASE_SECONDS = 90;

const noStoreHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const responseJson = globalThis.Response.json.bind(globalThis.Response);
export function noStoreResponseInit(init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(noStoreHeaders)) {
    headers.set(name, value);
  }
  return { ...init, headers };
}
const Response = {
  json(body: unknown, init: ResponseInit = {}) {
    return responseJson(body, noStoreResponseInit(init));
  },
};

export type AgentResultTransportPayload = {
  action: "result";
  orderId: string;
  roundNo: number;
  claimId: string;
  result: AgentResult;
  openedSourceUrls?: string[];
  openedSources?: Array<{
    url: string;
    openedAt: string;
    excerpt: string;
    sha256: string;
  }>;
  agentModel?: string;
  reviewerModel?: string;
  reviewerProvenance: {
    stage: "review-result" | "review-fallback" | "review-skipped";
    title: string;
    detail: string;
  };
};

export function reviewerEventFromPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const stage = typeof record.stage === "string" ? record.stage : "";
  if (
    !["review-result", "review-fallback", "review-skipped"].includes(stage)
  ) {
    return null;
  }
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const detail =
    typeof record.detail === "string" ? record.detail.trim() : "";
  if (!title || !detail) return null;
  return {
    stage,
    title: title.slice(0, 180),
    detail: detail.slice(0, 1200),
    state: stage === "review-fallback" ? "error" : "done",
  };
}

function activeClaimGuard(orderId: string, roundNo: number, claimId: string) {
  return and(
    eq(orders.id, orderId),
    eq(orders.status, "processing"),
    eq(orders.roundNo, roundNo),
    eq(orders.claimId, claimId),
    sql`${orders.leaseUntil} > CURRENT_TIMESTAMP`,
  )!;
}

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

export function publicHttpsUrl(value: unknown) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !hostname ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.includes(":")
    ) {
      return "";
    }
    const ipv4 = hostname.split(".");
    if (ipv4.length === 4 && ipv4.every((part) => /^\d+$/u.test(part))) {
      const [first, second] = ipv4.map(Number);
      if (
        ipv4.some((part) => Number(part) > 255) ||
        first === 0 ||
        first === 10 ||
        first === 127 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
      ) {
        return "";
      }
    }
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return "";
  }
}

export function validateResultTransportEvidence(
  result: unknown,
  rawOpenedSourceUrls: unknown,
  rawOpenedSources: unknown = [],
) {
  const openedSourceUrls =
    rawOpenedSourceUrls === undefined ? [] : rawOpenedSourceUrls;
  if (!Array.isArray(openedSourceUrls)) {
    return { ok: false, code: "opened_source_urls_invalid" as const };
  }
  if (!Array.isArray(rawOpenedSources) || rawOpenedSources.length > 20) {
    return { ok: false, code: "opened_sources_invalid" as const };
  }
  const openedSources = rawOpenedSources.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const url = publicHttpsUrl(record.url);
    const openedAt = typeof record.openedAt === "string" ? record.openedAt.trim().slice(0, 80) : "";
    const excerpt = typeof record.excerpt === "string" ? record.excerpt.replace(/\s+/gu, " ").trim() : "";
    const sha256 = typeof record.sha256 === "string" ? record.sha256 : "";
    return url && openedAt && excerpt && excerpt.length <= 12_000 && /^[a-f0-9]{64}$/u.test(sha256) && createHash("sha256").update(excerpt, "utf8").digest("hex") === sha256
      ? { url, openedAt, excerpt, sha256 }
      : null;
  });
  if (openedSources.some((source) => !source)) {
    return { ok: false, code: "opened_sources_invalid" as const };
  }
  const observed = new Set<string>();
  for (const value of openedSourceUrls) {
    const url = publicHttpsUrl(value);
    if (!url || isSearchResultUrl(url)) {
      return { ok: false, code: "opened_source_url_invalid" as const };
    }
    observed.add(url);
  }

  const resultRecord =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  const resolvedIntent =
    resultRecord.resolvedIntent &&
    typeof resultRecord.resolvedIntent === "object" &&
    !Array.isArray(resultRecord.resolvedIntent)
      ? (resultRecord.resolvedIntent as Record<string, unknown>)
      : {};
  const research =
    resultRecord.research &&
    typeof resultRecord.research === "object" &&
    !Array.isArray(resultRecord.research)
      ? (resultRecord.research as Record<string, unknown>)
      : {};
  const webUrls = [
    ...(Array.isArray(resolvedIntent.evidence)
      ? resolvedIntent.evidence
          .map((item) => {
            const record =
              item && typeof item === "object" && !Array.isArray(item)
                ? (item as Record<string, unknown>)
                : {};
            const source =
              record.source &&
              typeof record.source === "object" &&
              !Array.isArray(record.source)
                ? (record.source as Record<string, unknown>)
                : {};
            return source.kind === "web" ? source.url : null;
          })
          .filter((url): url is string => typeof url === "string")
      : []),
    ...(Array.isArray(research.sources)
      ? research.sources
          .map((source) =>
            source && typeof source === "object" && !Array.isArray(source)
              ? (source as Record<string, unknown>).url
              : null,
          )
          .filter((url): url is string => typeof url === "string")
      : []),
    ...(Array.isArray(resultRecord.supplierLeads)
      ? resultRecord.supplierLeads
          .map((lead) =>
            lead && typeof lead === "object" && !Array.isArray(lead)
              ? (lead as Record<string, unknown>).url
              : null,
          )
          .filter((url): url is string => typeof url === "string")
      : []),
  ];
  for (const value of webUrls) {
    const url = publicHttpsUrl(value);
    if (!url || !observed.has(url)) {
      return { ok: false, code: "opened_source_not_observed" as const };
    }
  }
  if (openedSources.some((source) => !source || !observed.has(source.url))) {
    return { ok: false, code: "opened_source_not_observed" as const };
  }
  return { ok: true, openedSourceUrls: [...observed], openedSources } as const;
}

export function supplierPlanDetail(result: AgentResult) {
  const plan = result.supplierPlan;
  if (!plan) return "";
  const formatted = new Intl.NumberFormat("ru-RU");
  return `Для полного заказа найден поставщик «${
    plan.supplierName
  }»: выбрано ${formatted.format(
    plan.supplierKg,
  )} кг из доступных ${formatted.format(
    plan.supplierStockKg,
  )} кг по ${formatted.format(
    plan.supplierPricePerKg,
  )} ₽/кг, срок ${plan.deliveryDays} дн., данные от ${
    plan.stockCheckedAt
  }. Наша часть — ${formatted.format(
    plan.ourKg,
  )} кг, весь заказ — ${formatted.format(plan.total)} ₽.`;
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
  const claimedBy =
    request.headers.get("x-bridge-worker-id")?.trim().slice(0, 120) ||
    "bridge";
  const requeueAt = new Date().toISOString();
  const staleRequeueGuard = and(
    eq(orders.status, "queued"),
    sql`${orders.mode} like 'opencode%'`,
    isNull(orders.claimId),
    isNull(orders.leaseUntil),
    eq(orders.updatedAt, requeueAt),
  )!;
  const requeueQuery = db
    .update(orders)
    .set({
      status: "queued",
      claimId: null,
      claimedBy: null,
      leaseUntil: null,
      updatedAt: requeueAt,
    })
    .where(
      and(
        eq(orders.status, "processing"),
        sql`${orders.mode} like 'opencode%'`,
        or(
          isNull(orders.leaseUntil),
          lte(orders.leaseUntil, sql`CURRENT_TIMESTAMP`),
        ),
      ),
    )
    .returning({ id: orders.id });
  const closeStaleEventsQuery = db
    .update(orderEvents)
    .set({ state: "error" })
    .where(
      and(
        eq(orderEvents.state, "active"),
        sql`exists (
          select 1 from ${orders}
          where ${orders.id} = ${orderEvents.orderId}
            and ${orders.status} = 'queued'
            and ${orders.updatedAt} = ${requeueAt}
        )`,
      ),
    );
  const retryEventsQuery = db.insert(orderEvents).select(
    db
      .select({
        id: sql<number>`null`.as("id"),
        orderId: sql<string>`${orders.id}`.as("order_id"),
        stage: sql<string>`'retry'`.as("stage"),
        title: sql<string>`'Заказ вернулся в очередь'`.as("title"),
        detail: sql<string>`'Предыдущий запуск остановился. Письмо и история сохранены, обработка продолжится с теми же данными.'`.as(
          "detail",
        ),
        state: sql<string>`'done'`.as("state"),
        roundNo: sql<number>`${orders.roundNo}`.as("round_no"),
        claimId: sql<string | null>`NULL`.as("claim_id"),
        attemptNo: sql<number | null>`${orders.attemptNo}`.as("attempt_no"),
        createdAt: sql<string>`${requeueAt}`.as("created_at"),
      })
      .from(orders)
      .where(staleRequeueGuard),
  );
  await db.batch([requeueQuery, closeStaleEventsQuery, retryEventsQuery]);
  const [job] = await db
    .select()
    .from(orders)
    .where(eq(orders.status, "queued"))
    .orderBy(asc(orders.createdAt))
    .limit(1);

  if (!job) return Response.json({ job: null });

  const claimId = crypto.randomUUID();
  const claimQuery = db
    .update(orders)
    .set({
      status: "processing",
      claimId,
      claimedBy,
      attemptNo: sql`${orders.attemptNo} + 1`,
      leaseUntil: sql`datetime('now', ${`+${JOB_LEASE_SECONDS} seconds`})`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(and(eq(orders.id, job.id), eq(orders.status, "queued")))
    .returning({
      id: orders.id,
      subject: orders.subject,
      body: orders.body,
      company: orders.company,
      website: orders.website,
      attachmentJson: orders.attachmentJson,
      conversationJson: orders.conversationJson,
       requestedModel: orders.requestedModel,
       roundNo: orders.roundNo,
       claimId: orders.claimId,
      resultJson: orders.resultJson,
      inventorySnapshotJson: orders.inventorySnapshotJson,
    });
  const initialEventQuery = insertOrderEventWhen(
    db,
    {
      orderId: job.id,
      stage: "understanding",
      title: "Модель для заказов разбирает письмо",
       detail:
         "Агент собирает задачу клиента, выбирает источники и сверяет остаток на момент расчёта для этого заказа.",
       state: "active",
       roundNo: job.roundNo,
       claimId,
       attemptNo: job.attemptNo + 1,
     },
    and(
      eq(orders.id, job.id),
      eq(orders.status, "processing"),
      eq(orders.roundNo, job.roundNo),
      eq(orders.claimId, claimId),
      sql`${orders.leaseUntil} > CURRENT_TIMESTAMP`,
    )!,
  );
  const [claimedJobs] = await db.batch([claimQuery, initialEventQuery]);
  const [claimedJob] = claimedJobs;
  if (!claimedJob) return Response.json({ job: null });

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
  const claimId = typeof payload.claimId === "string" ? payload.claimId : "";
  const roundNo = Number(payload.roundNo);
  if (!claimId || !Number.isSafeInteger(roundNo) || roundNo < 1) {
    return Response.json(
      { error: "claimId and roundNo are required" },
      { status: 400 },
    );
  }

  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      mode: orders.mode,
      roundNo: orders.roundNo,
      attemptNo: orders.attemptNo,
      claimId: orders.claimId,
      resultJson: orders.resultJson,
      inventorySnapshotJson: orders.inventorySnapshotJson,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) {
    return Response.json({ error: "order not found" }, { status: 404 });
  }
  if (
    order.status !== "processing" ||
    order.roundNo !== roundNo ||
    order.claimId !== claimId
  ) {
    return Response.json(
      { error: "job claim is no longer active" },
      { status: 409 },
    );
  }
  const claimGuard = activeClaimGuard(orderId, roundNo, claimId);

  if (action === "renew") {
    const [renewed] = await db
      .update(orders)
      .set({
        leaseUntil: sql`datetime('now', ${`+${JOB_LEASE_SECONDS} seconds`})`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(claimGuard)
      .returning({ leaseUntil: orders.leaseUntil });
    if (!renewed) {
      return Response.json(
        { error: "job claim is no longer active" },
        { status: 409 },
      );
    }
    return Response.json({ ok: true, leaseUntil: renewed.leaseUntil });
  }

  if (action === "event") {
    const [inserted] = await insertOrderEventWhen(
      db,
      {
        orderId,
        stage: String(payload.stage ?? "agent"),
        title: String(payload.title ?? "Шаг агента").slice(0, 180),
        detail: String(payload.detail ?? "").slice(0, 1200),
        state: String(payload.state ?? "done").slice(0, 40),
        roundNo: order.roundNo,
        claimId: order.claimId,
        attemptNo: order.attemptNo,
      },
      claimGuard,
    ).returning({ id: orderEvents.id });
    if (!inserted) {
      return Response.json(
        { error: "job claim is no longer active" },
        { status: 409 },
      );
    }
    return Response.json({ ok: true });
  }

  if (action === "result") {
    const result = payload.result;
    const reviewerEvent = reviewerEventFromPayload(
      payload.reviewerProvenance,
    );
    if (
      !result ||
      typeof result !== "object" ||
      !("schemaVersion" in result) ||
      result.schemaVersion !== 2 ||
      !isCompleteAgentResult(result) ||
      !reviewerEvent
    ) {
      return Response.json({ error: "invalid result" }, { status: 400 });
    }
    const transportEvidence = validateResultTransportEvidence(
      result,
      payload.openedSourceUrls,
      payload.openedSources,
    );
    if (!transportEvidence.ok) {
      return Response.json(
        {
          error: "result contains an unopened or non-public source",
          code: transportEvidence.code,
        },
        { status: 400 },
      );
    }
    const agentResult = result as AgentResult;
    const status = resultStatus(agentResult);
    const agentModel = String(payload.agentModel ?? "OpenCode").slice(0, 120);
    const reviewerModel = String(
      payload.reviewerModel ?? "OpenCode reviewer",
    ).slice(0, 120);
    const previousResult = storedResult(order.resultJson);
    const isSupplierRecalculation = [
      "opencode-supplier-recalculate",
      "opencode-inventory-supplier-recalculate",
    ].includes(order.mode);
    const isInventoryRecalculation = [
      "opencode-recalculate",
      "opencode-inventory-supplier-recalculate",
    ].includes(order.mode);
    const isRecalculation =
      isSupplierRecalculation || isInventoryRecalculation;
    const historyReason =
      isSupplierRecalculation && isInventoryRecalculation
        ? "Поставщик и склад перечитаны"
        : isSupplierRecalculation
          ? "Поставщик перечитан"
          : isInventoryRecalculation
            ? "Склад перечитан"
            : "Решение рабочей модели";
    const sourceKey =
      isSupplierRecalculation && isInventoryRecalculation
        ? `inventory-supplier-model:${order.roundNo}`
        : isSupplierRecalculation
          ? `supplier-model:${order.roundNo}`
          : isInventoryRecalculation
            ? `inventory-model:${order.roundNo}`
            : `model:${order.roundNo}`;
    const resultJson = JSON.stringify(agentResult);
    const completedClaimGuard = and(
      eq(orders.id, orderId),
      eq(orders.status, status),
      eq(orders.roundNo, roundNo),
      eq(orders.claimId, claimId),
      eq(orders.resultJson, resultJson),
    )!;
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
      completedClaimGuard,
    );
    const closeActiveEventsQuery = db
      .update(orderEvents)
      .set({ state: "done" })
      .where(
        and(
          eq(orderEvents.orderId, orderId),
          eq(orderEvents.state, "active"),
          sql`exists (select 1 from ${orders} where ${completedClaimGuard})`,
        ),
      );
    const reviewerEventQuery = insertOrderEventWhen(
      db,
      {
        orderId,
        stage: reviewerEvent.stage,
        title: reviewerEvent.title,
        detail: reviewerEvent.detail,
        state: reviewerEvent.state,
        roundNo,
        claimId,
        attemptNo: order.attemptNo,
      },
      completedClaimGuard,
    );
    const supplierPlan = agentResult.supplierPlan;
    const supplierEventQuery = insertOrderEventWhen(
      db,
      {
        orderId,
        stage: "partner-stock",
        title: "Агент нашёл, где собрать полный объём",
        detail: supplierPlanDetail(agentResult),
        roundNo,
        claimId,
        attemptNo: order.attemptNo,
      },
      and(
        completedClaimGuard,
        supplierPlan ? sql`1 = 1` : sql`1 = 0`,
      )!,
    );
    const decisionEventQuery = insertOrderEventWhen(
      db,
      {
        orderId,
        stage: "decision",
        title:
          isRecalculation &&
          resultRoute(previousResult) !== resultRoute(agentResult)
            ? isSupplierRecalculation && isInventoryRecalculation
              ? "Свежие данные изменили решение"
              : isSupplierRecalculation
                ? "Свежее предложение изменило решение"
                : "Новый остаток изменил решение"
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
        roundNo,
        claimId,
        attemptNo: order.attemptNo,
      },
      completedClaimGuard,
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
      .where(claimGuard)
      .returning({ id: orders.id });
    const clearClaimQuery = db
      .update(orders)
      .set({
        claimId: null,
        claimedBy: null,
        leaseUntil: null,
      })
      .where(completedClaimGuard);
    const [updatedOrders] = await db.batch([
      updateOrderQuery,
      historyQuery,
      closeActiveEventsQuery,
      reviewerEventQuery,
      supplierEventQuery,
      decisionEventQuery,
      clearClaimQuery,
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
    const failedClaimGuard = and(
      eq(orders.id, orderId),
      eq(orders.status, "error"),
      eq(orders.roundNo, roundNo),
      eq(orders.claimId, claimId),
    )!;
    const closeActiveEventsQuery = db
      .update(orderEvents)
      .set({ state: "error" })
      .where(
        and(
          eq(orderEvents.orderId, orderId),
          eq(orderEvents.state, "active"),
          sql`exists (select 1 from ${orders} where ${failedClaimGuard})`,
        ),
      );
    const errorEventQuery = insertOrderEventWhen(
      db,
      {
        orderId,
        stage: "error",
        title: "Работу можно продолжить",
        detail:
          "Письмо и журнал сохранены. Запустите обработку заказа ещё раз.",
        state: "error",
        roundNo,
        claimId,
        attemptNo: order.attemptNo,
      },
      failedClaimGuard,
    );
    const failOrderQuery = db
      .update(orders)
      .set({
        status: "error",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(claimGuard)
      .returning({ id: orders.id });
    const clearFailedClaimQuery = db
      .update(orders)
      .set({
        claimId: null,
        claimedBy: null,
        leaseUntil: null,
      })
      .where(failedClaimGuard);
    const [failedOrders] = await db.batch([
      failOrderQuery,
      closeActiveEventsQuery,
      errorEventQuery,
      clearFailedClaimQuery,
    ]);
    const [failedOrder] = failedOrders;
    if (!failedOrder) {
      return Response.json(
        { error: "order state changed" },
        { status: 409 },
      );
    }
    return Response.json({ ok: true });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
