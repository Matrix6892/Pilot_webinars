import { desc, sql } from "drizzle-orm";
import { ensureDb, getDb } from "@/db";
import {
  inventoryChanges,
  orderEvents,
  orderResultHistory,
  orders,
} from "@/db/schema";
import {
  buildLedgerCsv,
} from "@/lib/ledger-export.mjs";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_CSV_ROWS_PER_SOURCE = 2_000;
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

  return new Response(null, {
    headers: {
      ...(format === "csv" ? csvHeaders : noStoreHeaders),
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

  await ensureDb();
  const db = getDb();
  const sourceLimit =
    format === "csv" ? MAX_CSV_ROWS_PER_SOURCE : limit;
  const orderQuery = db
    .select()
    .from(orders)
    .where(
      sql`date(${orders.createdAt}, '+3 hours') = date('now', '+3 hours')`,
    )
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(sourceLimit);
  const eventQuery = db
    .select()
    .from(orderEvents)
    .where(
      sql`date(${orderEvents.createdAt}, '+3 hours') = date('now', '+3 hours')`,
    )
    .orderBy(desc(orderEvents.id))
    .limit(sourceLimit);
  const inventoryChangeQuery = db
    .select()
    .from(inventoryChanges)
    .where(
      sql`date(${inventoryChanges.createdAt}, '+3 hours') = date('now', '+3 hours')`,
    )
    .orderBy(desc(inventoryChanges.id))
    .limit(sourceLimit);
  const resultHistoryQuery = db
    .select()
    .from(orderResultHistory)
    .where(
      sql`date(${orderResultHistory.createdAt}, '+3 hours') = date('now', '+3 hours')`,
    )
    .orderBy(desc(orderResultHistory.id))
    .limit(sourceLimit);

  const [rawOrders, rawEvents, rawChanges, rawResultHistory]: [
    Array<typeof orders.$inferSelect>,
    Array<typeof orderEvents.$inferSelect>,
    Array<typeof inventoryChanges.$inferSelect>,
    Array<typeof orderResultHistory.$inferSelect>,
  ] = await Promise.all([
    orderQuery,
    eventQuery,
    inventoryChangeQuery,
    resultHistoryQuery,
  ]);

  if (format === "csv") {
    return new Response(
      buildLedgerCsv({
        orders: rawOrders,
        events: rawEvents,
        inventoryChanges: rawChanges,
        resultHistory: rawResultHistory,
      }),
      {
        headers: {
          ...csvHeaders,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="koler-ledger.csv"',
        },
      },
    );
  }

  const ledgerOrders: LedgerOrder[] = rawOrders.map((order) => ({
    id: clipped(order.id, 80),
    subject: clipped(order.subject, 180),
    body: clipped(order.body),
    company: clipped(order.company, 140),
    website: clipped(order.website, 240),
    status: clipped(order.status, 40),
    zone: order.zone ? clipped(order.zone, 20) : null,
    mode: clipped(order.mode, 40),
    result: decodeStoredJson(order.resultJson),
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
  }));
  const events = rawEvents.map((event) => ({
    ...event,
    stage: clipped(event.stage, 80),
    title: clipped(event.title, 180),
    detail: clipped(event.detail, 1_200),
    state: clipped(event.state, 40),
    createdAt: clipped(event.createdAt, 64),
  }));
  const changes = rawChanges.map((change) => ({
    ...change,
    sku: clipped(change.sku, 80),
    reason: clipped(change.reason, 180),
    actor: clipped(change.actor, 80),
    createdAt: clipped(change.createdAt, 64),
  }));

  return Response.json(
    {
      generatedAt: new Date().toISOString(),
      syntheticData: true,
      limit,
      orders: ledgerOrders,
      events,
      inventoryChanges: changes,
      resultHistory: rawResultHistory.map((item) => ({
        ...item,
        replySubject: clipped(item.replySubject, 180),
        replyBody: clipped(item.replyBody),
        zoneReason: clipped(item.zoneReason, 1_200),
        optionsJson: clipped(item.optionsJson, MAX_STORED_JSON_LENGTH),
        result: decodeStoredJson(item.resultJson),
        inventorySnapshot: decodeStoredJson(item.inventorySnapshotJson),
        resultJson: undefined,
        inventorySnapshotJson: undefined,
      })),
    },
    { headers: noStoreHeaders },
  );
}
