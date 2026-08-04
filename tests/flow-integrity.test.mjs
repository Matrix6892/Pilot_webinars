import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  decodeStoredAgentResult,
  isCompleteAgentResult,
  managerFallbackAgentResult,
} from "../lib/agent-guard.mjs";
import { confirmSupplierPlan } from "../lib/supplier-plan.mjs";
import { resolveVisionImageUrl } from "../lib/upload-guard.mjs";
import { isSearchResultUrl } from "../lib/public-web-url.mjs";

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
    for (const column of [
      "claim_id",
      "claimed_by",
      "attempt_no",
      "lease_until",
    ]) {
      assert.ok(orderColumns.includes(column));
    }
    const eventColumns = database
      .prepare("PRAGMA table_info(order_events)")
      .all()
      .map((column) => column.name);
    for (const column of ["round_no", "claim_id", "attempt_no"]) {
      assert.ok(eventColumns.includes(column));
    }
    database
      .prepare(
        "INSERT INTO order_events (order_id, stage, title, round_no, claim_id, attempt_no) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("event-order", "agent", "Событие", 3, "claim-3", 4);
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT round_no, claim_id, attempt_no FROM order_events WHERE order_id = 'event-order'",
          )
          .get(),
      },
      { round_no: 3, claim_id: "claim-3", attempt_no: 4 },
    );

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

