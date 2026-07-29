import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { ensureDb, getDb, insertOrderEventWhen } from "@/db";
import {
  orderEvents,
  orderResultHistory,
  orders,
  systemState,
} from "@/db/schema";
import modelCatalog from "@/data/models.json";
import { buildDemoResult, type AgentResult } from "@/lib/demo-engine";
import { getDemoDataWithInventory } from "@/lib/inventory";
import { productInventoryChanged } from "@/lib/inventory-freshness.mjs";
import {
  canChangeOrder,
  createOrderActionKey,
  orderActionKeyHash,
} from "@/lib/order-access";
import { checkRequestLimits } from "@/lib/request-limit";
import {
  appendResultHistory,
  insertResultHistoryWhen,
} from "@/lib/result-history";

export const dynamic = "force-dynamic";

type ConversationMessage = {
  role: "agent" | "customer";
  body: string;
  createdAt: string;
};

type Attachment = {
  name: string;
  src: string;
  alt: string;
};

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function storedJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function safeAttachment(value: unknown): Attachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const src = clean(item.src, 240);
  if (!src.startsWith("/")) return null;
  const name = clean(item.name, 160);
  const alt = clean(item.alt, 240);
  return name && alt ? { name, src, alt } : null;
}

const allowedModels = new Set(modelCatalog.options.map((model) => model.id));

function modelLabel(id: string) {
  return modelCatalog.options.find((model) => model.id === id)?.label ?? id;
}

function requestedModel(value: unknown) {
  const candidate = clean(value, 120);
  return allowedModels.has(candidate) ? candidate : modelCatalog.default;
}

async function bridgeOnline() {
  await ensureDb();
  const db = getDb();
  const [heartbeat] = await db
    .select()
    .from(systemState)
    .where(eq(systemState.key, "bridge-heartbeat"))
    .limit(1);

  if (!heartbeat) return false;
  const age = Date.now() - Date.parse(heartbeat.value);
  return Number.isFinite(age) && age < 45_000;
}

function routeOf(result: AgentResult) {
  if (result.route) return result.route;
  if (result.zone === "red") return "manager";
  if (result.zone === "yellow") return "needs_info";
  return "ready";
}

function statusForResult(result: AgentResult) {
  const route = routeOf(result);
  if (route === "manager") return "awaiting_approval";
  if (route === "needs_info") return "clarification_ready";
  return "ready_to_send";
}

function routeLabel(result: AgentResult) {
  const route = routeOf(result);
  if (route === "manager") return "решает руководитель";
  if (route === "needs_info") return "нужны детали";
  return "готов ответить";
}

