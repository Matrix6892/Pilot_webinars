import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { ensureDb, getDb, insertOrderEventWhen } from "@/db";
import {
  orderEvents,
  orderResultHistory,
  orders,
  systemState,
} from "@/db/schema";
import modelCatalog from "@/data/models.json";
import {
  buildDemoResult,
  marketView,
  productHasRequestedColor,
  type AgentResult,
  type SupplierPlan,
} from "@/lib/demo-engine";
import {
  decodeStoredAgentResult,
  isCompleteAgentResult,
  managerFallbackAgentResult,
} from "@/lib/agent-guard.mjs";
import { getDemoDataWithInventory } from "@/lib/inventory";
import { productInventoryChanged } from "@/lib/inventory-freshness.mjs";
import {
  canChangeOrder,
  createOrderActionKey,
  orderActionKeyHash,
} from "@/lib/order-access";
import { checkRequestLimits } from "@/lib/request-limit";
import { insertResultHistoryWhen } from "@/lib/result-history";
import {
  confirmSupplierPlan,
  supplierPlanChangeDetail,
} from "@/lib/supplier-plan.mjs";
import { resolveVisionImageUrl } from "@/lib/upload-guard.mjs";

export const dynamic = "force-dynamic";

const noStoreHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const orderCapabilityCookiePrefix = "koler_order_capability_";
const orderCapabilityMaxAgeSeconds = 24 * 60 * 60;
const clientOrderIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const clientActionKeyPattern = /^[0-9a-f]{64}$/iu;
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

function orderCapabilityCookieName(orderId: string) {
  return `${orderCapabilityCookiePrefix}${orderId}`;
}

