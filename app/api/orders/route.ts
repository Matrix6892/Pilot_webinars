import { asc, eq, sql } from "drizzle-orm";
import { ensureDb, getDb } from "@/db";
import { orderEvents, orders, systemState } from "@/db/schema";
import { buildDemoResult, type AgentResult } from "@/lib/demo-engine";

export const dynamic = "force-dynamic";

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
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

function stagedEvents(orderId: string, result: AgentResult) {
  const rows = [
    {
      orderId,
      stage: "received",
      title: "Заказ принят",
      detail: "Письмо преобразовано в рабочую карточку.",
    },
    {
      orderId,
      stage: "understanding",
      title: "Потребность разобрана",
      detail: result.understood.join(" · "),
    },
  ];

  if (result.decision === "clarify") {
    rows.push({
      orderId,
      stage: "clarification",
      title: "Обнаружены пробелы",
      detail: result.missing.join(" · "),
    });
  } else {
    rows.push(
      {
        orderId,
        stage: "inventory",
        title: "Склад и цена проверены",
        detail: result.product
          ? `${result.product.name}: ${result.product.stockKg} кг в наличии, ${result.product.pricePerKg} ₽/кг`
          : "Товар не определён",
      },
      {
        orderId,
        stage: "market",
        title: "Рынок сопоставлен",
        detail: result.market.summary,
      },
      {
        orderId,
        stage: "review",
        title: "Руководитель-модель проверил",
        detail: result.review.verdict,
      },
    );
  }

  rows.push({
    orderId,
    stage: "decision",
    title: `Маршрут: ${result.zone === "green" ? "зелёный" : result.zone === "yellow" ? "жёлтый" : "красный"}`,
    detail: result.zoneReason,
  });

  return rows;
}

export async function GET(request: Request) {
  await ensureDb();
  const url = new URL(request.url);
  if (url.searchParams.get("system") === "1") {
    return Response.json({
      bridgeOnline: await bridgeOnline(),
      provider: "OpenCode Go",
      agent: "OpenCode",
    });
  }

  const id = clean(url.searchParams.get("id"), 80);
  if (!id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }

  const db = getDb();
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) {
    return Response.json({ error: "order not found" }, { status: 404 });
  }

  const events = await db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, id))
    .orderBy(asc(orderEvents.id));

  return Response.json({
    order: {
      ...order,
      result: order.resultJson ? JSON.parse(order.resultJson) : null,
      resultJson: undefined,
    },
    events,
  });
}

export async function POST(request: Request) {
  await ensureDb();
  const payload = (await request.json()) as Record<string, unknown>;
  const subject = clean(payload.subject, 180);
  const body = clean(payload.body, 4000);
  const company = clean(payload.company, 140);
  const website = clean(payload.website, 240);

  if (subject.length < 5 || body.length < 20) {
    return Response.json(
      { error: "Добавьте тему и описание заказа хотя бы в двух предложениях." },
      { status: 400 },
    );
  }

  const id = `ord_${crypto.randomUUID().replaceAll("-", "")}`;
  const isLive = await bridgeOnline();
  const mode = isLive ? "opencode-live" : "autonomous-demo";
  const db = getDb();

  await db.insert(orders).values({
    id,
    subject,
    body,
    company,
    website,
    status: isLive ? "queued" : "completed",
    mode,
  });

  if (isLive) {
    await db.insert(orderEvents).values({
      orderId: id,
      stage: "received",
      title: "Заказ принят",
      detail: "Локальный OpenCode получил задачу в очередь.",
    });
  } else {
    const result = buildDemoResult({ subject, body, company, website });
    const status = result.zone === "red" ? "awaiting_approval" : "completed";
    await db
      .update(orders)
      .set({
        status,
        zone: result.zone,
        resultJson: JSON.stringify(result),
        agentModel: "Автономная демо-логика",
        reviewerModel: "Проверка правил",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(orders.id, id));
    await db.insert(orderEvents).values(stagedEvents(id, result));
  }

  return Response.json({ id, mode, bridgeOnline: isLive }, { status: 201 });
}

export async function PATCH(request: Request) {
  await ensureDb();
  const payload = (await request.json()) as Record<string, unknown>;
  const id = clean(payload.id, 80);
  const optionId = clean(payload.optionId, 80);
  if (!id || !optionId) {
    return Response.json({ error: "id and optionId are required" }, { status: 400 });
  }

  const db = getDb();
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order?.resultJson) {
    return Response.json({ error: "result not found" }, { status: 404 });
  }

  const result = JSON.parse(order.resultJson) as AgentResult;
  const option = result.options.find((item) => item.id === optionId);
  if (!option) {
    return Response.json({ error: "option not found" }, { status: 400 });
  }

  result.reply = {
    subject: result.reply.subject,
    body: option.reply,
  };

  await db
    .update(orders)
    .set({
      status: "completed",
      managerDecision: option.title,
      resultJson: JSON.stringify(result),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(orders.id, id));

  await db.insert(orderEvents).values({
    orderId: id,
    stage: "approval",
    title: "Руководитель согласовал вариант",
    detail: option.title,
  });

  return Response.json({ ok: true, selected: option.title });
}
