import { desc, sql } from "drizzle-orm";
import { ensureDb, getDb } from "@/db";
import { isAdminRequest } from "@/lib/admin-auth";
import {
  inventoryChanges,
  orderEvents,
  orderResultHistory,
  orders,
} from "@/db/schema";
import {
  buildLedgerCsv,
  projectLedgerOrder,
  projectLedgerResultHistory,
  queryForLedgerFormat,
} from "@/lib/ledger-export.mjs";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_TEXT_LENGTH = 4_000;
const MAX_STORED_JSON_LENGTH = 32_000;

const noStoreHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const csvHeaders = {
  "Cache-Control": "public, max-age=0, s-maxage=10, stale-while-revalidate=20",
  "X-Content-Type-Options": "nosniff",
};

type PublicLedgerOrder = Pick<
  typeof orders.$inferSelect,
  "id" | "status" | "zone" | "mode" | "roundNo" | "sentAt" | "createdAt" | "updatedAt"
>;

export function syntheticLedgerOrder(order: PublicLedgerOrder) {
  return {
    id: clipped(order.id, 80),
    subject: "",
    body: "",
    company: "",
    website: "",
    status: clipped(order.status, 40),
    zone: order.zone ? clipped(order.zone, 20) : null,
    mode: clipped(order.mode, 40),
    result: null,
    managerDecision: null,
    managerOptionId: null,
    managerDecidedAt: null,
    attachment: null,
    conversation: [],
    roundNo: order.roundNo,
    inventorySnapshot: null,
    agentModel: null,
    reviewerModel: null,
    requestedModel: null,
    sentAt: order.sentAt ? clipped(order.sentAt, 64) : null,
    createdAt: clipped(order.createdAt, 64),
    updatedAt: clipped(order.updatedAt, 64),
  };
}

function clipped(value: string | null, max = MAX_TEXT_LENGTH) {
  if (!value) return value ?? "";
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function boundedJson(value: unknown, depth = 0): unknown {
  if (depth >= 6) return "[сокращено]";
  if (typeof value === "string") return clipped(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((item) => boundedJson(item, depth + 1));
    if (value.length > items.length) items.push("[список сокращён]");
    return items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([key, item]) => [key, boundedJson(item, depth + 1)]),
    );
  }
  return null;
}

function decodeStoredJson(value: string | null) {
  if (!value) return null;
  if (value.length > MAX_STORED_JSON_LENGTH) {
    return { truncated: true, originalLength: value.length };
  }
  let candidate: unknown = value;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (typeof candidate !== "string") return boundedJson(candidate);
    const text = candidate.trim();
    if (!text) return null;
    try {
      candidate = JSON.parse(text);
      continue;
    } catch {
      try {
        const decoded = decodeURIComponent(text);
        if (decoded !== text) {
          candidate = decoded;
          continue;
        }
      } catch {
        // Legacy rows may contain malformed percent escapes.
      }
      return null;
    }
  }

  return boundedJson(candidate);
}

function requestedLimit(url: URL) {
  const raw = url.searchParams.get("limit");
  if (!raw) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, MAX_LIMIT);
}