export function preserveConfirmedResearch(
  previous: AgentResult | null,
  recalculated: AgentResult,
) {
  const previousSources = previous?.research?.sources ?? [];
  const recalculatedSources = recalculated.research?.sources ?? [];
  if (
    previous?.research?.checked !== true ||
    !previousSources.length ||
    recalculatedSources.length
  ) {
    return recalculated;
  }

  const confirmedContextLabel = "Подтверждённые сведения о клиенте:";
  const previousContext = previous?.businessContext.trim() ?? "";
  const confirmedContext = previousContext.includes(confirmedContextLabel)
    ? previousContext.split(confirmedContextLabel).at(-1)?.trim() ?? ""
    : previousContext;
  const freshContext = recalculated.businessContext.trim();

  return {
    ...recalculated,
    research: {
      checked: true,
      summary: previous?.research?.summary ?? "",
      sources: previousSources,
    },
    businessContext: [
      freshContext ? `Свежий расчёт по складу:\n${freshContext}` : "",
      confirmedContext
        ? `${confirmedContextLabel}\n${confirmedContext}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    sources: Array.from(
      new Set([
        ...recalculated.sources,
        "Проверенные открытые источники",
      ]),
    ),
  };
}

function snapshotFromDemoData(
  data: Awaited<ReturnType<typeof getDemoDataWithInventory>>,
) {
  const items = data.products.map((product) => ({
    sku: product.sku,
    name: product.name,
    stockKg: product.stockKg,
    revision: product.stockRevision,
    updatedAt: product.stockUpdatedAt,
  }));
  const version =
    1 +
    items.reduce(
      (sum, item) => sum + Math.max(0, Number(item.revision || 1) - 1),
      0,
    );
  return {
    version,
    capturedAt: new Date().toISOString(),
    items,
  };
}

async function savedResultUsesOldInventory(order: {
  inventorySnapshotJson: string | null;
  resultJson: string | null;
}) {
  const result = storedJson<AgentResult | null>(order.resultJson, null);
  if (!result?.product?.sku) return false;

  const snapshot = storedJson<Record<string, unknown> | null>(
    order.inventorySnapshotJson,
    null,
  );
  const liveData = await getDemoDataWithInventory();
  return productInventoryChanged(snapshot, result, liveData.products);
}

function inputWithConversation(
  order: {
    subject: string;
    body: string;
    company: string;
    website: string;
    attachmentJson: string | null;
  },
  conversation: ConversationMessage[],
) {
  const customerReplies = conversation
    .filter((message) => message.role === "customer")
    .map((message, index) => `Ответ клиента ${index + 1}: ${message.body}`)
    .join("\n");
  return {
    subject: order.subject,
    body: [order.body, customerReplies].filter(Boolean).join("\n\n"),
    company: order.company,
    website: order.website,
    attachment: storedJson<Attachment | null>(order.attachmentJson, null),
  };
}

function stagedEvents(orderId: string, result: AgentResult) {
  const route = routeOf(result);
  const rows = [
    {
      orderId,
      stage: "received",
      title: "Заказ принят",
      detail: "Письмо получило номер и рабочую карточку.",
    },
    {
      orderId,
      stage: "understanding",
      title: "Задача клиента понятна",
      detail: result.understood.join(" · "),
    },
  ];

  if (route === "needs_info") {
    rows.push({
      orderId,
      stage: "clarification",
      title: "Агент подготовил точные вопросы",
      detail: result.missing.join(" · "),
    });
  } else {
    rows.push(
      {
        orderId,
        stage: "inventory",
        title: "Склад подтвердил доступный объём",
        detail: result.product
          ? `${result.product.name}: ${result.product.stockKg} кг на складе, цена ${result.product.pricePerKg} ₽/кг`
          : "Подбор краски продолжится после ответа клиента.",
      },
      {
        orderId,
        stage: "market",
        title:
          result.market.items.length > 0
            ? "Агент сравнил нашу цену с ценами других поставщиков"
            : "Агент проверил цену по карточке товара",
        detail: result.market.summary,
      },
      ...(result.research?.checked
        ? [
            {
              orderId,
              stage: "company-context",
              title: "Сведения о компании учтены",
              detail: result.research.summary,
            },
          ]
        : []),
      {
        orderId,
        stage: "review",
        title: "Ответ собран по правилам завода",
        detail: result.review.verdict,
      },
    );
  }

  rows.push({
    orderId,
    stage: "decision",
    title:
      route === "ready"
        ? "Следующий шаг: готов ответить"
        : route === "needs_info"
          ? "Следующий шаг: нужны детали"
          : "Следующий шаг: решает руководитель",
    detail: result.zoneReason,
  });

  return rows;
}

async function processAutonomously(
  order: {
    subject: string;
    body: string;
    company: string;
    website: string;
    attachmentJson: string | null;
  },
  conversation: ConversationMessage[],
) {
  const liveData = await getDemoDataWithInventory();
  const inventorySnapshot = snapshotFromDemoData(liveData);
  const result = buildDemoResult(
    inputWithConversation(order, conversation),
    liveData,
  );
  return { liveData, inventorySnapshot, result };
}

export async function GET(request: Request) {
  await ensureDb();
  const url = new URL(request.url);
  if (url.searchParams.get("system") === "1") {
    return Response.json({
      bridgeOnline: await bridgeOnline(),
      provider: "OpenCode Go",
      agent: "OpenCode",
      models: modelCatalog.options,
    });
  }

  if (url.searchParams.get("stats") === "1") {
    const db = getDb();
    const [stats] = await db
      .select({
        total: sql<number>`count(*)`,
        completed: sql<number>`coalesce(sum(case when ${orders.status} in ('ready_to_send', 'reserved', 'sent') then 1 else 0 end), 0)`,
        awaitingApproval: sql<number>`coalesce(sum(case when ${orders.status} = 'awaiting_approval' then 1 else 0 end), 0)`,
        awaitingCustomer: sql<number>`coalesce(sum(case when ${orders.status} in ('clarification_ready', 'awaiting_customer') then 1 else 0 end), 0)`,
        sent: sql<number>`coalesce(sum(case when ${orders.status} = 'sent' then 1 else 0 end), 0)`,
        green: sql<number>`coalesce(sum(case when ${orders.zone} = 'green' then 1 else 0 end), 0)`,
        yellow: sql<number>`coalesce(sum(case when ${orders.zone} = 'yellow' then 1 else 0 end), 0)`,
        red: sql<number>`coalesce(sum(case when ${orders.zone} = 'red' then 1 else 0 end), 0)`,
      })
      .from(orders)
      .where(
        sql`date(${orders.createdAt}, '+3 hours') = date('now', '+3 hours')`,
      );

    return Response.json({
      total: Number(stats?.total ?? 0),
      completed: Number(stats?.completed ?? 0),
      awaitingApproval: Number(stats?.awaitingApproval ?? 0),
      awaitingCustomer: Number(stats?.awaitingCustomer ?? 0),
      sent: Number(stats?.sent ?? 0),
      zones: {
        green: Number(stats?.green ?? 0),
        yellow: Number(stats?.yellow ?? 0),
        red: Number(stats?.red ?? 0),
      },
    });
  }

  const id = clean(url.searchParams.get("id"), 80);
  if (!id) {
    return Response.json({ error: "Укажите номер карточки." }, { status: 400 });
  }

  const db = getDb();
  let [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) {
    return Response.json(
      { error: "Карточка не найдена. Создайте новый заказ." },
      { status: 404 },
    );
  }

  if (
    ["queued", "processing"].includes(order.status) &&
    !(await bridgeOnline())
  ) {
    const conversation = storedJson<ConversationMessage[]>(
      order.conversationJson,
      [],
    );
    const { result, inventorySnapshot } = await processAutonomously(
      order,
      conversation,
    );
    const recoveredStatus = statusForResult(result);
    const [recovered] = await db
      .update(orders)
      .set({
        status: recoveredStatus,
        zone: result.zone,
        mode: "autonomous-demo",
        resultJson: JSON.stringify(result),
        inventorySnapshotJson: JSON.stringify(inventorySnapshot),
        agentModel: "Расчёт по готовой инструкции",
        reviewerModel: "Проверка программы",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(orders.id, id),
          inArray(orders.status, ["queued", "processing"]),
          lt(orders.updatedAt, sql`datetime('now', '-1 minute')`),
        ),
      )
      .returning();

    if (recovered) {
      await appendResultHistory({
        orderId: id,
        roundNo: recovered.roundNo,
        result,
        status: recoveredStatus,
        reason: "Карточка продолжила работу",
        sourceKey: `continuation:${recovered.roundNo}:${inventorySnapshot.version}`,
        inventorySnapshot,
        agentModel: "Расчёт по готовой инструкции",
        reviewerModel: "Проверка программы",
      });
      await db
        .update(orderEvents)
        .set({ state: "done" })
        .where(
          and(
            eq(orderEvents.orderId, id),
            eq(orderEvents.state, "active"),
          ),
        );
      await db.insert(orderEvents).values({
        orderId: id,
        stage: "fallback",
        title: "Карточка продолжила работу",
        detail:
          "Карточка продолжила работу по той же инструкции и свежим данным.",
      });
      const continuation = stagedEvents(id, result).filter(
        (event) =>
          event.stage !== "received" &&
          (order.status !== "processing" || event.stage !== "understanding"),
      );
      if (continuation.length) await db.insert(orderEvents).values(continuation);
      order = recovered;
    }
  }

  const events = await db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, id))
    .orderBy(asc(orderEvents.id));
  const resultHistory = await db
    .select()
    .from(orderResultHistory)
    .where(eq(orderResultHistory.orderId, id))
    .orderBy(asc(orderResultHistory.id));

  return Response.json({
    order: {
      ...order,
      result: storedJson<AgentResult | null>(order.resultJson, null),
      attachment: storedJson<Attachment | null>(order.attachmentJson, null),
      conversation: storedJson<ConversationMessage[]>(
        order.conversationJson,
        [],
      ),
      inventorySnapshot: storedJson<Record<string, unknown> | null>(
        order.inventorySnapshotJson,
        null,
      ),
      actionTokenHash: undefined,
      resultJson: undefined,
      attachmentJson: undefined,
      conversationJson: undefined,
      inventorySnapshotJson: undefined,
    },
    events,
    resultHistory: resultHistory.map((item) => ({
      ...item,
      result: storedJson<AgentResult | null>(item.resultJson, null),
      inventorySnapshot: storedJson<Record<string, unknown> | null>(
        item.inventorySnapshotJson,
        null,
      ),
      resultJson: undefined,
      inventorySnapshotJson: undefined,
    })),
  });
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return Response.json(
      { error: "Сократите письмо до 4000 знаков и отправьте его снова." },
      { status: 413 },
    );
  }
  const limit = await checkRequestLimits(request, [
    {
      name: "orders-minute",
      max: 20,
      windowSeconds: 60,
      scope: "visitor",
    },
    {
      name: "orders-stand-minute",
      max: 120,
      windowSeconds: 60,
      scope: "stand",
    },
  ]);
  if (!limit.allowed) {
    return Response.json(
      {
        error:
          "Стенд получил много заявок. Подождите немного и отправьте письмо снова.",
      },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  let payload: Record<string, unknown>;
  try {
    const value = (await request.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("invalid payload");
    }
    payload = value as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: "Заполните письмо и отправьте его снова." },
      { status: 400 },
    );
  }
  const subject = clean(payload.subject, 180);
  const body = clean(payload.body, 4000);
  const company = clean(payload.company, 140);
  const website = clean(payload.website, 240);
  const selectedModel = requestedModel(payload.model);
  const attachment = safeAttachment(payload.attachment);
  const action = clean(payload.action, 40);

  if (action === "retry") {
    const retryId = clean(payload.id, 80);
    if (!retryId) {
      return Response.json(
        { error: "Укажите номер карточки." },
        { status: 400 },
      );
    }

    const db = getDb();
    const [failedOrder] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, retryId))
      .limit(1);
    if (!failedOrder) {
      return Response.json(
        { error: "Карточка не найдена. Создайте новый заказ." },
        { status: 404 },
      );
    }
    if (!(await canChangeOrder(request, failedOrder.actionTokenHash))) {
      return Response.json(
        {
          error:
            "Откройте карточку из того же окна, где вы её создали, или войдите в пульт ведущего.",
        },
        { status: 403 },
      );
    }

    const transitionGuard = and(
      eq(orders.id, retryId),
      eq(orders.status, "error"),
      sql`coalesce(${orders.resultJson}, '') = ${
        failedOrder.resultJson ?? ""
      }`,
      sql`coalesce(${orders.inventorySnapshotJson}, '') = ${
        failedOrder.inventorySnapshotJson ?? ""
      }`,
      sql`${orders.roundNo} = ${failedOrder.roundNo}`,
      sql`${orders.sentAt} is null`,
    )!;
    const retryEventQuery = insertOrderEventWhen(
      db,
      {
        orderId: retryId,
        stage: "retry",
        title: "Карточка снова поставлена в очередь",
        detail:
          "Номер карточки, переписка, прежние решения и снимок склада сохранены.",
      },
      transitionGuard,
    );
    const retryOrderQuery = db
      .update(orders)
      .set({
        status: "queued",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(transitionGuard)
      .returning({
        id: orders.id,
        status: orders.status,
        roundNo: orders.roundNo,
      });
    const [, retriedOrders] = await db.batch([
      retryEventQuery,
      retryOrderQuery,
    ]);
    const [retriedOrder] = retriedOrders;
    if (!retriedOrder) {
      return Response.json(
        {
          error:
            "Карточка уже продолжила работу. Показываем последнее состояние.",
        },
        { status: 409 },
      );
    }

    return Response.json({
      ok: true,
      id: retriedOrder.id,
      status: retriedOrder.status,
      roundNo: retriedOrder.roundNo,
    });
  }

  if (subject.length < 5 || body.length < 20) {
    return Response.json(
      { error: "Добавьте тему и опишите задачу клиента." },
      { status: 400 },
    );
  }

  const id = `ord_${crypto.randomUUID().replaceAll("-", "")}`;
  const actionKey = createOrderActionKey();
  const isLive = await bridgeOnline();
  const mode = isLive ? "opencode-live" : "autonomous-demo";
  const db = getDb();
  if (isLive) {
    const [queue] = await db
      .select({ total: sql<number>`count(*)` })
      .from(orders)
      .where(inArray(orders.status, ["queued", "processing"]));
    if (Number(queue?.total ?? 0) >= 100) {
      return Response.json(
        {
          error:
            "Модель уже ведёт много заявок. Подождите немного и отправьте письмо снова.",
        },
        { status: 503, headers: { "Retry-After": "30" } },
      );
    }
  }
  const liveData = await getDemoDataWithInventory();
  const inventorySnapshot = snapshotFromDemoData(liveData);

  await db.insert(orders).values({
    id,
    subject,
    body,
    company,
    website,
    status: isLive ? "queued" : "processing",
    mode,
    requestedModel: selectedModel,
    actionTokenHash: await orderActionKeyHash(actionKey),
    attachmentJson: attachment ? JSON.stringify(attachment) : null,
    conversationJson: "[]",
    inventorySnapshotJson: JSON.stringify(inventorySnapshot),
  });

  if (isLive) {
    await db.insert(orderEvents).values({
      orderId: id,
      stage: "received",
      title: "Заказ принят",
      detail: `Карточка передана исполнителю: ${modelLabel(selectedModel)}.`,
    });
  } else {
    const result = buildDemoResult(
      { subject, body, company, website, attachment },
      liveData,
    );
    const status = statusForResult(result);
    await db
      .update(orders)
      .set({
        status,
        zone: result.zone,
        resultJson: JSON.stringify(result),
        agentModel: "Расчёт по готовой инструкции",
        reviewerModel: "Проверка программы",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(orders.id, id));
    await appendResultHistory({
      orderId: id,
      roundNo: 1,
      result,
      status,
      reason: "Первое решение",
      sourceKey: "initial:1",
      inventorySnapshot,
      agentModel: "Расчёт по готовой инструкции",
      reviewerModel: "Проверка программы",
    });
    await db.insert(orderEvents).values(stagedEvents(id, result));
  }

  return Response.json(
    { id, actionKey, mode, bridgeOnline: isLive },
    { status: 201 },
  );
}

export async function PATCH(request: Request) {
  const limit = await checkRequestLimits(request, [
    {
      name: "order-actions-minute",
      max: 40,
      windowSeconds: 60,
      scope: "visitor",
    },
    {
      name: "order-actions-stand-minute",
      max: 240,
      windowSeconds: 60,
      scope: "stand",
    },
  ]);
  if (!limit.allowed) {
    return Response.json(
      {
        error:
          "Карточки сейчас активно обновляются. Подождите немного и повторите действие.",
      },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  let payload: Record<string, unknown>;
  try {
    const value = (await request.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("invalid payload");
    }
    payload = value as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: "Обновите страницу и повторите действие." },
      { status: 400 },
    );
  }
  const id = clean(payload.id, 80);
  const action = clean(payload.action, 40) || "approve";
  const optionId = clean(payload.optionId, 80);
  if (!id) {
    return Response.json({ error: "Укажите номер карточки." }, { status: 400 });
  }

  const db = getDb();
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) {
    return Response.json(
      { error: "Карточка не найдена. Создайте новый заказ." },
      { status: 404 },
    );
  }
  if (!(await canChangeOrder(request, order.actionTokenHash))) {
    return Response.json(
      {
        error:
          "Откройте карточку из того же окна, где вы её создали, или войдите в пульт ведущего.",
      },
      { status: 403 },
    );
  }

  if (action === "send_clarification") {
    if (order.status !== "clarification_ready" || !order.resultJson) {
      return Response.json(
        { error: "Вопросы уже отправлены или карточка перешла дальше." },
        { status: 409 },
      );
    }
    const result = storedJson<AgentResult | null>(order.resultJson, null);
    if (!result || routeOf(result) !== "needs_info") {
      return Response.json(
        { error: "Карточка уже перешла к следующему шагу." },
        { status: 409 },
      );
    }
    const conversation = storedJson<ConversationMessage[]>(
      order.conversationJson,
      [],
    );
    const now = new Date().toISOString();
    const message: ConversationMessage = {
      role: "agent",
      body: result.reply.body,
      createdAt: now,
    };
    const transitionGuard = and(
      eq(orders.id, id),
      eq(orders.status, "clarification_ready"),
      sql`coalesce(${orders.resultJson}, '') = ${order.resultJson ?? ""}`,
      sql`coalesce(${orders.conversationJson}, '') = ${
        order.conversationJson ?? ""
      }`,
      sql`coalesce(${orders.sentAt}, '') = ${order.sentAt ?? ""}`,
    )!;
    const clarificationEventQuery = insertOrderEventWhen(
      db,
      {
        orderId: id,
        stage: "clarification-sent",
        title: "Вопросы отправлены на стенде",
        detail: `${result.missing.join(" · ")}. Письмо и время сохранены в общем журнале.`,
        createdAt: now,
      },
      transitionGuard,
    );
    const updateOrderQuery = db
      .update(orders)
      .set({
        status: "awaiting_customer",
        conversationJson: JSON.stringify([...conversation, message]),
        updatedAt: now,
      })
      .where(transitionGuard)
      .returning({ id: orders.id });
    const [, updatedOrders] = await db.batch([
      clarificationEventQuery,
      updateOrderQuery,
    ]);
    const [updated] = updatedOrders;
    if (!updated) {
      return Response.json(
        { error: "Карточка уже обновилась. Показываем свежие данные." },
        { status: 409 },
      );
    }
    return Response.json({ ok: true, status: "awaiting_customer" });
  }

  if (action === "customer_reply") {
    const answer = clean(payload.answer, 2_000);
    if (answer.length < 5) {
      return Response.json(
        { error: "Добавьте ответ клиента." },
        { status: 400 },
      );
    }
    if (order.status !== "awaiting_customer") {
      return Response.json(
        { error: "Карточка уже обработала этот ответ." },
        { status: 409 },
      );
    }
    const conversation = storedJson<ConversationMessage[]>(
      order.conversationJson,
      [],
    );
    const customerRepliedAt = new Date().toISOString();
    const nextConversation = [
      ...conversation,
      {
        role: "customer" as const,
        body: answer,
        createdAt: customerRepliedAt,
      },
    ];
    const liveData = await getDemoDataWithInventory();
    const inventorySnapshot = snapshotFromDemoData(liveData);
    const live = await bridgeOnline();

    if (live) {
      const [queued] = await db
        .update(orders)
        .set({
          status: "queued",
          zone: null,
          conversationJson: JSON.stringify(nextConversation),
          roundNo: order.roundNo + 1,
          inventorySnapshotJson: JSON.stringify(inventorySnapshot),
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(eq(orders.id, id), eq(orders.status, "awaiting_customer")),
        )
        .returning({ id: orders.id });
      if (!queued) {
        return Response.json(
          { error: "Карточка уже обновилась. Показываем свежие данные." },
          { status: 409 },
        );
      }
      await db.insert(orderEvents).values({
        orderId: id,
        stage: "customer-reply",
        title: "Клиент прислал детали",
        detail: answer,
      });
      return Response.json({ ok: true, status: "queued" });
    }

    const result = buildDemoResult(
      inputWithConversation(order, nextConversation),
      liveData,
    );
    const nextStatus = statusForResult(result);
    const transitionGuard = and(
      eq(orders.id, id),
      eq(orders.status, "awaiting_customer"),
      sql`coalesce(${orders.resultJson}, '') = ${order.resultJson ?? ""}`,
      sql`coalesce(${orders.conversationJson}, '') = ${
        order.conversationJson ?? ""
      }`,
      sql`coalesce(${orders.inventorySnapshotJson}, '') = ${
        order.inventorySnapshotJson ?? ""
      }`,
      sql`coalesce(${orders.sentAt}, '') = ${order.sentAt ?? ""}`,
    )!;
    const historyQuery = insertResultHistoryWhen(
      db,
      {
        orderId: id,
        roundNo: order.roundNo + 1,
        result,
        status: nextStatus,
        reason: "Ответ клиента учтён",
        sourceKey: `customer:${order.roundNo + 1}`,
        inventorySnapshot,
        agentModel: "Расчёт по готовой инструкции",
        reviewerModel: "Проверка программы",
      },
      transitionGuard,
    );
    const transitionEvents = [
      {
        orderId: id,
        stage: "customer-reply",
        title: "Клиент прислал детали",
        detail: answer,
      },
      ...stagedEvents(id, result).filter(
        (event) => !["received", "understanding"].includes(event.stage),
      ),
    ];
    const eventQueries = transitionEvents.map((event) =>
      insertOrderEventWhen(
        db,
        { ...event, createdAt: customerRepliedAt },
        transitionGuard,
      ),
    );
    const updateOrderQuery = db
      .update(orders)
      .set({
        status: nextStatus,
        zone: result.zone,
        resultJson: JSON.stringify(result),
        conversationJson: JSON.stringify(nextConversation),
        roundNo: order.roundNo + 1,
        inventorySnapshotJson: JSON.stringify(inventorySnapshot),
        agentModel: "Расчёт по готовой инструкции",
        reviewerModel: "Проверка программы",
        updatedAt: customerRepliedAt,
      })
      .where(transitionGuard)
      .returning({ id: orders.id });
    const batchResults = await db.batch([
      historyQuery,
      ...eventQueries,
      updateOrderQuery,
    ]);
    const updatedOrders = batchResults.at(-1) as
      | Array<{ id: string }>
      | undefined;
    const [updated] = updatedOrders ?? [];
    if (!updated) {
      return Response.json(
        { error: "Карточка уже обновилась. Показываем свежие данные." },
        { status: 409 },
      );
    }
    return Response.json({ ok: true, status: nextStatus });
  }

  if (action === "recalculate") {
    if (["queued", "processing", "sent"].includes(order.status)) {
      return Response.json(
        { error: "Дождитесь результата текущего шага." },
        { status: 409 },
      );
    }
    if (
      order.status !== "error" &&
      !(await savedResultUsesOldInventory(order))
    ) {
      return Response.json(
        {
          error: "Карточка уже рассчитана по свежему складу.",
        },
        { status: 409 },
      );
    }
    const conversation = storedJson<ConversationMessage[]>(
      order.conversationJson,
      [],
    );
    const previousResult = storedJson<AgentResult | null>(
      order.resultJson,
      null,
    );
    const liveData = await getDemoDataWithInventory();
    const inventorySnapshot = snapshotFromDemoData(liveData);
    const currentItemForPreviousResult = inventorySnapshot.items.find(
      (item) => item.sku === previousResult?.product?.sku,
    );
    const previousItems = storedJson<{
      items?: Array<{ sku?: string; stockKg?: number }>;
    } | null>(order.inventorySnapshotJson, null)?.items;
    const previousItem = previousItems?.find(
      (item) => item.sku === previousResult?.product?.sku,
    );
    const stockChange =
      previousItem && currentItemForPreviousResult
        ? `Остаток: ${previousItem.stockKg ?? "—"} → ${currentItemForPreviousResult.stockKg} кг.`
        : `Склад перечитан по свежим данным.`;
    const live = await bridgeOnline();

    if (live) {
      const transitionGuard = and(
        eq(orders.id, id),
        eq(orders.status, order.status),
        sql`coalesce(${orders.resultJson}, '') = ${order.resultJson ?? ""}`,
        sql`coalesce(${orders.inventorySnapshotJson}, '') = ${
          order.inventorySnapshotJson ?? ""
        }`,
        sql`${orders.sentAt} is null`,
      )!;
      const recalculateEventQuery = insertOrderEventWhen(
        db,
        {
          orderId: id,
          stage: "recalculate",
          title: "Новый остаток передан агенту",
          detail: `${stockChange} Модель для заказов заново готовит решение, письмо и варианты для руководителя.`,
          state: "active",
        },
        transitionGuard,
      );
      const updateOrderQuery = db
        .update(orders)
        .set({
          status: "queued",
          inventorySnapshotJson: JSON.stringify(inventorySnapshot),
          roundNo: order.roundNo + 1,
          mode: "opencode-recalculate",
          managerDecision: null,
          managerOptionId: null,
          managerDecidedAt: null,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(transitionGuard)
        .returning({ id: orders.id });
      const [, queuedOrders] = await db.batch([
        recalculateEventQuery,
        updateOrderQuery,
      ]);
      const [queuedOrder] = queuedOrders;
      if (!queuedOrder) {
        return Response.json(
          {
            error:
              "Карточка уже получила свежие данные. Показываем последнее решение.",
          },
          { status: 409 },
        );
      }
      return Response.json({
        ok: true,
        status: "queued",
        inventoryVersion: inventorySnapshot.version,
        bridgeOnline: true,
      });
    }

    const recalculatedResult = buildDemoResult(
      inputWithConversation(order, conversation),
      liveData,
    );
    const result = preserveConfirmedResearch(
      previousResult,
      recalculatedResult,
    );
    const nextStatus = statusForResult(result);
    const currentItem = inventorySnapshot.items.find(
      (item) => item.sku === result.product?.sku,
    );
    const decisionChange = previousResult
      ? `Было: ${routeLabel(previousResult)}. Стало: ${routeLabel(result)}.`
      : `Теперь: ${routeLabel(result)}.`;
    const transitionGuard = and(
      eq(orders.id, id),
      eq(orders.status, order.status),
      sql`coalesce(${orders.resultJson}, '') = ${order.resultJson ?? ""}`,
      sql`coalesce(${orders.inventorySnapshotJson}, '') = ${
        order.inventorySnapshotJson ?? ""
      }`,
      sql`${orders.sentAt} is null`,
    )!;
    const historyQuery = insertResultHistoryWhen(
      db,
      {
        orderId: id,
        roundNo: order.roundNo,
        result,
        status: nextStatus,
        reason: "Склад перечитан",
        sourceKey: `inventory:${order.roundNo}:${result.product?.sku ?? "none"}:${currentItem?.revision ?? inventorySnapshot.version}`,
        inventorySnapshot,
        agentModel: "Готовая инструкция",
        reviewerModel: "Проверка программы",
      },
      transitionGuard,
    );
    const transitionEvents = [
      {
        orderId: id,
        stage: "recalculate",
        title:
          previousResult && routeOf(previousResult) !== routeOf(result)
            ? "Новый остаток изменил решение"
            : "Агент снова проверил склад",
        detail: `${stockChange} ${decisionChange} ${result.zoneReason}`,
      },
      ...stagedEvents(id, result).filter((event) =>
        ["inventory", "market", "review", "decision"].includes(event.stage),
      ),
    ];
    const eventQueries = transitionEvents.map((event) =>
      insertOrderEventWhen(db, event, transitionGuard),
    );
    const updateOrderQuery = db
      .update(orders)
      .set({
        status: nextStatus,
        zone: result.zone,
        resultJson: JSON.stringify(result),
        inventorySnapshotJson: JSON.stringify(inventorySnapshot),
        mode: "autonomous-demo",
        agentModel: "Готовая инструкция",
        reviewerModel: "Проверка программы",
        managerDecision: null,
        managerOptionId: null,
        managerDecidedAt: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(transitionGuard)
      .returning({ id: orders.id });
    const batchResults = await db.batch([
      historyQuery,
      ...eventQueries,
      updateOrderQuery,
    ]);
    const updatedOrders = batchResults.at(-1) as
      | Array<{ id: string }>
      | undefined;
    const [updated] = updatedOrders ?? [];
    if (!updated) {
      return Response.json(
        {
          error:
            "Карточка уже получила свежий расчёт. Показываем последнее решение.",
        },
        { status: 409 },
      );
    }
    return Response.json({
      ok: true,
      status: nextStatus,
      inventoryVersion: inventorySnapshot.version,
    });
  }

  if (action === "reserve") {
    if (order.status !== "ready_to_send" || order.sentAt) {
      return Response.json(
        { error: "Резерв уже подготовлен или карточка перешла дальше." },
        { status: 409 },
      );
    }
    if (await savedResultUsesOldInventory(order)) {
      return Response.json(
        {
          error:
            "Склад обновился. Пересчитайте карточку — агент сразу подготовит свежий объём для резерва.",
        },
        { status: 409 },
      );
    }
    const result = storedJson<AgentResult | null>(order.resultJson, null);
    if (!result?.product) {
      return Response.json(
        { error: "Дождитесь готового подбора краски и объёма." },
        { status: 409 },
      );
    }

    const now = new Date().toISOString();
    const transitionGuard = and(
      eq(orders.id, id),
      eq(orders.status, "ready_to_send"),
      sql`coalesce(${orders.resultJson}, '') = ${order.resultJson ?? ""}`,
      sql`coalesce(${orders.inventorySnapshotJson}, '') = ${
        order.inventorySnapshotJson ?? ""
      }`,
      sql`${orders.sentAt} is null`,
    )!;
    const reserveEventQuery = insertOrderEventWhen(
      db,
      {
        orderId: id,
        stage: "reserve",
        title: "Резерв под договор подготовлен",
        detail: `${result.product.requestedKg} кг краски «${result.product.name}» закреплены за карточкой. В рабочей системе этот шаг передаст резерв в учётную систему.`,
        createdAt: now,
      },
      transitionGuard,
    );
    const updateOrderQuery = db
      .update(orders)
      .set({
        status: "reserved",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(transitionGuard)
      .returning({ id: orders.id });
    const [, reservedOrders] = await db.batch([
      reserveEventQuery,
      updateOrderQuery,
    ]);
    const [reservedOrder] = reservedOrders;
    if (!reservedOrder) {
      return Response.json(
        { error: "Карточка уже обновилась. Показываем свежие данные." },
        { status: 409 },
      );
    }

    return Response.json({ ok: true, status: "reserved", reservedAt: now });
  }

  if (action === "send") {
    if (order.status !== "reserved" || order.sentAt) {
      return Response.json(
        {
          error:
            order.status === "ready_to_send"
              ? "Сначала подготовьте резерв под договор."
              : "Письмо ждёт следующий шаг в карточке.",
        },
        { status: 409 },
      );
    }
    if (await savedResultUsesOldInventory(order)) {
      return Response.json(
        {
          error:
            "Склад обновился. Пересчитайте карточку — агент сразу подготовит свежее письмо.",
        },
        { status: 409 },
      );
    }

    const now = new Date().toISOString();
    const transitionGuard = and(
      eq(orders.id, id),
      eq(orders.status, "reserved"),
      sql`coalesce(${orders.resultJson}, '') = ${order.resultJson ?? ""}`,
      sql`coalesce(${orders.inventorySnapshotJson}, '') = ${
        order.inventorySnapshotJson ?? ""
      }`,
      sql`${orders.sentAt} is null`,
    )!;
    const sentEventQuery = insertOrderEventWhen(
      db,
      {
        orderId: id,
        stage: "sent",
        title: "Ответ отправлен на стенде",
        detail:
          "Письмо и время отправки сохранены в общем журнале. Рабочая почта компании подключается отдельным шагом.",
        createdAt: now,
      },
      transitionGuard,
    );
    const updateOrderQuery = db
      .update(orders)
      .set({
        status: "sent",
        sentAt: now,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(transitionGuard)
      .returning({ id: orders.id });
    const [, sentOrders] = await db.batch([
      sentEventQuery,
      updateOrderQuery,
    ]);
    const [sentOrder] = sentOrders;
    if (!sentOrder) {
      return Response.json(
        { error: "Карточка уже обновилась. Показываем свежие данные." },
        { status: 409 },
      );
    }

    return Response.json({ ok: true, status: "sent", sentAt: now });
  }

  if (action !== "approve" || !optionId) {
    return Response.json(
      { error: "Выберите один подготовленный вариант." },
      { status: 400 },
    );
  }

  if (order.status !== "awaiting_approval") {
    return Response.json(
      { error: "Карточка уже получила решение." },
      { status: 409 },
    );
  }
  if (await savedResultUsesOldInventory(order)) {
    return Response.json(
      {
        error:
          "Склад обновился. Пересчитайте карточку — руководитель получит свежие варианты.",
      },
      { status: 409 },
    );
  }

  const result = storedJson<AgentResult | null>(order.resultJson, null);
  if (!result) {
    return Response.json(
      { error: "Решение готовится. Обновите карточку через несколько секунд." },
      { status: 404 },
    );
  }

  const option = result.options.find((item) => item.id === optionId);
  if (!option) {
    return Response.json(
      { error: "Показываем свежие варианты. Выберите один из них." },
      { status: 400 },
    );
  }

  result.reply = {
    subject: result.reply.subject,
    body: option.reply,
  };

  const now = new Date().toISOString();
  const transitionGuard = and(
    eq(orders.id, id),
    eq(orders.status, "awaiting_approval"),
    sql`coalesce(${orders.resultJson}, '') = ${order.resultJson ?? ""}`,
    sql`coalesce(${orders.inventorySnapshotJson}, '') = ${
      order.inventorySnapshotJson ?? ""
    }`,
    sql`${orders.sentAt} is null`,
  )!;
  const historyQuery = insertResultHistoryWhen(
    db,
    {
      orderId: id,
      roundNo: order.roundNo,
      result,
      status: "ready_to_send",
      reason: "Вариант руководителя подтверждён",
      sourceKey: `approval:${order.roundNo}:${option.id}`,
      inventorySnapshot: order.inventorySnapshotJson ?? undefined,
      agentModel: order.agentModel,
      reviewerModel: order.reviewerModel,
    },
    transitionGuard,
  );
  const approvalEventQuery = insertOrderEventWhen(
    db,
    {
      orderId: id,
      stage: "approval",
      title: "Руководитель выбрал следующий ход",
      detail: option.title,
      createdAt: now,
    },
    transitionGuard,
  );
  const updateOrderQuery = db
    .update(orders)
    .set({
      status: "ready_to_send",
      managerDecision: option.title,
      managerOptionId: option.id,
      managerDecidedAt: now,
      resultJson: JSON.stringify(result),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(transitionGuard)
    .returning({ id: orders.id });
  const [, , approvedOrders] = await db.batch([
    historyQuery,
    approvalEventQuery,
    updateOrderQuery,
  ]);
  const [approvedOrder] = approvedOrders;
  if (!approvedOrder) {
    return Response.json(
      { error: "Карточка уже обновилась. Показываем свежие данные." },
      { status: 409 },
    );
  }

  return Response.json({
    ok: true,
    selected: option.title,
    status: "ready_to_send",
  });
}
