import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { ensureDb, getDb } from "@/db";
import { orderEvents, orders, systemState } from "@/db/schema";
import modelCatalog from "@/data/models.json";
import { buildDemoResult, type AgentResult } from "@/lib/demo-engine";

export const dynamic = "force-dynamic";

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
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
        title: "Демонстрационный рынок сопоставлен",
        detail: result.market.summary,
      },
      {
        orderId,
        stage: "review",
        title: "Правила стенда проверили ответ",
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
      models: modelCatalog.options,
    });
  }

  if (url.searchParams.get("stats") === "1") {
    const db = getDb();
    const [stats] = await db
      .select({
        total: sql<number>`count(*)`,
        completed: sql<number>`coalesce(sum(case when ${orders.status} in ('ready_to_send', 'sent') then 1 else 0 end), 0)`,
        awaitingApproval: sql<number>`coalesce(sum(case when ${orders.status} = 'awaiting_approval' then 1 else 0 end), 0)`,
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
    const result = buildDemoResult({
      subject: order.subject,
      body: order.body,
      company: order.company,
      website: order.website,
    });
    const recoveredStatus =
      result.zone === "red" ? "awaiting_approval" : "ready_to_send";
    const [recovered] = await db
      .update(orders)
      .set({
        status: recoveredStatus,
        zone: result.zone,
        mode: "autonomous-demo",
        resultJson: JSON.stringify(result),
        agentModel: "Автономные правила стенда",
        reviewerModel: "Правила стенда",
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
        title: "Автономные правила продолжили заказ",
        detail:
          "Связь с локальным OpenCode завершилась. Карточка обработана по каталогу и коммерческим границам стенда.",
      });
      const continuation = stagedEvents(id, result).filter(
        (event) =>
          event.stage !== "received" &&
          (order.status !== "processing" || event.stage !== "understanding"),
      );
      if (continuation.length) {
        await db.insert(orderEvents).values(continuation);
      }
      order = recovered;
    }
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
  const selectedModel = requestedModel(payload.model);

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
    status: isLive ? "queued" : "ready_to_send",
    mode,
    requestedModel: selectedModel,
  });

  if (isLive) {
    await db.insert(orderEvents).values({
      orderId: id,
      stage: "received",
      title: "Заказ принят",
      detail: `Локальный OpenCode получил задачу в очередь. Выбранная модель: ${modelLabel(selectedModel)}.`,
    });
  } else {
    const result = buildDemoResult({ subject, body, company, website });
    const status =
      result.zone === "red" ? "awaiting_approval" : "ready_to_send";
    await db
      .update(orders)
      .set({
        status,
        zone: result.zone,
        resultJson: JSON.stringify(result),
        agentModel: "Автономные правила стенда",
        reviewerModel: "Правила стенда",
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

  if (action === "send") {
    if (order.status !== "ready_to_send" || order.sentAt) {
      return Response.json(
        { error: "Письмо ещё не готово к отправке." },
        { status: 409 },
      );
    }

    const now = new Date().toISOString();
    const [sentOrder] = await db
      .update(orders)
      .set({
        status: "sent",
        sentAt: now,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(orders.id, id),
          eq(orders.status, "ready_to_send"),
          sql`${orders.sentAt} is null`,
        ),
      )
      .returning({ id: orders.id });
    if (!sentOrder) {
      return Response.json(
        { error: "Состояние заказа уже изменилось. Обновите карточку." },
        { status: 409 },
      );
    }

    await db.insert(orderEvents).values({
      orderId: id,
      stage: "sent",
      title: "Демо-отправка зафиксирована",
      detail:
        "Ответ записан как отправленный. Корпоративный почтовый шлюз подключается отдельным адаптером.",
    });

    return Response.json({ ok: true, status: "sent", sentAt: now });
  }

  if (action !== "approve" || !optionId) {
    return Response.json(
      { error: "Для согласования выберите один вариант." },
      { status: 400 },
    );
  }

  if (order.status !== "awaiting_approval") {
    return Response.json(
      { error: "Заказ уже согласован или завершён." },
      { status: 409 },
    );
  }

  if (!order.resultJson) {
    return Response.json(
      { error: "Решение ещё не готово. Обновите карточку." },
      { status: 404 },
    );
  }

  const result = JSON.parse(order.resultJson) as AgentResult;
  const option = result.options.find((item) => item.id === optionId);
  if (!option) {
    return Response.json(
      {
        error:
          "Выбранный вариант недоступен. Обновите карточку и выберите снова.",
      },
      { status: 400 },
    );
  }

  result.reply = {
    subject: result.reply.subject,
    body: option.reply,
  };

  const [approvedOrder] = await db
    .update(orders)
    .set({
      status: "ready_to_send",
      managerDecision: option.title,
      resultJson: JSON.stringify(result),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(eq(orders.id, id), eq(orders.status, "awaiting_approval")),
    )
    .returning({ id: orders.id });
  if (!approvedOrder) {
    return Response.json(
      { error: "Состояние заказа уже изменилось. Обновите карточку." },
      { status: 409 },
    );
  }

  await db.insert(orderEvents).values({
    orderId: id,
    stage: "approval",
    title: "Участник согласовал вариант в роли руководителя",
    detail: option.title,
  });

  return Response.json({
    ok: true,
    selected: option.title,
    status: "ready_to_send",
  });
}