test("fences stale workers after a renewable 90 second lease", async () => {
  const directory = new URL("../drizzle/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const database = new DatabaseSync(":memory:");

  try {
    for (const file of files) {
      database.exec(await readFile(new URL(file, directory), "utf8"));
    }
    database
      .prepare(
        "INSERT INTO orders (id, subject, body, status, mode, round_no) VALUES (?, ?, ?, 'queued', 'opencode-live', 1)",
      )
      .run("lease-order", "Заказ", "Нужно 2000 кг");
    const claim = database.prepare(`
      UPDATE orders
      SET status = 'processing',
          claim_id = ?,
          claimed_by = ?,
          attempt_no = attempt_no + 1,
          lease_until = datetime(?, '+90 seconds')
      WHERE id = 'lease-order' AND status = 'queued'
    `);
    const guardedActiveEvent = database.prepare(`
      INSERT INTO order_events (order_id, stage, title, detail, state)
      SELECT id, 'agent', ?, '', 'done'
      FROM orders
      WHERE id = 'lease-order'
        AND status = 'processing'
        AND round_no = 1
        AND claim_id = ?
        AND lease_until > ?
    `);
    const terminal = database.prepare(`
      UPDATE orders
      SET status = 'ready_to_send',
          zone = 'green',
          result_json = ?
      WHERE id = 'lease-order'
        AND status = 'processing'
        AND round_no = 1
        AND claim_id = ?
        AND lease_until > ?
    `);
    const guardedHistory = database.prepare(`
      INSERT INTO order_result_history (
        order_id, round_no, zone, route, status, reason, source_key
      )
      SELECT id, round_no, 'green', 'ready', 'ready_to_send',
             'Решение рабочей модели', 'model:' || round_no
      FROM orders
      WHERE id = 'lease-order'
        AND status = 'ready_to_send'
        AND round_no = 1
        AND claim_id = ?
        AND result_json = ?
    `);
    const guardedDecisionEvent = database.prepare(`
      INSERT INTO order_events (order_id, stage, title, detail, state)
      SELECT id, 'decision', 'Решение готово', '', 'done'
      FROM orders
      WHERE id = 'lease-order'
        AND status = 'ready_to_send'
        AND round_no = 1
        AND claim_id = ?
        AND result_json = ?
    `);
    const clearClaim = database.prepare(`
      UPDATE orders
      SET claim_id = NULL,
          claimed_by = NULL,
          lease_until = NULL
      WHERE id = 'lease-order'
        AND status = 'ready_to_send'
        AND round_no = 1
        AND claim_id = ?
        AND result_json = ?
    `);
    const startedAt = "2026-07-31 09:00:00";
    const terminalResult = '{"schemaVersion":2}';

    assert.equal(
      claim.run("claim-a", "worker-a", startedAt).changes,
      1,
    );
    assert.equal(
      database
        .prepare(`
          UPDATE orders
          SET lease_until = datetime(?, '+90 seconds')
          WHERE id = 'lease-order'
            AND status = 'processing'
            AND round_no = 1
            AND claim_id = 'claim-a'
            AND lease_until > ?
        `)
        .run(
          "2026-07-31 09:00:30",
          "2026-07-31 09:00:30",
        ).changes,
      1,
    );
    assert.equal(
      database
        .prepare(`
          UPDATE orders
          SET status = 'queued',
              claim_id = NULL,
              claimed_by = NULL,
              lease_until = NULL
          WHERE status = 'processing'
            AND mode LIKE 'opencode%'
            AND lease_until <= ?
        `)
        .run("2026-07-31 09:02:01").changes,
      1,
    );
    assert.equal(
      claim.run(
        "claim-b",
        "worker-b",
        "2026-07-31 09:02:01",
      ).changes,
      1,
    );

    assert.equal(
      guardedActiveEvent.run(
        "Устаревшее событие",
        "claim-a",
        "2026-07-31 09:02:02",
      ).changes,
      0,
    );
    assert.equal(
      terminal.run(
        terminalResult,
        "claim-a",
        "2026-07-31 09:02:02",
      ).changes,
      0,
    );
    assert.equal(
      guardedActiveEvent.run(
        "Событие новой попытки",
        "claim-b",
        "2026-07-31 09:02:02",
      ).changes,
      1,
    );
    assert.equal(
      terminal.run(
        terminalResult,
        "claim-b",
        "2026-07-31 09:02:02",
      ).changes,
      1,
    );
    assert.equal(
      guardedHistory.run("claim-b", terminalResult).changes,
      1,
    );
    assert.equal(
      guardedDecisionEvent.run("claim-b", terminalResult).changes,
      1,
    );
    assert.equal(
      clearClaim.run("claim-b", terminalResult).changes,
      1,
    );
    assert.equal(
      terminal.run(
        terminalResult,
        "claim-b",
        "2026-07-31 09:02:03",
      ).changes,
      0,
    );

    const order = database
      .prepare(
        "SELECT status, claim_id, claimed_by, attempt_no FROM orders WHERE id = 'lease-order'",
      )
      .get();
    assert.deepEqual({ ...order }, {
      status: "ready_to_send",
      claim_id: null,
      claimed_by: null,
      attempt_no: 2,
    });
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM order_events WHERE order_id = 'lease-order' AND stage = 'decision'",
        )
        .get().count,
      1,
    );
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM order_result_history WHERE order_id = 'lease-order'",
        )
        .get().count,
      1,
    );

    const [agentRoute, bridge] = await Promise.all([
      readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../scripts/agent-bridge.mjs", import.meta.url), "utf8"),
    ]);
    assert.match(agentRoute, /JOB_LEASE_SECONDS = 90/);
    assert.match(
      agentRoute,
      /eq\(orders\.status, "processing"\)[\s\S]*?orders\.mode\} like 'opencode%'/,
    );
    assert.match(
      agentRoute,
      /eq\(orders\.roundNo, roundNo\)[\s\S]*?eq\(orders\.claimId, claimId\)[\s\S]*?leaseUntil\} > CURRENT_TIMESTAMP/,
    );
    assert.match(
      agentRoute,
      /db\.batch\(\[claimQuery, initialEventQuery\]\)/,
    );
    assert.match(
      agentRoute,
      /if \(action === "renew"\)[\s\S]*?\.where\(claimGuard\)/,
    );
    assert.match(bridge, /const leaseRenewalMs = 30_000/);
    assert.match(
      bridge,
      /action:\s*"renew",\s*\.\.\.claimPayload\(job\)/,
    );
    assert.match(
      bridge,
      /action:\s*"result",\s*\.\.\.claimPayload\(job\)/,
    );
    assert.match(
      bridge,
      /action:\s*"error",\s*\.\.\.claimPayload\(job\)/,
    );
  } finally {
    database.close();
  }
});

