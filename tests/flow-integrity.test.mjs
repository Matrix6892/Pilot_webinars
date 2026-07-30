import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function exportedFunctionFromTypeScript(
  source,
  functionName,
  context = {},
) {
  const sourceFile = ts.createSourceFile(
    "route.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = sourceFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === functionName,
  );
  assert.ok(declaration, `Expected ${functionName} to be exported`);
  assert.ok(
    declaration.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ),
    `Expected ${functionName} to be exported`,
  );

  const sourceWithoutExport = declaration
    .getText(sourceFile)
    .replace(/^export\s+/u, "");
  const javascript = ts.transpileModule(sourceWithoutExport, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  return runInNewContext(`${javascript}\n${functionName}`, context);
}

test("applies every migration and keeps one history row per source step", async () => {
  const directory = new URL("../drizzle/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const database = new DatabaseSync(":memory:");

  try {
    for (const file of files) {
      database.exec(await readFile(new URL(file, directory), "utf8"));
    }
    const columns = database
      .prepare("PRAGMA table_info(order_result_history)")
      .all()
      .map((column) => column.name);
    assert.ok(columns.includes("result_json"));
    assert.ok(columns.includes("inventory_snapshot_json"));
    assert.ok(columns.includes("agent_model"));
    assert.ok(columns.includes("reviewer_model"));
    assert.ok(columns.includes("source_key"));
    const orderColumns = database
      .prepare("PRAGMA table_info(orders)")
      .all()
      .map((column) => column.name);
    assert.ok(orderColumns.includes("action_token_hash"));

    const insert = database.prepare(`
      INSERT INTO order_result_history (
        order_id, round_no, zone, route, status, reason, source_key
      ) VALUES (?, 1, 'green', 'ready', 'ready_to_send', 'Склад перечитан', ?)
    `);
    insert.run("order-1", "inventory:1:КР-005:8");
    assert.throws(
      () => insert.run("order-1", "inventory:1:КР-005:8"),
      /UNIQUE constraint failed/iu,
    );
  } finally {
    database.close();
  }
});

test("protects public order actions and bounds public intake", async () => {
  const [ordersRoute, uploadsRoute, adminRoute, schema] = await Promise.all([
    readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/uploads/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /actionTokenHash:\s*text\("action_token_hash"\)/);
  assert.match(ordersRoute, /createOrderActionKey\(\)/);
  assert.match(ordersRoute, /orderActionKeyHash\(actionKey\)/);
  assert.match(ordersRoute, /canChangeOrder\(request, order\.actionTokenHash\)/);
  assert.match(ordersRoute, /\{ id, actionKey, mode, bridgeOnline: isLive \}/);
  assert.match(ordersRoute, /contentLength > 16_384/);
  assert.match(ordersRoute, /name:\s*"orders-minute"/);
  assert.match(ordersRoute, /Number\(queue\?\.total \?\? 0\) >= 100/);
  assert.match(uploadsRoute, /name:\s*"uploads-ten-minutes"/);
  assert.match(adminRoute, /name:\s*"admin-login-ten-minutes"/);
});

test("guards recalculation with fresh-stock and compare-and-set checks", async () => {
  const route = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const branch = route.slice(
    route.indexOf('if (action === "recalculate")'),
    route.indexOf('if (action === "reserve")'),
  );

  assert.match(branch, /savedResultUsesOldInventory\(order\)/);
  assert.match(branch, /eq\(orders\.status, order\.status\)/);
  assert.match(branch, /coalesce\(\$\{orders\.resultJson\}/);
  assert.match(branch, /coalesce\(\$\{orders\.inventorySnapshotJson\}/);
  assert.match(branch, /orders\.sentAt/);
  assert.match(branch, /\.returning\(\{ id: orders\.id \}\)/);
  assert.match(branch, /sourceKey:\s*`recalculate:/);
  assert.match(
    branch,
    /preserveConfirmedResearch\(\s*previousResult,\s*recalculatedResult,\s*\)/,
  );
  assert.match(
    route,
    /result\.research\?\.checked[\s\S]*?stage:\s*"company-context"[\s\S]*?title:\s*"Агент изучил сведения о компании"/,
  );
  assert.match(
    route,
    /result\.market\.items\.length > 0[\s\S]*?"Агент сравнил нашу цену с ценами других поставщиков"[\s\S]*?"Агент проверил цену по описанию краски в каталоге"/,
  );
});

test("keeps the live supplier market in the order data snapshot", async () => {
  const route = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const snapshotFromDemoData = exportedFunctionFromTypeScript(
    route,
    "snapshotFromDemoData",
  );
  const market = [
    {
      id: "floor--supplier",
      category: "краска для бетонного пола",
      competitor: "Поставщик",
      stockKg: 150,
      stockCheckedAt: "30.07.2026, 15:20",
      pricePerKg: 402,
      deliveryDays: 4,
    },
  ];

  const snapshot = snapshotFromDemoData({
    products: [
      {
        sku: "КР-003",
        name: "Краска для бетонного пола",
        stockKg: 420,
        stockRevision: 3,
        stockUpdatedAt: "2026-07-30T12:20:00.000Z",
      },
    ],
    market,
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshot.market)),
    market,
  );
});

test("loads inventory and supplier market from one live data source", async () => {
  const inventorySource = await readFile(
    new URL("../lib/inventory.ts", import.meta.url),
    "utf8",
  );
  const liveMarket = [
    {
      id: "floor--supplier",
      category: "краска для бетонного пола",
      competitor: "Поставщик",
      stockKg: 150,
      stockCheckedAt: "30.07.2026, 15:20",
      pricePerKg: 402,
      deliveryDays: 4,
    },
  ];
  const getDemoDataWithInventory = exportedFunctionFromTypeScript(
    inventorySource,
    "getDemoDataWithInventory",
    {
      asc: (value) => value,
      demoData: {
        products: [
          {
            sku: "КР-003",
            name: "Краска для бетонного пола",
            stockKg: 420,
          },
        ],
        market: [{ competitor: "Статический поставщик", stockKg: 260 }],
      },
      ensureDb: async () => {},
      getDb: () => ({
        select: () => ({
          from: () => ({
            orderBy: async () => [
              {
                sku: "КР-003",
                stockKg: 410,
                revision: 3,
                updatedAt: "2026-07-30T12:20:00.000Z",
              },
            ],
          }),
        }),
      }),
      getLiveMarket: async () => liveMarket,
      inventoryItems: { sku: "sku" },
      normalizedTimestamp: (value) => value,
    },
  );

  const result = await getDemoDataWithInventory();

  assert.equal(result.products[0].stockKg, 410);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.market)),
    liveMarket,
  );
});

test("logs the selected supplier volume beside the available volume", async () => {
  const agentRoute = await readFile(
    new URL("../app/api/agent/route.ts", import.meta.url),
    "utf8",
  );
  const supplierPlanDetail = exportedFunctionFromTypeScript(
    agentRoute,
    "supplierPlanDetail",
  );

  assert.equal(
    supplierPlanDetail({
      supplierPlan: {
        supplierName: "Индустрия Покрытий",
        ourKg: 420,
        supplierKg: 200,
        supplierStockKg: 260,
        supplierPricePerKg: 402,
        deliveryDays: 4,
        stockCheckedAt: "30.07.2026, 10:40",
        total: 254700,
      },
    }),
    "Для полного заказа найден поставщик «Индустрия Покрытий»: выбрано 200 кг из доступных 260 кг по 402 ₽/кг, срок 4 дн., данные от 30.07.2026, 10:40. Наша часть — 420 кг, весь заказ — 254 700 ₽.",
  );
});

test("retries an errored order in the same card with a compare-and-set transition", async () => {
  const route = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const retry = route.slice(
    route.indexOf('if (action === "retry")'),
    route.indexOf("if (subject.length < 5"),
  );

  assert.match(retry, /canChangeOrder\(request, failedOrder\.actionTokenHash\)/);
  assert.match(retry, /eq\(orders\.status, "error"\)/);
  assert.match(retry, /coalesce\(\$\{orders\.resultJson\}/);
  assert.match(retry, /coalesce\(\$\{orders\.inventorySnapshotJson\}/);
  assert.match(retry, /orders\.roundNo/);
  assert.match(retry, /orders\.sentAt/);
  assert.match(retry, /stage:\s*"retry"/);
  assert.match(retry, /status:\s*"queued"/);
  assert.match(
    retry,
    /await db\.batch\(\[\s*retryEventQuery,\s*retryOrderQuery,\s*\]\)/,
  );
  assert.doesNotMatch(
    retry,
    /roundNo:\s*failedOrder\.roundNo\s*\+\s*1|resultJson:\s*null|inventorySnapshotJson:\s*null/,
  );
});

test("preserves confirmed company research while refreshing commercial facts", async () => {
  const route = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const preserveConfirmedResearch = exportedFunctionFromTypeScript(
    route,
    "preserveConfirmedResearch",
  );
  const confirmedSource = {
    title: "Карточка компании",
    url: "https://example.test/company",
    checkedAt: "29.07.2026",
    fact: "Компания расширяет производство.",
  };
  const previous = {
    research: {
      checked: true,
      summary: "Компания проверена по открытым источникам.",
      sources: [confirmedSource],
    },
    businessContext:
      "Компания выпускает технику. Небольшой заказ похож на пробную партию.",
    sources: ["Письмо клиента", "Проверенные открытые источники"],
    product: { sku: "OLD", stockKg: 12 },
    market: { summary: "Старые цены" },
    reply: { body: "Старое письмо" },
  };
  const recalculated = {
    research: {
      checked: false,
      summary: "Открытые источники в этом расчёте не запрашивались.",
      sources: [],
    },
    businessContext: "Свежий склад подтверждает всю партию.",
    sources: ["Письмо клиента", "Живой склад"],
    product: { sku: "КР-001", stockKg: 480 },
    market: { summary: "Свежие цены" },
    route: "ready",
    reply: { body: "Свежее письмо" },
  };

  const result = preserveConfirmedResearch(previous, recalculated);

  assert.deepEqual(result.product, recalculated.product);
  assert.deepEqual(result.market, recalculated.market);
  assert.deepEqual(result.reply, recalculated.reply);
  assert.deepEqual(result.research.sources, [confirmedSource]);
  assert.equal(result.research.summary, previous.research.summary);
  assert.match(result.businessContext, /Свежий расчёт по складу:/u);
  assert.match(result.businessContext, /Свежий склад подтверждает всю партию/u);
  assert.match(
    result.businessContext,
    /Подтверждённые сведения о клиенте:/u,
  );
  assert.match(result.businessContext, /Небольшой заказ похож на пробную партию/u);
  assert.equal(
    result.sources.filter(
      (source) => source === "Проверенные открытые источники",
    ).length,
    1,
  );

  const freshResearch = {
    ...recalculated,
    research: {
      checked: true,
      summary: "Свежая проверка",
      sources: [{ ...confirmedSource, title: "Свежий источник" }],
    },
  };
  assert.equal(
    preserveConfirmedResearch(previous, freshResearch),
    freshResearch,
  );

  const unverifiedPrevious = {
    ...previous,
    research: {
      checked: false,
      summary: "Агент нашёл ссылки для проверки.",
      sources: [confirmedSource],
    },
  };
  assert.equal(
    preserveConfirmedResearch(unverifiedPrevious, recalculated),
    recalculated,
  );
});

test("commits clarification and autonomous customer reply as complete transitions", async () => {
  const route = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const clarification = route.slice(
    route.indexOf('if (action === "send_clarification")'),
    route.indexOf('if (action === "customer_reply")'),
  );
  const customerReply = route.slice(
    route.indexOf('if (action === "customer_reply")'),
    route.indexOf('if (action === "recalculate")'),
  );
  const autonomousReply = customerReply.slice(
    customerReply.indexOf("const result = buildDemoResult("),
  );

  assert.match(clarification, /const transitionGuard = and\(/);
  assert.match(clarification, /eq\(orders\.status, "clarification_ready"\)/);
  assert.match(clarification, /coalesce\(\$\{orders\.resultJson\}/);
  assert.match(clarification, /coalesce\(\$\{orders\.conversationJson\}/);
  assert.match(clarification, /coalesce\(\$\{orders\.sentAt\}/);
  assert.match(clarification, /insertOrderEventWhen\(/);
  assert.match(
    clarification,
    /await db\.batch\(\[\s*clarificationEventQuery,\s*updateOrderQuery,\s*\]\)/,
  );
  assert.match(
    clarification,
    /createdAt:\s*now[\s\S]*?updatedAt:\s*now/,
  );
  assert.doesNotMatch(clarification, /db\.insert\(orderEvents\)/);

  assert.match(autonomousReply, /const transitionGuard = and\(/);
  assert.match(autonomousReply, /eq\(orders\.status, "awaiting_customer"\)/);
  assert.match(autonomousReply, /coalesce\(\$\{orders\.resultJson\}/);
  assert.match(autonomousReply, /coalesce\(\$\{orders\.conversationJson\}/);
  assert.match(
    autonomousReply,
    /coalesce\(\$\{orders\.inventorySnapshotJson\}/,
  );
  assert.match(autonomousReply, /coalesce\(\$\{orders\.sentAt\}/);
  assert.match(autonomousReply, /insertResultHistoryWhen\(/);
  assert.match(autonomousReply, /transitionEvents\.map\(/);
  assert.match(autonomousReply, /insertOrderEventWhen\(/);
  assert.equal(
    (customerReply.match(/managerDecision:\s*null/g) ?? []).length,
    2,
  );
  assert.equal(
    (customerReply.match(/managerOptionId:\s*null/g) ?? []).length,
    2,
  );
  assert.equal(
    (customerReply.match(/managerDecidedAt:\s*null/g) ?? []).length,
    2,
  );
  assert.match(
    autonomousReply,
    /await db\.batch\(\[\s*historyQuery,\s*\.\.\.eventQueries,\s*updateOrderQuery,\s*\]\)/,
  );
  assert.doesNotMatch(autonomousReply, /await appendResultHistory\(/);
  assert.doesNotMatch(autonomousReply, /db\.insert\(orderEvents\)/);
});

test("commits critical order transitions together with their ledger rows", async () => {
  const [agentRoute, ordersRoute] = await Promise.all([
    readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8"),
  ]);

  const liveResult = agentRoute.slice(
    agentRoute.indexOf('if (action === "result")'),
    agentRoute.indexOf('if (action === "error")'),
  );
  const recalculation = ordersRoute.slice(
    ordersRoute.indexOf('if (action === "recalculate")'),
    ordersRoute.indexOf('if (action === "reserve")'),
  );
  const reservation = ordersRoute.slice(
    ordersRoute.indexOf('if (action === "reserve")'),
    ordersRoute.indexOf('if (action === "send")'),
  );
  const send = ordersRoute.slice(
    ordersRoute.indexOf('if (action === "send")'),
    ordersRoute.indexOf('if (action !== "approve"'),
  );
  const approval = ordersRoute.slice(
    ordersRoute.lastIndexOf("const now = new Date().toISOString()"),
  );

  for (const branch of [
    liveResult,
    recalculation,
    reservation,
    send,
    approval,
  ]) {
    assert.match(branch, /await db\.batch\(/);
    assert.match(branch, /const transitionGuard = and\(/);
  }
  assert.match(
    liveResult,
    /insertResultHistoryWhen\([\s\S]*?insertOrderEventWhen\([\s\S]*?await db\.batch\(\[\s*historyQuery,\s*closeActiveEventsQuery,\s*supplierEventQuery,\s*decisionEventQuery,\s*updateOrderQuery,\s*\]\)/,
  );
  assert.match(
    recalculation,
    /insertResultHistoryWhen\([\s\S]*?transitionEvents\.map\([\s\S]*?await db\.batch\(\[\s*historyQuery,\s*\.\.\.eventQueries,\s*updateOrderQuery,\s*\]\)/,
  );
  assert.match(
    reservation,
    /eq\(orders\.status, "ready_to_send"\)[\s\S]*?stage:\s*"reserve"[\s\S]*?status:\s*"reserved"[\s\S]*?await db\.batch\(\[\s*reserveEventQuery,\s*updateOrderQuery,\s*\]\)/,
  );
  assert.match(
    send,
    /eq\(orders\.status, "reserved"\)[\s\S]*?insertOrderEventWhen\([\s\S]*?await db\.batch\(\[\s*sentEventQuery,\s*updateOrderQuery,\s*\]\)/,
  );
  assert.match(
    approval,
    /insertResultHistoryWhen\([\s\S]*?insertOrderEventWhen\([\s\S]*?await db\.batch\(\[\s*historyQuery,\s*approvalEventQuery,\s*updateOrderQuery,\s*\]\)/,
  );
  assert.doesNotMatch(liveResult, /await appendResultHistory\(/);
  assert.doesNotMatch(recalculation, /await appendResultHistory\(/);
  assert.doesNotMatch(approval, /await appendResultHistory\(/);
});

test("reserves only the stock-confirmed part of a split delivery", async () => {
  const ordersRoute = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const reserveEventDetail = exportedFunctionFromTypeScript(
    ordersRoute,
    "reserveEventDetail",
  );

  assert.equal(
    reserveEventDetail({
      name: "Краска для дерева на улице",
      requestedKg: 100,
      stockKg: 40,
    }),
    "40 кг краски «Краска для дерева на улице» закреплены за заказом. Оставшиеся 60 кг записаны в выбранный план поставки. В рабочей системе этот шаг передаст резерв в учётную систему.",
  );
  assert.equal(
    reserveEventDetail({
      name: "Краска для дерева на улице",
      requestedKg: 100,
      stockKg: 180,
    }),
    "100 кг краски «Краска для дерева на улице» закреплены за заказом. В рабочей системе этот шаг передаст резерв в учётную систему.",
  );
  assert.equal(
    reserveEventDetail({
      name: "Краска для бетонного пола",
      requestedKg: 1100,
      stockKg: 1100,
    }),
    "1 100 кг краски «Краска для бетонного пола» закреплены за заказом. В рабочей системе этот шаг передаст резерв в учётную систему.",
  );
});

test("rechecks the other supplier before approval, reserve and send", async () => {
  const ordersRoute = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const supplierPlanEventDetail = exportedFunctionFromTypeScript(
    ordersRoute,
    "supplierPlanEventDetail",
  );
  const plan = {
    supplierName: "Индустрия Покрытий",
    supplierKg: 200,
    supplierStockKg: 260,
    supplierPricePerKg: 402,
    deliveryDays: 4,
    stockCheckedAt: "30.07.2026, 10:40",
    ourKg: 420,
    total: 254700,
  };

  assert.equal(
    supplierPlanEventDetail(plan),
    "В таблице «Индустрия Покрытий» указано 200 кг из доступных 260 кг по 402 ₽/кг, срок 4 дн., данные от 30.07.2026, 10:40. Наша часть — 420 кг, весь заказ — 254 700 ₽.",
  );

  const reservation = ordersRoute.slice(
    ordersRoute.indexOf('if (action === "reserve")'),
    ordersRoute.indexOf('if (action === "send")'),
  );
  const approval = ordersRoute.slice(
    ordersRoute.indexOf('if (action !== "approve"'),
  );
  const send = ordersRoute.slice(
    ordersRoute.indexOf('if (action === "send")'),
    ordersRoute.indexOf('if (action !== "approve"'),
  );
  for (const branch of [reservation, approval, send]) {
    assert.match(branch, /confirmSupplierPlan\(/);
    assert.match(
      branch,
      /Данные поставщика обновились\. Пересчитайте заказ/,
    );
    assert.match(branch, /recalculate:\s*true/);
    assert.match(branch, /\{ status: 409 \}/);
  }
  assert.match(
    reservation,
    /reserveEventDetail\(\s*result\.product,\s*confirmedSupplierPlan,\s*\)/,
  );
  assert.match(
    approval,
    /Перед решением повторно проверены цена, объём, срок и дата/,
  );
  assert.match(
    send,
    /Перед записью отправки повторно проверены цена, объём, срок и дата поставщика/,
  );
  assert.match(
    ordersRoute,
    /title:\s*"Нужен свежий расчёт совместной поставки"/,
  );
});

test("keeps the supplier check when recalculation rebuilds the route", async () => {
  const ordersRoute = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const recalculation = ordersRoute.slice(
    ordersRoute.indexOf('if (action === "recalculate")'),
    ordersRoute.indexOf('if (action === "reserve")'),
  );

  assert.match(
    recalculation,
    /\[\s*"inventory",\s*"market",\s*"partner-stock",\s*"review",\s*"decision",\s*\]\.includes\(event\.stage\)/,
  );
  assert.match(
    recalculation,
    /supplierOutdated[\s\S]*?confirmSupplierPlan\([\s\S]*?!inventoryOutdated[\s\S]*?!supplierOutdated/,
  );
});

test("applies an approved stocked analogue to the product and reserve", async () => {
  const ordersRoute = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const approvedProductForOption = exportedFunctionFromTypeScript(
    ordersRoute,
    "approvedProductForOption",
  );
  const product = {
    sku: "КР-001",
    name: "Краска для металла на улице",
    stockKg: 300,
    requestedKg: 800,
    firstDeliveryKg: 200,
    color: "RAL 9005",
    pricePerKg: 349,
    total: 279200,
    replenishmentDays: 5,
  };
  const products = [
    {
      ...product,
      analogues: ["КР-002"],
    },
    {
      sku: "КР-002",
      name: "Универсальная краска для металла",
      stockKg: 900,
      pricePerKg: 382,
      replenishmentDays: 4,
      analogues: [],
    },
  ];

  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        approvedProductForOption(
          product,
          {
            id: "замена-краски",
            title:
              "Поставить весь объём краской «Универсальная краска для металла»",
            reply:
              "Можем поставить весь объём краской «Универсальная краска для металла».",
          },
          products,
        ),
      ),
    ),
    {
      sku: "КР-002",
      name: "Универсальная краска для металла",
      stockKg: 900,
      requestedKg: 800,
      firstDeliveryKg: 200,
      color: "RAL 9005",
      pricePerKg: 382,
      total: 305600,
      replenishmentDays: 4,
    },
  );

  const skuOnly = approvedProductForOption(
    product,
    {
      id: "alternative",
      title: "Поставить КР-002",
      rationale: "Весь объём есть на складе.",
      tradeoff: "Цена указана в письме.",
      reply: "Готовы поставить КР-002.",
    },
    products,
  );
  assert.equal(skuOnly.sku, "КР-002");

  const approval = ordersRoute.slice(
    ordersRoute.indexOf('if (action !== "approve"'),
  );
  assert.match(
    approval,
    /approvedProduct\.stockKg < originalProduct\.requestedKg[\s\S]*?Остаток краски изменился\. Пересчитайте заказ/,
  );
});

test("routes a manager question back to the same customer conversation", async () => {
  const ordersRoute = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const optionNeedsCustomerReply = exportedFunctionFromTypeScript(
    ordersRoute,
    "optionNeedsCustomerReply",
  );

  assert.equal(
    optionNeedsCustomerReply({
      id: "график-клиента",
      reply:
        "Напишите, какой объём нужен для старта и к какой дате потребуется остальная краска?",
    }),
    true,
  );
  assert.equal(
    optionNeedsCustomerReply({
      id: "две-поставки",
      reply: "Первые 300 кг готовы отгрузить сейчас, вторую партию — через пять дней.",
    }),
    false,
  );
  assert.equal(
    optionNeedsCustomerReply({
      id: "оплата-за-план",
      reply:
        "Готовы рассмотреть оплату после поставки. Направьте ожидаемый график, и мы подготовим условия.",
    }),
    true,
  );
  assert.equal(
    optionNeedsCustomerReply({
      id: "две-поставки",
      reply:
        "Первые 300 кг готовы отгрузить сейчас. Назовите точный цвет, и мы отложим доступную партию.",
    }),
    true,
  );

  const approval = ordersRoute.slice(
    ordersRoute.indexOf('if (action !== "approve"'),
  );
  assert.match(
    approval,
    /needsCustomerReply[\s\S]*?result\.route = "needs_info"[\s\S]*?"clarification_ready"/,
  );
  assert.match(
    approval,
    /\.set\(\{[\s\S]*?status:\s*nextStatus,[\s\S]*?zone:\s*result\.zone,[\s\S]*?managerDecision:/,
  );
  assert.match(
    approval,
    /approvedAlternative[\s\S]*?result\.market = marketView\([\s\S]*?result\.understood = understoodAfterProductChoice\([\s\S]*?result\.zoneReason =[\s\S]*?result\.checks = \[[\s\S]*?result\.decisionBasis = \[/,
  );
  assert.match(
    approval,
    /result\.managerNote =[\s\S]*?Отправьте подготовленный вопрос клиенту[\s\S]*?verdict:\s*"Вопрос готов к отправке"/,
  );
});

test("replaces live model product facts after the manager chooses another paint", async () => {
  const ordersRoute = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const understoodAfterProductChoice = exportedFunctionFromTypeScript(
    ordersRoute,
    "understoodAfterProductChoice",
  );
  const originalProduct = {
    sku: "КР-001",
    name: "Краска по металлу с защитой от ржавчины",
    stockKg: 300,
    requestedKg: 800,
    pricePerKg: 349,
    total: 279200,
    replenishmentDays: 7,
  };
  const approvedProduct = {
    sku: "КР-002",
    name: "Краска для металлической техники на улице",
    stockKg: 900,
    requestedKg: 800,
    pricePerKg: 382,
    total: 305600,
    replenishmentDays: 14,
  };

  const understood = understoodAfterProductChoice(
    [
      "Клиент: Завод заказчика",
      "Подходящий товар: КР-001 — Краска по металлу с защитой от ржавчины",
      "Объём: 800 кг",
      "Остаток: 300 кг",
      "Цена: 349 ₽/кг",
    ],
    originalProduct,
    approvedProduct,
  );

  assert.deepEqual(JSON.parse(JSON.stringify(understood)), [
    "Клиент: Завод заказчика",
    "Объём: 800 кг",
    "Выбранная краска: Краска для металлической техники на улице",
    "Склад подтверждает весь заказ: 800 кг из 900 кг",
    "Цена: 382 ₽/кг",
  ]);
  assert.doesNotMatch(understood.join(" "), /КР-001|349|300 кг/iu);
});
