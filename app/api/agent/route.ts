import { asc, eq, sql } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { ensureDb, getDb } from "@/db";
import { orderEvents, orders, systemState } from "@/db/schema";

export const dynamic = "force-dynamic";

function expectedToken() {
  return (
    (env as unknown as { BRIDGE_TOKEN?: string }).BRIDGE_TOKEN ??
    "local-demo-bridge"
  );
}

function authorized(request: Request) {
  return request.headers.get("authorization") === `Bearer ${expectedToken()}`;
}

function denied() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  await ensureDb();
  const db = getDb();
  const [job] = await db
    .select()
    .from(orders)
    .where(eq(orders.status, "queued"))
    .orderBy(asc(orders.createdAt))
    .limit(1);

  if (!job) return Response.json({ job: null });

  await db
    .update(orders)
    .set({ status: "processing", updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(orders.id, job.id));
  await db.insert(orderEvents).values({
    orderId: job.id,
    stage: "understanding",
    title: "OpenCode разбирает письмо",
    detail: "Агент выделяет потребность и выбирает необходимые источники.",
    state: "active",
  });

  return Response.json({ job });
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
    const result = payload.result as { zone?: string; decision?: string } | undefined;
    if (!result || !["green", "yellow", "red"].includes(String(result.zone))) {
      return Response.json({ error: "invalid result" }, { status: 400 });
    }
    const status = result.zone === "red" ? "awaiting_approval" : "completed";
    await db
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
      .where(eq(orders.id, orderId));
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
    await db
      .update(orders)
      .set({ status: "error", updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(orders.id, orderId));
    await db.insert(orderEvents).values({
      orderId,
      stage: "error",
      title: "Агент остановился",
      detail: String(payload.detail ?? "Не удалось завершить обработку.").slice(
        0,
        1200,
      ),
      state: "error",
    });
    return Response.json({ ok: true });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