test("requeue closes stale active events and records retry metadata atomically", async () => {
  const directory = new URL("../drizzle/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  const database = new DatabaseSync(":memory:");

  try {
    for (const file of files) {
      database.exec(await readFile(new URL(file, directory), "utf8"));
    }
    database
      .prepare(
        "INSERT INTO orders (id, subject, body, status, mode, round_no, claim_id, attempt_no, lease_until) VALUES ('stale-event-order', 'Заказ', 'Письмо', 'processing', 'opencode-live', 2, 'claim-old', 3, '2026-07-31 09:00:00')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO order_events (order_id, stage, title, state, round_no, claim_id, attempt_no) VALUES ('stale-event-order', 'understanding', 'Старый шаг', 'active', 2, 'claim-old', 3)",
      )
      .run();
    const requeueAt = "2026-07-31T09:02:01.000Z";
    database
      .prepare(
        "UPDATE orders SET status = 'queued', claim_id = NULL, claimed_by = NULL, lease_until = NULL, updated_at = ? WHERE status = 'processing' AND mode LIKE 'opencode%' AND lease_until <= '2026-07-31 09:02:01'",
      )
      .run(requeueAt);
    database
      .prepare(
        "UPDATE order_events SET state = 'error' WHERE state = 'active' AND EXISTS (SELECT 1 FROM orders WHERE orders.id = order_events.order_id AND orders.status = 'queued' AND orders.updated_at = ?)",
      )
      .run(requeueAt);
    database
      .prepare(
        "INSERT INTO order_events (order_id, stage, title, detail, state, round_no, claim_id, attempt_no, created_at) SELECT id, 'retry', 'Заказ вернулся в очередь', '', 'done', round_no, NULL, attempt_no, ? FROM orders WHERE status = 'queued' AND mode LIKE 'opencode%' AND claim_id IS NULL AND lease_until IS NULL AND updated_at = ?",
      )
      .run(requeueAt, requeueAt);

    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM order_events WHERE order_id = 'stale-event-order' AND state = 'active'",
        )
        .get().count,
      0,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT state, round_no, claim_id, attempt_no FROM order_events WHERE order_id = 'stale-event-order' ORDER BY id DESC LIMIT 1",
          )
          .get(),
      },
      { state: "done", round_no: 2, claim_id: null, attempt_no: 3 },
    );
    assert.equal(
      database
        .prepare(
          "SELECT state FROM order_events WHERE order_id = 'stale-event-order' AND stage = 'understanding'",
        )
        .get().state,
      "error",
    );
  } finally {
    database.close();
  }
});