function orderCapabilityCookie(orderId: string, actionKey: string) {
  return [
    `${orderCapabilityCookieName(orderId)}=${actionKey}`,
    "Path=/api/orders",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${orderCapabilityMaxAgeSeconds}`,
  ].join("; ");
}

function createdOrderResponse({
  id,
  actionKey,
  mode,
  bridgeOnline,
  recorded,
  status = 201,
  idempotent = false,
}: {
  id: string;
  actionKey: string;
  mode: string;
  bridgeOnline: boolean;
  recorded: boolean;
  status?: number;
  idempotent?: boolean;
}) {
  const response = Response.json(
    { id, actionKey, mode, bridgeOnline, recorded, idempotent },
    { status },
  );
  response.headers.append("Set-Cookie", orderCapabilityCookie(id, actionKey));
  return response;
}

function cookieValue(request: Request, name: string) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

function eventMetadata(order: {
  roundNo: number;
  claimId?: string | null;
  attemptNo?: number | null;
}) {
  return {
    roundNo: order.roundNo,
    claimId: order.claimId ?? null,
    attemptNo: order.attemptNo ?? null,
  };
}

export async function canReadOrder(
  request: Request,
  expectedHash: string | null,
  orderId: string,
) {
  if (await canChangeOrder(request, expectedHash)) return true;
  const capability = cookieValue(
    request,
    orderCapabilityCookieName(orderId),
  );
  if (!/^[0-9a-f]{64}$/i.test(capability)) return false;
  const headers = new Headers(request.headers);
  headers.set("x-order-key", capability);
  return canChangeOrder(new Request(request.url, { headers }), expectedHash);
}

function storedJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function storedAgentResult(value: string | null) {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return managerFallbackAgentResult(
      {
        subject: "Сохранённый заказ",
        body: "Сохранённый результат повреждён.",
        roundNo: 1,
      },
      { reason: "Сохранённый результат повреждён и передан на ручную проверку." },
    ) as AgentResult;
  }
  const decoded = decodeStoredAgentResult(parsed);
  return decoded && isCompleteAgentResult(decoded)
    ? (decoded as AgentResult)
    : (managerFallbackAgentResult(
        {
          subject: "Сохранённый заказ",
          body: "Сохранённый результат не прошёл проверку.",
          roundNo: 1,
        },
        { reason: "Сохранённый результат передан на ручную проверку." },
      ) as AgentResult);
}

export function safeAttachment(value: unknown): Attachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const src = clean(item.src, 240);
  if (!resolveVisionImageUrl(src, "https://koler.invalid")) return null;
  const name = clean(item.name, 160);
  const alt = clean(item.alt, 240);
  return name && alt ? { name, src, alt } : null;
}

const allowedModels = new Set(
  modelCatalog.options
    .filter((model) => model.roles.includes("primary"))
    .map((model) => model.id),
);
const recordedDemoKinds = new Set(["fence-photo"]);

export function clientCreateIdentity(payload: Record<string, unknown>) {
  const rawId = payload.clientOrderId;
  const rawKey = payload.clientActionKey;
  if (
    (rawId !== undefined && typeof rawId !== "string") ||
    (rawKey !== undefined && typeof rawKey !== "string")
  ) {
    return { error: "client_identity_invalid" as const };
  }
  const clientOrderId = typeof rawId === "string" ? rawId.trim() : "";
  const clientActionKey = typeof rawKey === "string" ? rawKey.trim() : "";
  if (clientOrderId && !clientOrderIdPattern.test(clientOrderId)) {
    return { error: "client_order_id_invalid" as const };
  }
  if (clientActionKey && !clientActionKeyPattern.test(clientActionKey)) {
    return { error: "client_action_key_invalid" as const };
  }
  return {
    clientOrderId: clientOrderId || null,
    clientActionKey: clientActionKey || null,
  } as const;
}

export function createRequestFingerprint(payload: Record<string, unknown>) {
  const executionMode = clean(payload.executionMode, 20);
  const demoKind = clean(payload.demoKind, 40);
  const recorded = executionMode === "recorded" && recordedDemoKinds.has(demoKind);
  const attachment = safeAttachment(payload.attachment);
  return {
    subject: clean(payload.subject, 180),
    body: clean(payload.body, 4_000),
    company: clean(payload.company, 140),
    website: clean(payload.website, 240),
    requestedModel: requestedModel(payload.model),
    mode: recorded ? "recorded-demo" : "opencode-live",
    attachmentJson: attachment ? JSON.stringify(attachment) : null,
  };
}

export function matchesCreateRequest(
  order: {
    subject: string;
    body: string;
    company: string;
    website: string;
    requestedModel: string | null;
    mode: string;
    attachmentJson: string | null;
  },
  fingerprint: ReturnType<typeof createRequestFingerprint>,
) {
  return (
    order.subject === fingerprint.subject &&
    order.body === fingerprint.body &&
    order.company === fingerprint.company &&
    order.website === fingerprint.website &&
    order.requestedModel === fingerprint.requestedModel &&
    order.mode === fingerprint.mode &&
    order.attachmentJson === fingerprint.attachmentJson
  );
}

export function resolveCreateReplay(
  existing: {
    id: string;
    actionTokenHash: string | null;
    mode: string;
  } & Parameters<typeof matchesCreateRequest>[0] | null,
  actionTokenHash: string,
  fingerprint: ReturnType<typeof createRequestFingerprint>,
) {
  if (!existing) return { kind: "create" as const };
  if (
    existing.actionTokenHash !== actionTokenHash ||
    !matchesCreateRequest(existing, fingerprint)
  ) {
    return { kind: "conflict" as const };
  }
  return {
    kind: "replay" as const,
    id: existing.id,
    mode: existing.mode,
  };
}

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

export function supplierPlanAfterApproval(
  supplierPlan: SupplierPlan | null | undefined,
  optionId: string,
  confirmedSupplierPlan: SupplierPlan | null,
  confirmedAt: string,
  approvedAlternative = false,
) {
  if (optionId === "confirm-supplier-plan") {
    return confirmedSupplierPlan
      ? { ...confirmedSupplierPlan, confirmedAt }
      : undefined;
  }
  if (approvedAlternative || !supplierPlan) return undefined;
  return { ...supplierPlan };
}

export function approvalStatus(
  needsCustomerReply: boolean,
  commitment: AgentResult["commitment"],
) {
  if (needsCustomerReply) return "clarification_ready" as const;
  void commitment; // ponytail: every approved client reply uses one ready state.
  return "ready_to_send" as const;
}

function routeLabel(result: AgentResult) {
  const route = routeOf(result);
  if (route === "manager") return "решает руководитель";
  if (route === "needs_info") return "нужны детали";
  return "готов ответить";
}

export function supplierPlanEventDetail(plan: SupplierPlan) {
  const formatKg = (value: number) =>
    new Intl.NumberFormat("ru-RU").format(value);
  return `В таблице «${plan.supplierName}» указано ${formatKg(
    plan.supplierKg,
  )} кг из доступных ${formatKg(plan.supplierStockKg)} кг по ${formatKg(
    plan.supplierPricePerKg,
  )} ₽/кг, срок ${plan.deliveryDays} дн., данные от ${
    plan.stockCheckedAt
  }. Наша часть — ${formatKg(
    plan.ourKg,
  )} кг, весь заказ — ${formatKg(plan.total)} ₽.`;
}

export function reserveEventDetail(
  product: NonNullable<AgentResult["product"]>,
  supplierPlan?: SupplierPlan | null,
) {
  const formatKg = (value: number) =>
    new Intl.NumberFormat("ru-RU").format(value);
  const reservedKg = Math.max(
    0,
    Math.min(
      product.firstDeliveryKg || product.requestedKg,
      product.requestedKg,
      product.stockKg,
    ),
  );
  const remainingKg = Math.max(0, product.requestedKg - reservedKg);
  const remaining =
    remainingKg > 0
      ? ` Оставшиеся ${formatKg(remainingKg)} кг записаны в выбранный план поставки.`
      : "";

  const color = product.color ? `, цвет ${product.color}` : "";
  const supplier =
    supplierPlan
      ? ` Перед резервом повторно проверено предложение другого поставщика. ${supplierPlanEventDetail(
          supplierPlan,
        )}`
      : "";
  const handoff = supplierPlan
    ? "В рабочей системе этот шаг передаст резерв нашей части в учётную систему."
    : "В рабочей системе этот шаг передаст резерв в учётную систему.";
  return `${formatKg(reservedKg)} кг краски «${product.name}»${color} закреплены за заказом.${remaining}${supplier} ${handoff}`;
}

export function approvedProductForOption(
  product: NonNullable<AgentResult["product"]>,
  option: AgentResult["options"][number],
  products: Array<{
    sku: string;
    name: string;
    stockKg: number;
    pricePerKg: number;
    replenishmentDays: number;
    analogues: string[];
  }>,
) {
  const source = products.find((item) => item.sku === product.sku);
  if (!source) return product;

  const optionText =
    `${option.id} ${option.title} ${option.rationale} ${option.tradeoff} ${option.reply}`.toLocaleLowerCase(
      "ru-RU",
    );
  const alternative = products.find(
    (item) =>
      item.sku !== product.sku &&
      source.analogues.includes(item.sku) &&
      (optionText.includes(item.sku.toLocaleLowerCase("ru-RU")) ||
        optionText.includes(item.name.toLocaleLowerCase("ru-RU"))),
  );
  if (!alternative) return product;

  return {
    sku: alternative.sku,
    name: alternative.name,
    stockKg: alternative.stockKg,
    requestedKg: product.requestedKg,
    ...(product.firstDeliveryKg
      ? { firstDeliveryKg: product.firstDeliveryKg }
      : {}),
    ...(product.color ? { color: product.color } : {}),
    pricePerKg: alternative.pricePerKg,
    total: alternative.pricePerKg * product.requestedKg,
    replenishmentDays: alternative.replenishmentDays,
  };
}

export function optionNeedsCustomerReply(
  option: AgentResult["options"][number],
) {
  if (option.followUpActor) return option.followUpActor === "customer";
  return (
    ["clarify", "график-клиента"].includes(option.id) ||
    /(?:\?|назовите|укажите|ответьте|напишите|уточните|направьте|сообщите|пришлите|подтвердите|что для вас|к какой дате)/iu.test(
      option.reply,
    )
  );
}

export function understoodAfterProductChoice(
  understood: string[],
  originalProduct: NonNullable<AgentResult["product"]>,
  approvedProduct: NonNullable<AgentResult["product"]>,
) {
  const originalSku = originalProduct.sku.toLocaleLowerCase("ru-RU");
  const originalName = originalProduct.name.toLocaleLowerCase("ru-RU");
  const productFact =
    /^(?:краска|выбранная краска|подходящий товар|краска по каталогу|остаток|на складе|цена|цвет|первая\s+(?:поставка|партия))(?:\s|:|—|-)/iu;
  const formatted = new Intl.NumberFormat("ru-RU");

  return [
    ...understood.filter((item) => {
      const value = item.toLocaleLowerCase("ru-RU");
      return (
        !productFact.test(item) &&
        !value.includes(originalSku) &&
        !value.includes(originalName)
      );
    }),
    `Выбранная краска: ${approvedProduct.name}`,
    `Склад подтверждает весь заказ: ${formatted.format(
      approvedProduct.requestedKg,
    )} кг из ${formatted.format(approvedProduct.stockKg)} кг`,
    ...(approvedProduct.firstDeliveryKg
      ? [
          `Первая поставка: ${formatted.format(
            approvedProduct.firstDeliveryKg,
          )} кг; затем ${formatted.format(
            approvedProduct.requestedKg - approvedProduct.firstDeliveryKg,
          )} кг`,
        ]
      : []),
    ...(approvedProduct.color ? [`Цвет: ${approvedProduct.color}`] : []),
    `Цена: ${formatted.format(approvedProduct.pricePerKg)} ₽/кг`,
  ];
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

export function snapshotFromDemoData(
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
    market: data.market.map((offer) => ({ ...offer })),
  };
}

async function savedResultUsesOldInventory(order: {
  inventorySnapshotJson: string | null;
  resultJson: string | null;
}) {
  const result = storedAgentResult(order.resultJson);
  if (!result?.product?.sku) return false;

  const snapshot = storedJson<Record<string, unknown> | null>(
    order.inventorySnapshotJson,
    null,
  );
  const liveData = await getDemoDataWithInventory();
  return productInventoryChanged(snapshot, result, liveData.products);
}

export function confirmedSupplierPlanForSnapshot(
  order: { inventorySnapshotJson: string | null },
  plan: SupplierPlan,
  market: unknown[],
) {
  const snapshot = storedJson<{ market?: unknown[] } | null>(
    order.inventorySnapshotJson,
    null,
  );
  if (!Array.isArray(snapshot?.market)) return null;
  const snapshotPlan = confirmSupplierPlan(plan, snapshot.market);
  return snapshotPlan ? confirmSupplierPlan(snapshotPlan, market) : null;
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

function stagedEvents(
  orderId: string,
  result: AgentResult,
  metadata: {
    roundNo?: number | null;
    claimId?: string | null;
    attemptNo?: number | null;
  } = { roundNo: 1, claimId: null, attemptNo: 0 },
) {
  const route = routeOf(result);
  const supplierPlan = result.supplierPlan ?? null;
  const rows = [
    {
      orderId,
      stage: "received",
      title: "Заказ принят",
      detail: "Письмо получило номер заказа.",
    },
    {
      orderId,
      stage: "understanding",
      title: "Задача клиента понятна",
      detail: result.understood.join(" · "),
    },
  ];

  if (result.research?.checked) {
    rows.push({
      orderId,
      stage: "company-context",
      title: "Агент изучил сведения о компании",
      detail: [
        result.research.summary,
        result.research.sources.length
          ? `Источники: ${result.research.sources
              .map((source) => source.title)
              .join(", ")}.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
  }

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
            : "Агент проверил цену по описанию краски в каталоге",
        detail: result.market.summary,
      },
      ...(supplierPlan
        ? [
            {
              orderId,
              stage: "partner-stock",
              title: "Агент нашёл, где собрать полный объём",
              detail: `${supplierPlanEventDetail(
                supplierPlan,
              )} Данные из таблицы поставщиков сверены перед подготовкой вариантов.`,
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

  return rows.map((event) => ({ ...event, ...metadata }));
}

export async function GET(request: Request) {
  await ensureDb();
  const url = new URL(request.url);
  if (url.searchParams.get("system") === "1") {
    return Response.json({
      bridgeOnline: await bridgeOnline(),
      provider: "DeepSeek API",
      agent: "Колер",
      runner: "OpenCode",
      reviewerProvider: "DeepSeek API",
      models: modelCatalog.options.filter((model) =>
        model.roles.includes("primary"),
      ),
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
    return Response.json(
      { error: "Укажите номер заказа." },
      { status: 400, headers: noStoreHeaders },
    );
  }

  const db = getDb();
  const [capability] = await db
    .select({ actionTokenHash: orders.actionTokenHash })
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  if (!capability) {
    return Response.json(
      { error: "Заказ не найден. Создайте новый заказ." },
      { status: 404, headers: noStoreHeaders },
    );
  }
  if (!(await canReadOrder(request, capability.actionTokenHash, id))) {
    return Response.json(
      { error: "Откройте заказ из того же окна или войдите в панель администратора." },
      { status: 403, headers: noStoreHeaders },
    );
  }

  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  if (!order) {
    return Response.json(
      { error: "Заказ не найден. Создайте новый заказ." },
      { status: 404, headers: noStoreHeaders },
    );
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

  return Response.json(
    {
      bridgeOnline: await bridgeOnline(),
      order: {
        ...order,
        result: storedAgentResult(order.resultJson),
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
        claimId: undefined,
        claimedBy: undefined,
      },
      events,
      resultHistory: resultHistory.map((item) => {
        const result = storedAgentResult(item.resultJson);
        return {
          id: item.id,
          orderId: item.orderId,
          roundNo: item.roundNo,
          zone: item.zone,
          route: item.route,
          status: item.status,
          reason: item.reason,
          replySubject: result?.reply.subject ?? "",
          replyBody: result?.reply.body ?? "",
          zoneReason: result?.zoneReason ?? "",
          optionsJson: JSON.stringify(result?.options ?? []),
          result,
          inventorySnapshot: storedJson<Record<string, unknown> | null>(
            item.inventorySnapshotJson,
            null,
          ),
          agentModel: item.agentModel,
          reviewerModel: item.reviewerModel,
          sourceKey: item.sourceKey,
          createdAt: item.createdAt,
          resultJson: undefined,
          inventorySnapshotJson: undefined,
        };
      }),
    },
    { headers: noStoreHeaders },
  );
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
          "Система получила много заявок. Подождите немного и отправьте письмо снова.",
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
  const demoKind = clean(payload.demoKind, 40);
  const recordedMode =
    clean(payload.executionMode, 20) === "recorded" &&
    recordedDemoKinds.has(demoKind);

  if (action === "retry") {
    const retryId = clean(payload.id, 80);
    if (!retryId) {
      return Response.json(
        { error: "Укажите номер заказа." },
        { status: 400 },
      );
    }

    const db = getDb();
    const [failedCapability] = await db
      .select({ actionTokenHash: orders.actionTokenHash })
      .from(orders)
      .where(eq(orders.id, retryId))
      .limit(1);
    if (!failedCapability) {
      return Response.json(
        { error: "Заказ не найден. Создайте новый заказ." },
        { status: 404, headers: noStoreHeaders },
      );
    }
    if (!(await canChangeOrder(request, failedCapability.actionTokenHash))) {
      return Response.json(
        {
          error:
            "Откройте заказ из того же окна, где вы его создали, или войдите в панель администратора.",
        },
        { status: 403, headers: noStoreHeaders },
      );
    }
    const [failedOrder] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, retryId))
      .limit(1);
    if (!failedOrder) {
      return Response.json(
        { error: "Заказ не найден. Создайте новый заказ." },
        { status: 404, headers: noStoreHeaders },
      );
    }
    if (failedOrder.status === "queued") {
      return Response.json({
        ok: true,
        id: failedOrder.id,
        status: "queued",
        roundNo: failedOrder.roundNo,
      });
    }

    const transitionGuard = and(
      eq(orders.id, retryId),
      or(
        eq(orders.status, "error"),
        and(
          eq(orders.status, "processing"),
          or(
            isNull(orders.leaseUntil),
            lte(orders.leaseUntil, sql`CURRENT_TIMESTAMP`),
          ),
        ),
      ),
      sql`coalesce(${orders.resultJson}, '') = ${
        failedOrder.resultJson ?? ""
      }`,
      sql`coalesce(${orders.inventorySnapshotJson}, '') = ${
        failedOrder.inventorySnapshotJson ?? ""
      }`,
      sql`${orders.roundNo} = ${failedOrder.roundNo}`,
      sql`${orders.sentAt} is null`,
    )!;
    const closeActiveEventsQuery = db
      .update(orderEvents)
      .set({ state: "error" })
      .where(
        and(
          eq(orderEvents.orderId, retryId),
          eq(orderEvents.state, "active"),
          sql`exists (select 1 from ${orders} where ${transitionGuard})`,
        ),
      );
    const retryEventQuery = insertOrderEventWhen(
      db,
      {
        orderId: retryId,
        stage: "retry",
        title: "Заказ снова поставлен в очередь",
        detail:
          "Номер заказа, переписка, прежние решения и остаток на момент расчёта сохранены.",
        ...eventMetadata(failedOrder),
      },
      transitionGuard,
    );
    const retryOrderQuery = db
      .update(orders)
      .set({
        status: "queued",
        claimId: null,
        claimedBy: null,
        leaseUntil: null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(transitionGuard)
      .returning({
        id: orders.id,
        status: orders.status,
        roundNo: orders.roundNo,
      });
    const [, , retriedOrders] = await db.batch([
      closeActiveEventsQuery,
      retryEventQuery,
      retryOrderQuery,
    ]);
    const [retriedOrder] = retriedOrders;
    if (!retriedOrder) {
      return Response.json(
        {
          error:
            "Работа с заказом уже продолжилась. Показываем последнее состояние.",
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

  if (!subject || body.length < 3) {
    return Response.json(
      { error: "Добавьте тему и опишите задачу клиента." },
      { status: 400 },
    );
  }

  const clientIdentity = clientCreateIdentity(payload);
  if ("error" in clientIdentity) {
    return Response.json(
      { error: "Параметры повторной отправки имеют неверный формат." },
      { status: 400 },
    );
  }
  const fingerprint = {
    subject,
    body,
    company,
    website,
    requestedModel: selectedModel,
    mode: recordedMode ? "recorded-demo" : "opencode-live",
    attachmentJson: attachment ? JSON.stringify(attachment) : null,
  };
  const id =
    clientIdentity.clientOrderId ??
    `ord_${crypto.randomUUID().replaceAll("-", "")}`;
  const actionKey = clientIdentity.clientActionKey ?? createOrderActionKey();
  const mode = fingerprint.mode;
  const db = getDb();
  const actionTokenHash = await orderActionKeyHash(actionKey);
  const [existingOrder] = clientIdentity.clientOrderId
    ? await db
        .select()
        .from(orders)
        .where(eq(orders.id, id))
        .limit(1)
    : [];
  if (existingOrder) {
    const replay = resolveCreateReplay(
      existingOrder,
      actionTokenHash,
      fingerprint,
    );
    if (replay.kind === "conflict") {
      return Response.json(
        {
          error:
            "Этот clientOrderId уже связан с другой заявкой или capability.",
          code: "idempotency_conflict",
        },
        { status: 409 },
      );
    }
    return createdOrderResponse({
      id: existingOrder.id,
      actionKey,
      mode: existingOrder.mode,
      bridgeOnline: await bridgeOnline(),
      recorded: existingOrder.mode === "recorded-demo",
      status: 200,
      idempotent: true,
    });
  }
  const isLive = await bridgeOnline();
  if (!recordedMode) {
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
  const commonOrder = {
    id,
    subject,
    body,
    company,
    website,
    mode,
    requestedModel: selectedModel,
    actionTokenHash,
    attachmentJson: attachment ? JSON.stringify(attachment) : null,
    conversationJson: "[]",
    inventorySnapshotJson: JSON.stringify(inventorySnapshot),
  };

  try {
    if (!recordedMode) {
    await db.batch([
      db.insert(orders).values({
        ...commonOrder,
        status: "queued",
      }),
      db.insert(orderEvents).values({
        orderId: id,
        stage: "received",
        title: "Заказ принят",
        detail: isLive
          ? `Заказ передан выбранной модели: ${modelLabel(selectedModel)}.`
          : `Заказ сохранён для ${modelLabel(selectedModel)}. Агент продолжит после восстановления соединения.`,
        roundNo: 1,
        claimId: null,
        attemptNo: 0,
      }),
    ]);
    } else {
    const result = buildDemoResult(
      { subject, body, company, website, attachment },
      liveData,
    );
    if (!isCompleteAgentResult(result)) {
      return Response.json(
        {
          error:
            "Записанный сценарий не прошёл проверку контракта. Запустите живого агента.",
        },
        { status: 500 },
      );
    }
    const status = statusForResult(result);
    const initialGuard = eq(orders.id, id);
    const historyQuery = insertResultHistoryWhen(
      db,
      {
        orderId: id,
        roundNo: 1,
        result,
        status,
        reason: "Первое решение",
        sourceKey: "initial:1",
        inventorySnapshot,
        agentModel: "Записанный демонстрационный прогон",
        reviewerModel: "Проверка программы",
      },
      initialGuard,
    );
    await db.batch([
      db.insert(orders).values({
        ...commonOrder,
        status,
        zone: result.zone,
        resultJson: JSON.stringify(result),
        agentModel: "Записанный демонстрационный прогон",
        reviewerModel: "Проверка программы",
      }),
      historyQuery,
      db.insert(orderEvents).values(stagedEvents(id, result)),
    ]);
    }
  } catch (error) {
    if (clientIdentity.clientOrderId) {
      const [racedOrder] = await db
        .select()
        .from(orders)
        .where(eq(orders.id, id))
        .limit(1);
      if (racedOrder) {
        const replay = resolveCreateReplay(
          racedOrder,
          actionTokenHash,
          fingerprint,
        );
        if (replay.kind === "replay") {
          return createdOrderResponse({
            id: replay.id,
            actionKey,
            mode: replay.mode,
            bridgeOnline: await bridgeOnline(),
            recorded: racedOrder.mode === "recorded-demo",
            status: 200,
            idempotent: true,
          });
        }
        return Response.json(
          {
            error:
              "Этот clientOrderId уже связан с другой заявкой или capability.",
            code: "idempotency_conflict",
          },
          { status: 409 },
        );
      }
    }
    throw error;
  }

  return createdOrderResponse({
    id,
    actionKey,
    mode,
    bridgeOnline: isLive,
    recorded: recordedMode,
  });
}

export async function PATCH(request: Request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return Response.json(
      { error: "Сократите данные действия и повторите его." },
      { status: 413 },
    );
  }
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
          "Заказы сейчас активно обновляются. Подождите немного и повторите действие.",
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
    return Response.json({ error: "Укажите номер заказа." }, { status: 400 });
  }

  const db = getDb();
  const [capability] = await db
    .select({ actionTokenHash: orders.actionTokenHash })
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  if (!capability) {
    return Response.json(
      { error: "Заказ не найден. Создайте новый заказ." },
      { status: 404, headers: noStoreHeaders },
    );
  }
  if (!(await canChangeOrder(request, capability.actionTokenHash))) {
    return Response.json(
      {
        error:
          "Откройте заказ из того же окна, где вы его создали, или войдите в панель администратора.",
      },
      { status: 403, headers: noStoreHeaders },
    );
  }
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .limit(1);
  if (!order) {
    return Response.json(
      { error: "Заказ не найден. Создайте новый заказ." },
      { status: 404, headers: noStoreHeaders },
    );
  }

  const recordSupplierRefreshNeeded = async (
    step: string,
    plan: SupplierPlan,
    market: unknown[],
  ) => {
    const guard = and(
      eq(orders.id, id),
      eq(orders.status, order.status),
      sql`coalesce(${orders.resultJson}, '') = ${order.resultJson ?? ""}`,
      sql`coalesce(${orders.inventorySnapshotJson}, '') = ${
        order.inventorySnapshotJson ?? ""
      }`,
      sql`coalesce(${orders.sentAt}, '') = ${order.sentAt ?? ""}`,
    )!;
    await insertOrderEventWhen(
      db,
      {
        orderId: id,
        stage: "partner-stock",
        title: "Нужен свежий расчёт совместной поставки",
        detail: `Перед ${step} система перечитала данные поставщика. ${supplierPlanChangeDetail(
          plan,
          market,
        )} Агент подготовит новый выполнимый вариант.`,
        ...eventMetadata(order),
      },
      guard,
    );
  };

  if (action === "send_clarification") {
    if (order.status !== "clarification_ready" || !order.resultJson) {
      return Response.json(
        { error: "Вопросы уже отправлены или заказ перешёл к следующему шагу." },
        { status: 409 },
      );
    }
    const result = storedAgentResult(order.resultJson);
    if (!result || routeOf(result) !== "needs_info") {
      return Response.json(
        { error: "Заказ уже перешёл к следующему шагу." },
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
        title: "Вопросы записаны в журнал демонстрации",
          detail: `${result.missing.join(" · ")}. Письмо и время сохранены в общем журнале.`,
          createdAt: now,
          ...eventMetadata(order),
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
        { error: "Заказ уже обновился. Показываем свежие данные." },
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
        { error: "Этот ответ клиента уже учтён в заказе." },
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
    const recordedMode = order.mode === "recorded-demo";

    if (!recordedMode) {
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
        sql`${orders.roundNo} = ${order.roundNo}`,
        sql`${orders.sentAt} is null`,
      )!;
      const replyEventQuery = insertOrderEventWhen(
        db,
        {
          orderId: id,
          stage: "customer-reply",
          title: "Клиент прислал детали",
          detail: answer,
          createdAt: customerRepliedAt,
          ...eventMetadata(order),
        },
        transitionGuard,
      );
      const queueOrderQuery = db
        .update(orders)
        .set({
          status: "queued",
          zone: null,
          conversationJson: JSON.stringify(nextConversation),
          roundNo: order.roundNo + 1,
          inventorySnapshotJson: JSON.stringify(inventorySnapshot),
          managerDecision: null,
          managerOptionId: null,
          managerDecidedAt: null,
          mode: "opencode-live",
          updatedAt: customerRepliedAt,
        })
        .where(transitionGuard)
        .returning({ id: orders.id });
      const [, queuedOrders] = await db.batch([
        replyEventQuery,
        queueOrderQuery,
      ]);
      const [queued] = queuedOrders;
      if (!queued) {
        return Response.json(
          { error: "Заказ уже обновился. Показываем свежие данные." },
          { status: 409 },
        );
      }
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
        agentModel: "Записанный демонстрационный прогон",
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
      ...stagedEvents(id, result, {
        roundNo: order.roundNo + 1,
        claimId: order.claimId,
        attemptNo: order.attemptNo,
      }).filter(
        (event) => !["received", "understanding"].includes(event.stage),
      ),
    ];
    const eventQueries = transitionEvents.map((event) =>
        insertOrderEventWhen(
          db,
          {
            ...event,
            createdAt: customerRepliedAt,
            ...eventMetadata({ ...order, roundNo: order.roundNo + 1 }),
          },
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
        agentModel: "Записанный демонстрационный прогон",
        reviewerModel: "Проверка программы",
        managerDecision: null,
        managerOptionId: null,
        managerDecidedAt: null,
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
        { error: "Заказ уже обновился. Показываем свежие данные." },
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
    const conversation = storedJson<ConversationMessage[]>(
      order.conversationJson,
      [],
    );
    const previousResult = storedAgentResult(order.resultJson);
    const liveData = await getDemoDataWithInventory();
    const inventoryOutdated = await savedResultUsesOldInventory(order);
    const supplierOutdated = Boolean(
      previousResult?.supplierPlan &&
        !confirmSupplierPlan(previousResult.supplierPlan, liveData.market),
    );
    if (
      order.status !== "error" &&
      !inventoryOutdated &&
      !supplierOutdated
    ) {
      return Response.json(
        {
          error: "Заказ уже рассчитан по свежим данным.",
        },
        { status: 409 },
      );
    }
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
    const dataChanges = [];
    if (
      previousItem &&
      currentItemForPreviousResult &&
      previousItem.stockKg !== currentItemForPreviousResult.stockKg
    ) {
      dataChanges.push(
        `Наш склад: ${previousItem.stockKg ?? "—"} → ${
          currentItemForPreviousResult.stockKg
        } кг.`,
      );
    }
    if (supplierOutdated && previousResult?.supplierPlan) {
      dataChanges.push(
        supplierPlanChangeDetail(previousResult.supplierPlan, liveData.market),
      );
    }
    const stockChange =
      dataChanges.join(" ") || "Склад перечитан по свежим данным.";
    const bridgeIsOnline = await bridgeOnline();
    const recordedMode = order.mode === "recorded-demo";

    if (!recordedMode) {
      const liveMode = supplierOutdated
        ? inventoryOutdated
          ? "opencode-inventory-supplier-recalculate"
          : "opencode-supplier-recalculate"
        : "opencode-recalculate";
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
          title:
            supplierOutdated && inventoryOutdated
              ? "Свежие данные склада и поставщика переданы агенту"
              : supplierOutdated
                ? "Свежее предложение передано агенту"
                : "Новый остаток передан агенту",
          detail: `${stockChange} Модель для заказов заново готовит решение, письмо и варианты для руководителя.`,
          state: "active",
          ...eventMetadata({ ...order, roundNo: order.roundNo + 1 }),
        },
        transitionGuard,
      );
      const updateOrderQuery = db
        .update(orders)
        .set({
          status: "queued",
          inventorySnapshotJson: JSON.stringify(inventorySnapshot),
          roundNo: order.roundNo + 1,
          mode: liveMode,
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
              "Заказ уже получил свежие данные. Показываем последнее решение.",
          },
          { status: 409 },
        );
      }
      return Response.json({
        ok: true,
        status: "queued",
        inventoryVersion: inventorySnapshot.version,
        bridgeOnline: bridgeIsOnline,
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
        roundNo: order.roundNo + 1,
        result,
        status: nextStatus,
        reason: supplierOutdated
          ? inventoryOutdated
            ? "Поставщик и склад перечитаны"
            : "Поставщик перечитан"
          : "Склад перечитан",
        sourceKey: `recalculate:${order.roundNo + 1}:${result.product?.sku ?? "none"}:${currentItem?.revision ?? inventorySnapshot.version}`,
        inventorySnapshot,
        agentModel: "Записанный демонстрационный прогон",
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
      ...stagedEvents(id, result, {
        roundNo: order.roundNo + 1,
        claimId: order.claimId,
        attemptNo: order.attemptNo,
      }).filter((event) =>
        [
          "inventory",
          "market",
          "partner-stock",
          "review",
          "decision",
        ].includes(event.stage),
      ),
    ];
    const eventQueries = transitionEvents.map((event) =>
      insertOrderEventWhen(
        db,
        {
          ...event,
          ...eventMetadata({ ...order, roundNo: order.roundNo + 1 }),
        },
        transitionGuard,
      ),
    );
    const updateOrderQuery = db
      .update(orders)
      .set({
        status: nextStatus,
        zone: result.zone,
        resultJson: JSON.stringify(result),
        inventorySnapshotJson: JSON.stringify(inventorySnapshot),
        mode: "recorded-demo",
        agentModel: "Записанный демонстрационный прогон",
        reviewerModel: "Проверка программы",
        managerDecision: null,
        managerOptionId: null,
        managerDecidedAt: null,
        roundNo: order.roundNo + 1,
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
            "Заказ уже получил свежий расчёт. Показываем последнее решение.",
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
        { error: "Резерв товара уже подготовлен или заказ перешёл дальше." },
        { status: 409 },
      );
    }
    if (await savedResultUsesOldInventory(order)) {
      return Response.json(
        {
          error:
            "Склад обновился. Пересчитайте заказ — агент сразу подготовит свежий объём для резерва.",
        },
        { status: 409 },
      );
    }
    const result = storedAgentResult(order.resultJson);
    if (!result?.product) {
      return Response.json(
        { error: "Дождитесь готового подбора краски и объёма." },
        { status: 409 },
      );
    }
    if (result.commitment !== "commercial_offer") {
      return Response.json(
        {
          error:
            "Предварительную оценку можно отправить клиенту, но резерв откроется после подтверждения точных данных.",
        },
        { status: 409 },
      );
    }
    let confirmedSupplierPlan: SupplierPlan | null = null;
    if (result.supplierPlan) {
      if (!result.supplierPlan.confirmedAt) {
        return Response.json(
          {
            error:
              "План поставщика ещё не подтверждён руководителем. Выберите актуальный вариант решения.",
          },
          { status: 409 },
        );
      }
      const liveData = await getDemoDataWithInventory();
      confirmedSupplierPlan = confirmedSupplierPlanForSnapshot(
        order,
        result.supplierPlan,
        liveData.market,
      );
      if (!confirmedSupplierPlan) {
        await recordSupplierRefreshNeeded(
          "подготовкой резерва",
          result.supplierPlan,
          liveData.market,
        );
        return Response.json(
          {
            error:
              "Данные поставщика обновились. Пересчитайте заказ — агент сразу соберёт свежий вариант.",
            recalculate: true,
          },
          { status: 409 },
        );
      }
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
        title: "Резерв товара подготовлен",
        detail: reserveEventDetail(
          result.product,
          confirmedSupplierPlan,
        ),
        createdAt: now,
        ...eventMetadata(order),
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
        { error: "Заказ уже обновился. Показываем свежие данные." },
        { status: 409 },
      );
    }

    return Response.json({ ok: true, status: "reserved", reservedAt: now });
  }

  if (action === "send") {
    const result = storedAgentResult(order.resultJson);
    const sendsEstimate =
      order.status === "ready_to_send" &&
      result?.commitment === "estimate";
    const sendsManagerReply =
      order.status === "ready_to_send" &&
      result?.commitment === "none" &&
      Boolean(order.managerDecision);
    const sendsCommercialOffer =
      order.status === "reserved" &&
      result?.commitment === "commercial_offer";
    if (
      (!sendsEstimate && !sendsManagerReply && !sendsCommercialOffer) ||
      order.sentAt
    ) {
      return Response.json(
        {
          error:
            order.status === "ready_to_send"
              ? "Сначала подготовьте резерв товара."
              : "Письмо ждёт следующего шага по заказу.",
        },
        { status: 409 },
      );
    }
    if (sendsCommercialOffer && (await savedResultUsesOldInventory(order))) {
      return Response.json(
        {
          error:
            "Склад обновился. Пересчитайте заказ — агент сразу подготовит свежее письмо.",
        },
        { status: 409 },
      );
    }

    let confirmedSupplierPlan: SupplierPlan | null = null;
    if (sendsCommercialOffer && result?.supplierPlan) {
      if (!result.supplierPlan.confirmedAt) {
        return Response.json(
          {
            error:
              "План поставщика ещё не подтверждён руководителем. Отправка остановлена до сверки условий.",
          },
          { status: 409 },
        );
      }
      const liveData = await getDemoDataWithInventory();
      confirmedSupplierPlan = confirmedSupplierPlanForSnapshot(
        order,
        result.supplierPlan,
        liveData.market,
      );
      if (!confirmedSupplierPlan) {
        await recordSupplierRefreshNeeded(
          "записью отправки",
          result.supplierPlan,
          liveData.market,
        );
        return Response.json(
          {
            error:
              "Данные поставщика обновились. Пересчитайте заказ — агент сразу подготовит свежее письмо.",
            recalculate: true,
          },
          { status: 409 },
        );
      }
    }

    const now = new Date().toISOString();
    const priorSendStatus = sendsEstimate ? "ready_to_send" : "reserved";
    const guardedSendStatus = sendsManagerReply
      ? "ready_to_send"
      : priorSendStatus;
    const transitionGuard = and(
      eq(orders.id, id),
      eq(orders.status, guardedSendStatus),
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
        title: "Отправка ответа записана",
        detail: sendsEstimate
          ? "Диапазонная оценка отправлена без резерва товара. Письмо и время сохранены в общем журнале. Рабочая почта компании подключается отдельным шагом."
          : sendsManagerReply
          ? "Одобренный руководителем некоммерческий ответ отправлен без резерва товара. Письмо и время сохранены в общем журнале. Рабочая почта компании подключается отдельным шагом."
          : confirmedSupplierPlan
          ? `Перед записью отправки повторно проверены цена, объём, срок и дата поставщика. ${supplierPlanEventDetail(
              confirmedSupplierPlan,
            )} Письмо и время сохранены в общем журнале. Рабочая почта компании подключается отдельным шагом.`
          : "Письмо и время отправки сохранены в общем журнале. Рабочая почта компании подключается отдельным шагом.",
        createdAt: now,
        ...eventMetadata(order),
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
        { error: "Заказ уже обновился. Показываем свежие данные." },
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
      { error: "Решение по заказу уже принято." },
      { status: 409 },
    );
  }
  if (await savedResultUsesOldInventory(order)) {
    return Response.json(
      {
        error:
          "Склад обновился. Пересчитайте заказ — руководитель получит свежие варианты.",
      },
      { status: 409 },
    );
  }

  const result = storedAgentResult(order.resultJson);
  if (!result) {
    return Response.json(
      { error: "Решение готовится. Обновите заказ через несколько секунд." },
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

  const liveData = await getDemoDataWithInventory();
  const now = new Date().toISOString();
  let confirmedSupplierPlan: SupplierPlan | null = null;
  const confirmsSupplierPlan = option.id === "confirm-supplier-plan";
  if (confirmsSupplierPlan) {
    if (!result.supplierPlan) {
      return Response.json(
        {
          error:
            "Вариант поставщика больше не содержит внутреннего снимка. Пересчитайте заказ для сверки условий.",
          recalculate: true,
        },
        { status: 409 },
      );
    }
    confirmedSupplierPlan = confirmedSupplierPlanForSnapshot(
      order,
      result.supplierPlan,
      liveData.market,
    );
    if (!confirmedSupplierPlan) {
      await recordSupplierRefreshNeeded(
        "решением руководителя",
        result.supplierPlan,
        liveData.market,
      );
      return Response.json(
        {
          error:
            "Данные поставщика обновились. Пересчитайте заказ — агент сразу соберёт свежий вариант.",
          recalculate: true,
        },
        { status: 409 },
      );
    }
  }
  const currentInput = inputWithConversation(
    order,
    storedJson<ConversationMessage[]>(order.conversationJson, []),
  );
  const requestText = [
    currentInput.subject,
    currentInput.body,
    currentInput.attachment?.alt,
  ]
    .filter(Boolean)
    .join("\n");
  let approvedAlternative = false;
  if (result.product) {
    const originalProduct = result.product;
    const approvedProduct = approvedProductForOption(
      originalProduct,
      option,
      liveData.products,
    );
    if (
      approvedProduct.sku !== originalProduct.sku &&
      approvedProduct.stockKg < originalProduct.requestedKg
    ) {
      return Response.json(
        {
          error:
            "Остаток краски изменился. Пересчитайте заказ — руководитель получит варианты по свежим данным.",
        },
        { status: 409 },
      );
    }
    if (
      result.calculation &&
      approvedProduct.sku !== originalProduct.sku
    ) {
      return Response.json(
        {
          error:
            "Для заказа по площади пересчитайте расход выбранной краски перед подтверждением замены.",
        },
        { status: 409 },
      );
    }
    const approvedSourceProduct = liveData.products.find(
      (item) => item.sku === approvedProduct.sku,
    );
    if (
      approvedProduct.sku !== originalProduct.sku &&
      approvedSourceProduct &&
      !productHasRequestedColor(approvedSourceProduct, requestText)
    ) {
      return Response.json(
        {
          error:
            "У выбранной краски другой набор цветов. Пересчитайте заказ — агент предложит вариант для цвета клиента.",
        },
        { status: 409 },
      );
    }
    if (
      approvedProduct.sku !== originalProduct.sku &&
      productInventoryChanged(
        storedJson(order.inventorySnapshotJson, null),
        { product: approvedProduct },
        liveData.products,
      )
    ) {
      return Response.json(
        {
          error:
            "Остаток предложенной краски обновился. Пересчитайте заказ — руководитель получит свежие варианты.",
        },
        { status: 409 },
      );
    }
    approvedAlternative = approvedProduct.sku !== originalProduct.sku;
    result.product = approvedProduct;

    if (approvedAlternative) {
      const sourceProduct = liveData.products.find(
        (item) => item.sku === approvedProduct.sku,
      );
      if (sourceProduct) {
        const formatted = new Intl.NumberFormat("ru-RU");
        const checkedAt = new Intl.DateTimeFormat("ru-RU").format(new Date());
        result.market = marketView(
          sourceProduct,
          liveData.market,
          approvedProduct.requestedKg,
        );
        result.understood = understoodAfterProductChoice(
          result.understood,
          originalProduct,
          approvedProduct,
        );
        result.businessContext = `Руководитель выбрал краску «${approvedProduct.name}». Каталог допускает её как замену для этой задачи. Склад подтверждает ${formatted.format(
          approvedProduct.requestedKg,
        )} кг.`;
        result.zoneReason = `Руководитель выбрал замену: «${approvedProduct.name}». Весь объём подтверждён складом. Цена — ${formatted.format(
          approvedProduct.pricePerKg,
        )} ₽/кг.`;
        result.managerNote =
          "Выбранный вариант готов к резерву товара и отправке клиенту.";
        result.checks = [
          "Каталог допускает выбранную замену",
          "Весь объём подтверждён складом",
          `Цена ${formatted.format(
            approvedProduct.pricePerKg,
          )} ₽/кг сохраняет заработок завода`,
          "Письмо соответствует выбранному варианту",
        ];
        result.decisionBasis = [
          {
            fact: `Каталог допускает краску «${approvedProduct.name}» как замену краске «${originalProduct.name}» для этой задачи.`,
            source: "Каталог товаров и решение руководителя",
            checkedAt,
          },
          {
            fact: `Склад подтверждает весь объём: ${formatted.format(
              approvedProduct.requestedKg,
            )} из ${formatted.format(approvedProduct.stockKg)} кг.`,
            source: "Живой склад",
            checkedAt,
            stockVersion: `Обновление склада №${sourceProduct.stockRevision}`,
          },
          {
            fact: `Цена ${formatted.format(
              approvedProduct.pricePerKg,
            )} ₽/кг. Завод зарабатывает при цене от ${formatted.format(
              sourceProduct.minPricePerKg,
            )} ₽/кг.`,
            source: "Описание выбранной краски в каталоге",
            checkedAt,
          },
          ...(result.market.items.length
            ? [
                {
                  fact: result.market.position,
                  source: "Цены других поставщиков",
                  checkedAt,
                },
              ]
            : []),
        ];
        result.sources = Array.from(
          new Set([
            ...result.sources,
            "Каталог товаров",
            "Живой склад",
            "Решение руководителя",
            ...(result.market.items.length
              ? ["Цены других поставщиков"]
              : []),
          ]),
        );
      }
    }
  }

  const supplierPlan = supplierPlanAfterApproval(
    result.supplierPlan,
    option.id,
    confirmedSupplierPlan,
    now,
    approvedAlternative,
  );
  if (supplierPlan) result.supplierPlan = supplierPlan;
  else delete result.supplierPlan;

  const needsCustomerReply =
    result.resolvedIntent.target.state === "ambiguous" &&
    optionNeedsCustomerReply(option);
  const preparedReply = result.reply.body.trim();
  const selectedReply = option.reply.trim();
  result.reply = {
    subject:
      approvedAlternative && result.product
        ? `Предложение по заказу: ${result.product.name}`
        : result.reply.subject,
    body: (needsCustomerReply
      ? [selectedReply]
      : [preparedReply, selectedReply]
    )
      .filter((part, index, parts) => part && parts.indexOf(part) === index)
      .join("\n\n"),
  };
  if (needsCustomerReply) {
    const blockerQuestion =
      result.resolvedIntent.blocker?.question ??
      "Что именно нужно покрасить?";
    result.zone = "yellow";
    result.decision = "clarify";
    result.route = "needs_info";
    result.commitment = "none";
    result.missing = [blockerQuestion];
    result.zoneReason =
      "Руководитель выбрал следующий ход. Агент подготовил короткий вопрос клиенту.";
    result.managerNote =
      "Отправьте подготовленный вопрос клиенту. Ответ продолжит работу с тем же заказом.";
    result.review = {
      ...result.review,
      verdict: "Вопрос готов к отправке",
      notes: [
        "Вопрос соответствует выбранному варианту",
        "Ответ клиента продолжит тот же заказ",
      ],
    };
  }
  const nextStatus = approvalStatus(needsCustomerReply, result.commitment);
  if (!isCompleteAgentResult(result)) {
    return Response.json(
      {
        error: "После выбора варианта результат не прошёл проверку. Пересчитайте заказ.",
        recalculate: true,
      },
      { status: 409 },
    );
  }

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
      status: nextStatus,
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
        detail: confirmedSupplierPlan
        ? `${option.title}. Перед решением повторно проверены цена, объём, срок и дата. ${supplierPlanEventDetail(
            confirmedSupplierPlan,
          )}`
          : option.title,
        createdAt: now,
        ...eventMetadata(order),
      },
    transitionGuard,
  );
  const updateOrderQuery = db
    .update(orders)
    .set({
      status: nextStatus,
      zone: result.zone,
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
      { error: "Заказ уже обновился. Показываем свежие данные." },
      { status: 409 },
    );
  }

  return Response.json({
    ok: true,
    selected: option.title,
    status: nextStatus,
  });
}