type LedgerOrder = {
  id: string;
  subject: string;
  body: string;
  company: string;
  website: string;
  status: string;
  zone: string | null;
  mode: string;
  result: unknown;
  managerDecision: string | null;
  managerOptionId: string | null;
  managerDecidedAt: string | null;
  attachment: unknown;
  conversation: unknown;
  roundNo: number;
  inventorySnapshot: unknown;
  agentModel: string | null;
  reviewerModel: string | null;
  requestedModel: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function HEAD(request: Request) {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "csv") {
    return new Response(null, { status: 400, headers: noStoreHeaders });
  }
  const admin = await isAdminRequest(request);

  return new Response(null, {
    headers: {
      ...(format === "csv" && !admin ? csvHeaders : noStoreHeaders),
      "Content-Type":
        format === "csv"
          ? "text/csv; charset=utf-8"
          : "application/json; charset=utf-8",
    },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "csv") {
    return Response.json(
      {
        error: "Поддерживаются форматы json и csv.",
        code: "invalid_format",
      },
      { status: 400, headers: noStoreHeaders },
    );
  }
  const parsedLimit = requestedLimit(url);
  if (format === "json" && !parsedLimit) {
    return Response.json(
      {
        error: `Параметр limit должен быть целым числом от 1 до ${MAX_LIMIT}.`,
        code: "invalid_limit",
      },
      { status: 400, headers: noStoreHeaders },
    );
  }
  const limit = parsedLimit ?? DEFAULT_LIMIT;

  const admin = await isAdminRequest(request);
  await ensureDb();
  const db = getDb();
  const orderQuery = queryForLedgerFormat(
    admin
      ? db
          .select()
          .from(orders)
          .where(
            sql`date(${orders.createdAt}, '+3 hours') = date('now', '+3 hours')`,
          )
          .orderBy(desc(orders.createdAt), desc(orders.id))
      : db
          .select({
            id: orders.id,
            status: orders.status,
            zone: orders.zone,
            mode: orders.mode,
            roundNo: orders.roundNo,
            sentAt: orders.sentAt,
            createdAt: orders.createdAt,
            updatedAt: orders.updatedAt,
          })
          .from(orders)
          .where(
            sql`date(${orders.createdAt}, '+3 hours') = date('now', '+3 hours')`,
          )
          .orderBy(desc(orders.createdAt), desc(orders.id)),
    format,
    limit,
  );
  const eventQuery = queryForLedgerFormat(
    admin
      ? db
          .select()
          .from(orderEvents)
          .where(
            sql`date(${orderEvents.createdAt}, '+3 hours') = date('now', '+3 hours')`,
          )
          .orderBy(desc(orderEvents.id))
      : db
          .select({
            id: orderEvents.id,
            orderId: orderEvents.orderId,
            stage: orderEvents.stage,
            title: orderEvents.title,
            detail: sql<string>`''`,
            state: orderEvents.state,
            createdAt: orderEvents.createdAt,
          })
          .from(orderEvents)
          .where(
            sql`date(${orderEvents.createdAt}, '+3 hours') = date('now', '+3 hours')`,
          )
          .orderBy(desc(orderEvents.id)),
    format,
    limit,
  );
  const inventoryChangeQuery = queryForLedgerFormat(
    admin
      ? db
          .select()
          .from(inventoryChanges)
          .where(
            sql`date(${inventoryChanges.createdAt}, '+3 hours') = date('now', '+3 hours')`,
          )
          .orderBy(desc(inventoryChanges.id))
      : db
          .select({
            id: inventoryChanges.id,
            sku: inventoryChanges.sku,
            revision: inventoryChanges.revision,
            beforeStockKg: inventoryChanges.beforeStockKg,
            afterStockKg: inventoryChanges.afterStockKg,
            reason: sql<string>`''`,
            actor: inventoryChanges.actor,
            createdAt: inventoryChanges.createdAt,
          })
          .from(inventoryChanges)
          .where(
            sql`date(${inventoryChanges.createdAt}, '+3 hours') = date('now', '+3 hours')`,
          )
          .orderBy(desc(inventoryChanges.id)),
    format,
    limit,
  );
  const resultHistoryQuery = admin
    ? queryForLedgerFormat(
        db
          .select()
          .from(orderResultHistory)
          .where(
            sql`date(${orderResultHistory.createdAt}, '+3 hours') = date('now', '+3 hours')`,
          )
          .orderBy(desc(orderResultHistory.id)),
        format,
        limit,
      )
    : Promise.resolve([]);

  const [rawOrders, rawEvents, rawChanges, rawResultHistory] = await Promise.all([
    orderQuery,
    eventQuery,
    inventoryChangeQuery,
    resultHistoryQuery,
  ]);

  if (format === "csv") {
    const csvOrders = admin
      ? (rawOrders as Array<typeof orders.$inferSelect>).map(
          projectLedgerOrder,
        )
      : (rawOrders as Array<PublicLedgerOrder>).map(syntheticLedgerOrder);
    const csvHistory = admin
      ? (rawResultHistory as Array<typeof orderResultHistory.$inferSelect>).map(
          projectLedgerResultHistory,
        )
      : [];
    return new Response(
      buildLedgerCsv({
        orders: csvOrders,
        events: rawEvents,
        inventoryChanges: rawChanges,
        resultHistory: csvHistory,
      }),
      {
        headers: {
          ...(admin ? noStoreHeaders : csvHeaders),
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="koler-ledger.csv"',
        },
      },
    );
  }

  const ledgerOrders: LedgerOrder[] = admin
    ? (rawOrders as Array<typeof orders.$inferSelect>).map((order) => ({
        id: clipped(order.id, 80),
        subject: clipped(order.subject, 180),
        body: clipped(order.body),
        company: clipped(order.company, 140),
        website: clipped(order.website, 240),
        status: clipped(order.status, 40),
        zone: order.zone ? clipped(order.zone, 20) : null,
        mode: clipped(order.mode, 40),
        result: projectLedgerOrder(order).result,
        managerDecision: order.managerDecision
          ? clipped(order.managerDecision, 240)
          : null,
        managerOptionId: order.managerOptionId
          ? clipped(order.managerOptionId, 80)
          : null,
        managerDecidedAt: order.managerDecidedAt
          ? clipped(order.managerDecidedAt, 64)
          : null,
        attachment: decodeStoredJson(order.attachmentJson),
        conversation: decodeStoredJson(order.conversationJson),
        roundNo: order.roundNo,
        inventorySnapshot: decodeStoredJson(order.inventorySnapshotJson),
        agentModel: order.agentModel ? clipped(order.agentModel, 120) : null,
        reviewerModel: order.reviewerModel
          ? clipped(order.reviewerModel, 120)
          : null,
        requestedModel: order.requestedModel
          ? clipped(order.requestedModel, 120)
          : null,
        sentAt: order.sentAt ? clipped(order.sentAt, 64) : null,
        createdAt: clipped(order.createdAt, 64),
        updatedAt: clipped(order.updatedAt, 64),
      }))
    : (rawOrders as Array<PublicLedgerOrder>).map(syntheticLedgerOrder);
  const events = (rawEvents as Array<typeof orderEvents.$inferSelect>).map(
    (event) => ({
    id: event.id,
    orderId: event.orderId,
    stage: clipped(event.stage, 80),
    title: clipped(event.title, 180),
    detail: admin ? clipped(event.detail, 1_200) : "",
    state: clipped(event.state, 40),
    createdAt: clipped(event.createdAt, 64),
    }),
  );
  const changes = (rawChanges as Array<typeof inventoryChanges.$inferSelect>).map(
    (change) => ({
    id: change.id,
    sku: clipped(change.sku, 80),
    revision: change.revision,
    beforeStockKg: change.beforeStockKg,
    afterStockKg: change.afterStockKg,
    reason: admin ? clipped(change.reason, 180) : "",
    actor: clipped(change.actor, 80),
    createdAt: clipped(change.createdAt, 64),
    }),
  );

  return Response.json(
    {
      generatedAt: new Date().toISOString(),
      syntheticData: true,
      limit,
      orders: ledgerOrders,
      events,
      inventoryChanges: changes,
      resultHistory: admin
        ? (rawResultHistory as Array<typeof orderResultHistory.$inferSelect>).map(
            (item) => {
              const projected = projectLedgerResultHistory(item);
              return {
                ...projected,
                replySubject: clipped(projected.replySubject, 180),
                replyBody: clipped(projected.replyBody),
                zoneReason: clipped(projected.zoneReason, 1_200),
                optionsJson: clipped(
                  projected.optionsJson,
                  MAX_STORED_JSON_LENGTH,
                ),
                inventorySnapshot: decodeStoredJson(
                  item.inventorySnapshotJson,
                ),
                inventorySnapshotJson: undefined,
              };
            },
          )
        : [],
    },
    { headers: noStoreHeaders },
  );
}