test("protects public order actions and bounds public intake", async () => {
  const [ordersRoute, agentRoute, uploadsRoute, adminRoute, schema] =
    await Promise.all([
    readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/uploads/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /actionTokenHash:\s*text\("action_token_hash"\)/);
  assert.match(ordersRoute, /createOrderActionKey\(\)/);
  assert.match(ordersRoute, /orderActionKeyHash\(actionKey\)/);
  assert.match(ordersRoute, /canReadOrder\(request, capability\.actionTokenHash, id\)/);
  assert.match(
    ordersRoute,
    /createdOrderResponse\(\s*\{[\s\S]*?id,\s*actionKey,\s*mode,\s*bridgeOnline: isLive,\s*recorded: recordedMode/,
  );
  assert.match(ordersRoute, /Set-Cookie.*orderCapabilityCookie/);
  const safeAttachment = exportedFunctionFromTypeScript(
    ordersRoute,
    "safeAttachment",
    {
      clean: (value, max) =>
        typeof value === "string" ? value.trim().slice(0, max) : "",
      resolveVisionImageUrl,
    },
  );
  assert.equal(
    safeAttachment({
      name: "photo.jpg",
      src: "//attacker.example/photo.jpg",
      alt: "Фото",
    }),
    null,
  );
  assert.match(ordersRoute, /contentLength > 16_384/);
  assert.match(ordersRoute, /name:\s*"orders-minute"/);
  assert.match(ordersRoute, /Number\(queue\?\.total \?\? 0\) >= 100/);
  assert.match(uploadsRoute, /name:\s*"uploads-ten-minutes"/);
  assert.match(adminRoute, /name:\s*"admin-login-ten-minutes"/);
  const claimQueryStart = agentRoute.indexOf("const claimQuery");
  const returningStart = agentRoute.indexOf(".returning({", claimQueryStart);
  const claimedJobResponse = agentRoute.slice(
    returningStart,
    agentRoute.indexOf("});", returningStart),
  );
  assert.match(claimedJobResponse, /attachmentJson:\s*orders\.attachmentJson/);
  assert.match(
    claimedJobResponse,
    /inventorySnapshotJson:\s*orders\.inventorySnapshotJson/,
  );
  assert.doesNotMatch(
    claimedJobResponse,
    /actionTokenHash|claimedBy|attemptNo|leaseUntil/,
  );
});

test("replays a client order id and capability without duplicate rows", async () => {
  const route = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const clean = (value, max) =>
    typeof value === "string" ? value.trim().slice(0, max) : "";
  const clientOrderId = "018fa799-39e8-7903-ba25-0514d02e70b8";
  const clientActionKey = "a".repeat(64);
  const clientOrderIdentity = exportedFunctionFromTypeScript(
    route,
    "clientCreateIdentity",
    {
      clientOrderIdPattern:
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
      clientActionKeyPattern: /^[0-9a-f]{64}$/iu,
    },
  );
  const createRequestFingerprint = exportedFunctionFromTypeScript(
    route,
    "createRequestFingerprint",
    {
      clean,
      safeAttachment: () => null,
      requestedModel: () => "opencode-go/deepseek-v4-pro",
      recordedDemoKinds: new Set(["fence-photo"]),
    },
  );
  const matchesCreateRequest = exportedFunctionFromTypeScript(
    route,
    "matchesCreateRequest",
  );
  const resolveCreateReplay = exportedFunctionFromTypeScript(
    route,
    "resolveCreateReplay",
    { matchesCreateRequest },
  );
  const payload = {
    clientOrderId,
    clientActionKey,
    subject: "Запрос покрытия",
    body: "Нужно 100 кг краски.",
    company: "ООО «Спектр»",
    model: "opencode-go/deepseek-v4-pro",
  };
  const identity = clientOrderIdentity(payload);
  assert.equal(identity.clientOrderId, clientOrderId);
  assert.equal(identity.clientActionKey, clientActionKey);

  const directory = new URL("../drizzle/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  const database = new DatabaseSync(":memory:");
  try {
    for (const file of files) {
      database.exec(await readFile(new URL(file, directory), "utf8"));
    }
    const create = (keyHash, currentPayload = payload) => {
      const currentIdentity = clientOrderIdentity(currentPayload);
      const currentFingerprint = createRequestFingerprint(currentPayload);
      const existing = database
        .prepare(
          "SELECT id, action_token_hash AS actionTokenHash, subject, body, company, website, requested_model AS requestedModel, mode, attachment_json AS attachmentJson FROM orders WHERE id = ?",
        )
        .get(currentIdentity.clientOrderId);
      const decision = resolveCreateReplay(
        existing,
        keyHash,
        currentFingerprint,
      );
      if (decision.kind === "conflict") return { status: 409 };
      if (decision.kind === "replay") return { status: 200, id: decision.id };
      database
        .prepare(
          "INSERT INTO orders (id, subject, body, company, mode, requested_model, action_token_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          currentIdentity.clientOrderId,
          currentFingerprint.subject,
          currentFingerprint.body,
          currentFingerprint.company,
          currentFingerprint.mode,
          currentFingerprint.requestedModel,
          keyHash,
        );
      database
        .prepare(
          "INSERT INTO order_events (order_id, stage, title, round_no, attempt_no) VALUES (?, 'received', 'Заказ принят', 1, 0)",
        )
        .run(currentIdentity.clientOrderId);
      database
        .prepare(
          "INSERT INTO order_result_history (order_id, round_no, zone, route, status, reason, source_key) VALUES (?, 1, 'red', 'manager', 'awaiting_approval', 'Первое решение', 'initial:1')",
        )
        .run(currentIdentity.clientOrderId);
      return { status: 201, id: currentIdentity.clientOrderId };
    };

    assert.deepEqual(create("hash-a"), { status: 201, id: clientOrderId });
    assert.deepEqual(create("hash-a"), { status: 200, id: clientOrderId });
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM orders WHERE id = ?")
        .get(clientOrderId).count,
      1,
    );
    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM order_events WHERE order_id = ?")
        .get(clientOrderId).count,
      1,
    );
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM order_result_history WHERE order_id = ?",
        )
        .get(clientOrderId).count,
      1,
    );
    assert.deepEqual(create("hash-b"), { status: 409 });
    assert.deepEqual(
      create("hash-a", { ...payload, body: "Другой текст заявки." }),
      { status: 409 },
    );
  } finally {
    database.close();
  }
});

