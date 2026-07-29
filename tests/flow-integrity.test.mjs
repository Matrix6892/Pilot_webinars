import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function exportedFunctionFromTypeScript(source, functionName) {
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
  return runInNewContext(`${javascript}\n${functionName}`);
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
    route.indexOf('if (action === "send")'),
  );

  assert.match(branch, /savedResultUsesOldInventory\(order\)/);
  assert.match(branch, /eq\(orders\.status, order\.status\)/);
  assert.match(branch, /coalesce\(\$\{orders\.resultJson\}/);
  assert.match(branch, /coalesce\(\$\{orders\.inventorySnapshotJson\}/);
  assert.match(branch, /orders\.sentAt/);
  assert.match(branch, /\.returning\(\{ id: orders\.id \}\)/);
  assert.match(branch, /sourceKey:\s*`inventory:/);
  assert.match(
    branch,
    /preserveConfirmedResearch\(\s*previousResult,\s*recalculatedResult,\s*\)/,
  );
  assert.match(
    route,
    /result\.research\?\.checked[\s\S]*?stage:\s*"company-context"[\s\S]*?title:\s*"Сведения о компании учтены"/,
  );
  assert.match(
    route,
    /result\.market\.items\.length > 0[\s\S]*?"Агент сравнил нашу цену с ценами других поставщиков"[\s\S]*?"Агент проверил цену по карточке товара"/,
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
    ordersRoute.indexOf('if (action === "send")'),
  );
  const send = ordersRoute.slice(
    ordersRoute.indexOf('if (action === "send")'),
    ordersRoute.indexOf('if (action !== "approve"'),
  );
  const approval = ordersRoute.slice(
    ordersRoute.lastIndexOf("const now = new Date().toISOString()"),
  );

  for (const branch of [liveResult, recalculation, send, approval]) {
    assert.match(branch, /await db\.batch\(/);
    assert.match(branch, /const transitionGuard = and\(/);
  }
  assert.match(
    liveResult,
    /insertResultHistoryWhen\([\s\S]*?insertOrderEventWhen\([\s\S]*?await db\.batch\(\[\s*historyQuery,\s*closeActiveEventsQuery,\s*decisionEventQuery,\s*updateOrderQuery,\s*\]\)/,
  );
  assert.match(
    recalculation,
    /insertResultHistoryWhen\([\s\S]*?transitionEvents\.map\([\s\S]*?await db\.batch\(\[\s*historyQuery,\s*\.\.\.eventQueries,\s*updateOrderQuery,\s*\]\)/,
  );
  assert.match(
    send,
    /insertOrderEventWhen\([\s\S]*?await db\.batch\(\[\s*sentEventQuery,\s*updateOrderQuery,\s*\]\)/,
  );
  assert.match(
    approval,
    /insertResultHistoryWhen\([\s\S]*?insertOrderEventWhen\([\s\S]*?await db\.batch\(\[\s*historyQuery,\s*approvalEventQuery,\s*updateOrderQuery,\s*\]\)/,
  );
  assert.doesNotMatch(liveResult, /await appendResultHistory\(/);
  assert.doesNotMatch(recalculation, /await appendResultHistory\(/);
  assert.doesNotMatch(approval, /await appendResultHistory\(/);
});
