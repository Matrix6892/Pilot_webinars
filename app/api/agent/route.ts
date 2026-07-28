import { and, asc, eq, lt, sql } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { ensureDb, getDb } from "@/db";
import { orderEvents, orders, systemState } from "@/db/schema";

export const dynamic = "force-dynamic";

function validResult(value: unknown): value is {
  zone: "green" | "yellow" | "red";
  reply: { subject: string; body: string };
  understood: unknown[];
  missing: unknown[];
  options: unknown[];
  checks: unknown[];
  sources: unknown[];
} {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  const reply = result.reply as Record<string, unknown> | undefined;
  return (
    ["green", "yellow", "red"].includes(String(result.zone)) &&
    Array.isArray(result.understood) &&
    Array.isArray(result.missing) &&
    Array.isArray(result.options) &&
    Array.isArray(result.checks) &&
    Array.isArray(result.sources) &&
    Boolean(
      reply &&
        typeof reply.subject === "string" &&
        typeof reply.body === "string",
    )
  );
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
  await db
    .update(orders)
    .set({ status: "queued", updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(
      and(
        eq(orders.status, "processing"),
        lt(orders.updatedAt, sql`datetime('now', '-6 minutes')`),
      ),
    );
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
    title: "OpenCode разбирает письмо",
    detail: "Агент выделяет потребность и выбирает необходимые источники.",
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
    .select({ id: orders.id, status: orders.status })
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
    if (!validResult(result)) {
      return Response.json({ error: "invalid result" }, { status: 400 });
    }
    const status =
      result.zone === "red" ? "awaiting_approval" : "ready_to_send";
    const [updatedOrder] = await db
      .update(orders)
      .set({
        status,
        zone: String(result.zone),
        resultJson: JSON.stringify(result),
        agentModel: String(payload.agentModel ?? "OpenCode").slice(0, 120),
        reviewerModel: String(payload.reviewerModel ?? "OpenCode reviewer").slice(
          0,
          120,
        ),
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(and(eq(orders.id, orderId), eq(orders.status, "processing")))
      .returning({ id: orders.id });
    if (!updatedOrder) {
      return Response.json(
        { error: "order state changed" },
        { status: 409 },
      );
    }
    await db
      .update(orderEvents)
      .set({ state: "done" })
      .where(
        and(
          eq(orderEvents.orderId, orderId),
          eq(orderEvents.state, "active"),
        ),
      );
    await db.insert(orderEvents).values({
      orderId,
      stage: "decision",
      title: `Решение: ${result.zone === "green" ? "зелёная" : result.zone === "yellow" ? "жёлтая" : "красная"} зона`,
      detail:
        result.zone === "red"
          ? "Нестандартное предложение передано руководителю."
          : "Ответ проверен и готов.",
    });
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
      title: "Агент остановился",
      detail:
        "OpenCode остановил обработку. Письмо и журнал сохранены; запустите новую карточку.",
      state: "error",
    });
    return Response.json({ ok: true });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