test("gates order detail before sensitive reads and keeps public ledger synthetic", async () => {
  const [ordersRoute, ledgerRoute] = await Promise.all([
    readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/ledger/route.ts", import.meta.url), "utf8"),
  ]);
  const canReadOrder = exportedFunctionFromTypeScript(
    ordersRoute,
    "canReadOrder",
    {
      Headers,
      Request,
      orderCapabilityCookieName: (orderId) => `koler_order_capability_${orderId}`,
      canChangeOrder: async (request) =>
        request.headers.get("x-order-key") === "valid-capability",
      cookieValue: () => "",
    },
  );
  assert.equal(
    await canReadOrder(
      new Request("https://koler.test/api/orders?id=ord_1"),
      "hash",
      "ord_1",
    ),
    false,
  );
  assert.equal(
    await canReadOrder(
      new Request("https://koler.test/api/orders?id=ord_1", {
        headers: { "x-order-key": "valid-capability" },
      }),
      "hash",
      "ord_1",
    ),
    true,
  );

  class UrlOnlyRequest {
    constructor(input, init = {}) {
      assert.equal(typeof input, "string");
      this.url = input;
      this.headers = init.headers;
    }
  }
  const cookieCapabilityReader = exportedFunctionFromTypeScript(
    ordersRoute,
    "canReadOrder",
    {
      Headers,
      Request: UrlOnlyRequest,
      orderCapabilityCookieName: (orderId) => `koler_order_capability_${orderId}`,
      canChangeOrder: async (request) =>
        request.headers.get("x-order-key") === "a".repeat(64),
      cookieValue: () => "a".repeat(64),
    },
  );
  assert.equal(
    await cookieCapabilityReader(
      new Request("https://koler.test/api/orders?id=ord_cookie"),
      "hash",
      "ord_cookie",
    ),
    true,
  );

  const detailAuth = ordersRoute.indexOf(
    "if (!(await canReadOrder(request, capability.actionTokenHash, id)))",
  );
  const detailRead = ordersRoute.indexOf(
    "const [order] = await db\n    .select()",
    detailAuth,
  );
  assert.ok(detailAuth >= 0 && detailRead > detailAuth);
  assert.match(ordersRoute, /return Response\.json\([\s\S]*?headers: noStoreHeaders/);
  assert.match(ledgerRoute, /const admin = await isAdminRequest\(request\)/);
  assert.match(ledgerRoute, /resultHistoryQuery = admin/);
  assert.match(ledgerRoute, /detail: sql<string>`''`/u);
  assert.match(ledgerRoute, /resultHistory: admin[\s\S]*?: \[\]/);
  assert.match(ledgerRoute, /syntheticData: true/);

  const syntheticLedgerOrder = exportedFunctionFromTypeScript(
    ledgerRoute,
    "syntheticLedgerOrder",
    {
      clipped: (value, max) =>
        typeof value === "string" ? value.slice(0, max) : value ?? "",
    },
  );
  const summary = syntheticLedgerOrder({
    id: "ord_1",
    status: "awaiting_approval",
    zone: "red",
    mode: "opencode-live",
    roundNo: 2,
    sentAt: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:01:00.000Z",
  });
  assert.equal(summary.subject, "");
  assert.equal(summary.body, "");
  assert.equal(summary.conversation.length, 0);
  assert.equal(summary.result, null);
  assert.equal(summary.attachment, null);
  assert.equal(summary.inventorySnapshot, null);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /Исходное письмо|conversation-body|supplier-snapshot|photo-ref|attachment-ref/iu,
  );
});

test("normalizes malformed stored results into a complete manager fallback", async () => {
  const route = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const storedAgentResult = exportedFunctionFromTypeScript(
    route,
    "storedAgentResult",
    { decodeStoredAgentResult, isCompleteAgentResult, managerFallbackAgentResult },
  );
  const result = storedAgentResult(
    '{"reply":{"body":"partial private customer prose"}',
  );

  assert.equal(result.zone, "red");
  assert.equal(result.route, "manager");
  assert.equal(result.commitment, "none");
  assert.equal(result.product, null);
  assert.equal(isCompleteAgentResult(result), true);
  assert.doesNotMatch(JSON.stringify(result), /partial private customer prose/iu);
  assert.match(
    route,
    /const result = storedAgentResult\(item\.resultJson\)[\s\S]*?replyBody: result\?\.reply\.body \?\? ""/,
  );
});

test("requires observed public HTTPS URLs for transported web evidence", async () => {
  const route = await readFile(
    new URL("../app/api/agent/route.ts", import.meta.url),
    "utf8",
  );
  const publicHttpsUrl = exportedFunctionFromTypeScript(
    route,
    "publicHttpsUrl",
    { URL },
  );
  const validateResultTransportEvidence = exportedFunctionFromTypeScript(
    route,
    "validateResultTransportEvidence",
    { createHash, isSearchResultUrl, publicHttpsUrl },
  );
  const webResult = {
    resolvedIntent: {
      evidence: [
        { source: { kind: "web", url: "https://public.example/source" } },
      ],
    },
    research: { sources: [] },
    supplierLeads: [],
  };
  assert.equal(
    publicHttpsUrl("https://public.example/source"),
    "https://public.example/source",
  );

  assert.equal(
    validateResultTransportEvidence(webResult, [
      "https://public.example/source",
    ]).ok,
    true,
  );
  assert.equal(
    validateResultTransportEvidence(webResult, ["https://other.example/"]).ok,
    false,
  );
  assert.equal(
    validateResultTransportEvidence(
      {
        resolvedIntent: {
          evidence: [
            {
              source: {
                kind: "web",
                url: "https://search.brave.com/search?q=paint",
              },
            },
          ],
        },
      },
      ["https://search.brave.com/search?q=paint"],
    ).ok,
    false,
  );
  assert.equal(
    validateResultTransportEvidence(
      {
        resolvedIntent: {
          evidence: [
            { source: { kind: "web", url: "http://public.example/source" } },
          ],
        },
      },
      ["http://public.example/source"],
    ).ok,
    false,
  );
  assert.equal(
    validateResultTransportEvidence(
      {
        resolvedIntent: {
          evidence: [
            { source: { kind: "web", url: "https://127.0.0.1/source" } },
          ],
        },
      },
      ["https://127.0.0.1/source"],
    ).ok,
    false,
  );
  assert.equal(
    validateResultTransportEvidence(
      {
        resolvedIntent: {
          evidence: [
            {
              source: {
                kind: "web",
                url: "https://user:password@public.example/source",
              },
            },
          ],
        },
      },
      ["https://user:password@public.example/source"],
    ).ok,
    false,
  );
  assert.equal(
    validateResultTransportEvidence(
      { resolvedIntent: { evidence: [] }, supplierLeads: [] },
      undefined,
    ).ok,
    true,
  );
});

test("accepts only bounded reviewer provenance for terminal persistence", async () => {
  const route = await readFile(
    new URL("../app/api/agent/route.ts", import.meta.url),
    "utf8",
  );
  const reviewerEventFromPayload = exportedFunctionFromTypeScript(
    route,
    "reviewerEventFromPayload",
  );

  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        reviewerEventFromPayload({
          stage: "review-result",
          title: "Проверка завершена",
          detail: "Факты подтверждены.",
        }),
      ),
    ),
    {
      stage: "review-result",
      title: "Проверка завершена",
      detail: "Факты подтверждены.",
      state: "done",
    },
  );
  assert.equal(
    reviewerEventFromPayload({
      stage: "review-fallback",
      title: "Решение передано руководителю",
      detail: "Требуется ручная проверка.",
    }).state,
    "error",
  );
  assert.equal(
    reviewerEventFromPayload({
      stage: "decision",
      title: "Подмена stage",
      detail: "Не должна пройти.",
    }),
    null,
  );
  assert.equal(
    reviewerEventFromPayload({
      stage: "review-skipped",
      title: "",
      detail: "Нет title.",
    }),
    null,
  );
});

test("marks order and agent JSON success and error responses no-store", async () => {
  const [ordersRoute, agentRoute, ledgerRoute] = await Promise.all([
    readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/ledger/route.ts", import.meta.url), "utf8"),
  ]);
  for (const route of [ordersRoute, agentRoute]) {
    const noStoreResponseInit = exportedFunctionFromTypeScript(
      route,
      "noStoreResponseInit",
      {
        Headers,
        noStoreHeaders: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
    const init = noStoreResponseInit({ headers: { "Retry-After": "3" } });
    assert.equal(init.headers.get("Cache-Control"), "no-store");
    assert.equal(init.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(init.headers.get("Retry-After"), "3");
  }
  assert.match(ledgerRoute, /const noStoreHeaders = \{/);
  assert.match(ledgerRoute, /headers: noStoreHeaders/);
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
    route.indexOf("if (!subject || body.length < 3"),
  );

  assert.match(
    retry,
    /canChangeOrder\(request, failedCapability\.actionTokenHash\)/,
  );
  assert.match(retry, /eq\(orders\.status, "error"\)/);
  assert.match(
    retry,
    /eq\(orders\.status, "processing"\)[\s\S]*?lte\(orders\.leaseUntil, sql`CURRENT_TIMESTAMP`\)/,
  );
  assert.match(retry, /coalesce\(\$\{orders\.resultJson\}/);
  assert.match(retry, /coalesce\(\$\{orders\.inventorySnapshotJson\}/);
  assert.match(retry, /orders\.roundNo/);
  assert.match(retry, /orders\.sentAt/);
  assert.match(retry, /stage:\s*"retry"/);
  assert.match(retry, /status:\s*"queued"/);
  assert.match(
    retry,
    /await db\.batch\(\[\s*closeActiveEventsQuery,\s*retryEventQuery,\s*retryOrderQuery,\s*\]\)/,
  );
  assert.doesNotMatch(
    retry,
    /roundNo:\s*failedOrder\.roundNo\s*\+\s*1|resultJson:\s*null|inventorySnapshotJson:\s*null/,
  );
});

test("accepts a short free-form target request for an attached photo", async () => {
  const route = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /if \(!subject \|\| body\.length < 3\)/);
  assert.doesNotMatch(route, /body\.length < 20/);
});

test("retry accepts an expired processing claim but rejects an active lease", async () => {
  const directory = new URL("../drizzle/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const database = new DatabaseSync(":memory:");

  try {
    for (const file of files) {
      database.exec(await readFile(new URL(file, directory), "utf8"));
    }
    const insert = database.prepare(`
      INSERT INTO orders (
        id, subject, body, status, mode, round_no, claim_id, lease_until
      ) VALUES (?, 'Заказ', 'Свободное письмо клиента', 'processing',
                'opencode-live', 1, ?, ?)
    `);
    insert.run(
      "expired-order",
      "claim-expired",
      "2026-07-31 09:00:00",
    );
    insert.run(
      "active-order",
      "claim-active",
      "2026-07-31 09:05:00",
    );
    const retry = database.prepare(`
      UPDATE orders
      SET status = 'queued',
          claim_id = NULL,
          claimed_by = NULL,
          lease_until = NULL
      WHERE id = ?
        AND (
          status = 'error'
          OR (
            status = 'processing'
            AND (lease_until IS NULL OR lease_until <= ?)
          )
        )
    `);

    assert.equal(
      retry.run("expired-order", "2026-07-31 09:02:00").changes,
      1,
    );
    assert.equal(
      retry.run("active-order", "2026-07-31 09:02:00").changes,
      0,
    );
    assert.equal(
      database
        .prepare("SELECT status FROM orders WHERE id = 'expired-order'")
        .get().status,
      "queued",
    );
    assert.equal(
      database
        .prepare("SELECT status FROM orders WHERE id = 'active-order'")
        .get().status,
      "processing",
    );
  } finally {
    database.close();
  }
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

test("commits each initial order with its first observable rows in one batch", async () => {
  const route = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const initialWrite = route.slice(
    route.indexOf("const commonOrder = {"),
    route.indexOf("export async function PATCH"),
  );

  assert.match(
    initialWrite,
    /if \(!recordedMode\)[\s\S]*?await db\.batch\(\[[\s\S]*?db\.insert\(orders\)[\s\S]*?db\.insert\(orderEvents\)/,
  );
  assert.match(
    initialWrite,
    /isCompleteAgentResult\(result\)[\s\S]*?insertResultHistoryWhen\([\s\S]*?await db\.batch\(\[[\s\S]*?db\.insert\(orders\)[\s\S]*?historyQuery[\s\S]*?db\.insert\(orderEvents\)/,
  );
  assert.doesNotMatch(initialWrite, /appendResultHistory/);
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

  assert.match(
    liveResult,
    /!\("schemaVersion" in result\)[\s\S]*?result\.schemaVersion !== 2[\s\S]*?!isCompleteAgentResult\(result\)/,
  );
  assert.match(liveResult, /const completedClaimGuard = and\(/);
  for (const branch of [recalculation, reservation, send, approval]) {
    assert.match(branch, /await db\.batch\(/);
    assert.match(branch, /const transitionGuard = and\(/);
  }
  assert.match(liveResult, /await db\.batch\(/);
  assert.match(
    liveResult,
    /const reviewerEvent = reviewerEventFromPayload\(\s*payload\.reviewerProvenance,\s*\)[\s\S]*?const reviewerEventQuery = insertOrderEventWhen\([\s\S]*?completedClaimGuard[\s\S]*?await db\.batch\(\[\s*updateOrderQuery,\s*historyQuery,\s*closeActiveEventsQuery,\s*reviewerEventQuery,\s*supplierEventQuery,\s*decisionEventQuery,\s*clearClaimQuery,\s*\]\)/,
  );
  assert.match(
    liveResult,
    /\.where\(claimGuard\)[\s\S]*?\.where\(completedClaimGuard\)/,
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
    /sendsEstimate[\s\S]*?result\?\.commitment === "estimate"[\s\S]*?sendsCommercialOffer[\s\S]*?result\?\.commitment === "commercial_offer"[\s\S]*?sendsEstimate \? "ready_to_send" : "reserved"[\s\S]*?insertOrderEventWhen\([\s\S]*?await db\.batch\(\[\s*sentEventQuery,\s*updateOrderQuery,\s*\]\)/,
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
    assert.match(branch, /confirmedSupplierPlanForSnapshot\(/);
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
  assert.match(ordersRoute, /confirmSupplierPlan\(/);
  assert.match(approval, /option\.id === "confirm-supplier-plan"/);
  assert.match(approval, /supplierPlanAfterApproval\(/);
  assert.doesNotMatch(approval, /option\.id === "помочь-с-недостающим-объёмом"/);
});

test("accepts a fresh internal supplier snapshot and rejects stale or mismatched data", async () => {
  const route = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const confirmedSupplierPlanForSnapshot = exportedFunctionFromTypeScript(
    route,
    "confirmedSupplierPlanForSnapshot",
    {
      storedJson: (value, fallback) => {
        try {
          return value ? JSON.parse(value) : fallback;
        } catch {
          return fallback;
        }
      },
      confirmSupplierPlan,
    },
  );
  const plan = {
    category: "краска для бетонного пола",
    supplierName: "Внутренний поставщик",
    supplierKg: 200,
    supplierStockKg: 260,
    supplierPricePerKg: 402,
    deliveryDays: 4,
    stockCheckedAt: "01.08.2026, 10:00",
  };
  const market = [
    {
      category: plan.category,
      competitor: plan.supplierName,
      stockKg: plan.supplierStockKg,
      pricePerKg: plan.supplierPricePerKg,
      deliveryDays: plan.deliveryDays,
      stockCheckedAt: plan.stockCheckedAt,
    },
  ];
  const order = { inventorySnapshotJson: JSON.stringify({ market }) };

  assert.equal(
    confirmedSupplierPlanForSnapshot(order, plan, market)?.supplierName,
    plan.supplierName,
  );
  assert.equal(
    confirmedSupplierPlanForSnapshot(order, plan, [
      { ...market[0], pricePerKg: 403 },
    ]),
    null,
  );
  assert.equal(
    confirmedSupplierPlanForSnapshot(
      { inventorySnapshotJson: JSON.stringify({ market: [] }) },
      plan,
      market,
    ),
    null,
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
  assert.equal(
    optionNeedsCustomerReply({
      id: "confirm-supplier-plan",
      followUpActor: "supplier",
      reply: "Поставщик подтвердит объём и срок перед коммерческим действием.",
    }),
    false,
  );

  const approval = ordersRoute.slice(
    ordersRoute.indexOf('if (action !== "approve"'),
  );
  assert.match(
    approval,
    /result\.resolvedIntent\.target\.state === "ambiguous"[\s\S]*?needsCustomerReply[\s\S]*?result\.route = "needs_info"/,
  );
  assert.match(approval, /approvalStatus\(needsCustomerReply, result\.commitment\)/);
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

test("keeps canonical supplier plans except for approved product alternatives", async () => {
  const route = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const supplierPlanAfterApproval = exportedFunctionFromTypeScript(
    route,
    "supplierPlanAfterApproval",
  );
  const plan = {
    supplierName: "Поставщик",
    supplierKg: 200,
    confirmedAt: "old",
  };
  const canonicalPlan = { ...plan };
  const confirmed = { ...plan, supplierStockKg: 300, confirmedAt: "old" };

  assert.deepEqual(
    JSON.parse(JSON.stringify(
      supplierPlanAfterApproval(plan, "split-from-stock", confirmed, "now", false),
    )),
    canonicalPlan,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      supplierPlanAfterApproval(plan, "schedule-production", confirmed, "now", false),
    )),
    canonicalPlan,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      supplierPlanAfterApproval(plan, "confirm-supplier-plan", confirmed, "now", false),
    )),
    { ...confirmed, confirmedAt: "now" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      supplierPlanAfterApproval(plan, "custom-internal-option", confirmed, "now", false),
    )),
    canonicalPlan,
  );
  assert.equal(
    supplierPlanAfterApproval(plan, "custom-internal-option", confirmed, "now", true),
    undefined,
  );
});

test("manager approval prepares a safe nonbinding client reply instead of an error", async () => {
  const route = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const approvalStatus = exportedFunctionFromTypeScript(
    route,
    "approvalStatus",
  );

  assert.equal(approvalStatus(true, "commercial_offer"), "clarification_ready");
  assert.equal(approvalStatus(false, "estimate"), "ready_to_send");
  assert.equal(approvalStatus(false, "commercial_offer"), "ready_to_send");
  assert.equal(approvalStatus(false, "none"), "ready_to_send");
  const approval = route.slice(route.indexOf('if (action !== "approve"'));
  assert.match(
    approval,
    /if \(!isCompleteAgentResult\(result\)\)[\s\S]*?recalculate:\s*true[\s\S]*?return Response\.json/,
  );
  assert.ok(
    approval.indexOf("if (!isCompleteAgentResult(result))") <
      approval.indexOf("const historyQuery"),
  );
  assert.match(
    route,
    /sendsManagerReply[\s\S]*?result\?\.commitment === "none"[\s\S]*?order\.managerDecision/,
  );
  assert.match(
    route,
    /preparedReply[\s\S]*?selectedReply[\s\S]*?join\("\\n\\n"\)/,
  );
});
