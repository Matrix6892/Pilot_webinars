import assert from "node:assert/strict";
import test from "node:test";
import {
  activeOrderProgress,
  apiTimeoutMs,
  createLatestRequestGate,
  createSerialPoller,
  createOperationIdentity,
  executeCreateOperation,
  fetchJson,
  fetchWithTimeout,
  isCurrentOrderEvent,
  isOperationIdentity,
  loadWithOneRetry,
  mutationPostconditionMet,
  orderMutationVersion,
  orderProcessingState,
  operationFailureIsTerminal,
  operationReconciliationState,
  operationReconciliationUrl,
  reconciledMutationError,
  timestampMs,
  uploadTimeoutMs,
} from "../lib/client-request.mjs";

test("latest-request gate ignores an out-of-order poll response", () => {
  const gate = createLatestRequestGate();
  const oldPoll = gate.next();
  const newPoll = gate.next();

  assert.equal(gate.isCurrent(oldPoll), false);
  assert.equal(gate.isCurrent(newPoll), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(newPoll), false);
});

test("parses SQLite lease timestamps as UTC in every browser timezone", () => {
  assert.equal(
    timestampMs("2026-07-31 07:01:30"),
    Date.parse("2026-07-31T07:01:30Z"),
  );
  assert.equal(
    timestampMs("2026-07-31T07:01:30.000Z"),
    Date.parse("2026-07-31T07:01:30.000Z"),
  );
  assert.equal(Number.isNaN(timestampMs("")), true);
});

test("generates and validates one in-memory operation identity", () => {
  let uuidCalls = 0;
  const identity = createOperationIdentity({
    randomUUID() {
      uuidCalls += 1;
      return "01234567-89ab-4cde-8123-456789abcdef";
    },
    getRandomValues(bytes) {
      bytes.fill(0xab);
      return bytes;
    },
  });

  assert.equal(uuidCalls, 1);
  assert.equal(isOperationIdentity(identity), true);
  assert.equal(identity.clientActionKey, "ab".repeat(32));
  assert.equal(
    operationReconciliationUrl(identity),
    "/api/orders?id=01234567-89ab-4cde-8123-456789abcdef",
  );
});

test("lost POST response reconciles the committed order without a second create", async () => {
  const identity = {
    clientOrderId: "01234567-89ab-4cde-8123-456789abcdef",
    clientActionKey: "ab".repeat(32),
  };
  const attempts = [];
  const result = await executeCreateOperation({
    identity,
    async post(received) {
      attempts.push(received);
      throw new Error("network timeout after commit");
    },
    async reconcile(received) {
      assert.deepEqual(received, identity);
      return { state: "confirmed", orderId: "ord_same" };
    },
  });

  assert.equal(result.state, "confirmed");
  assert.equal(result.orderId, "ord_same");
  assert.deepEqual(attempts, [identity]);
});

test("an uncertain retry reuses the same identity and terminal failure permits a new one", async () => {
  const identity = {
    clientOrderId: "01234567-89ab-4cde-8123-456789abcdef",
    clientActionKey: "cd".repeat(32),
  };
  const attempts = [];
  const uncertain = await executeCreateOperation({
    identity,
    async post(received) {
      attempts.push(received);
      return { response: { ok: false, status: 409 }, data: {} };
    },
    async reconcile() {
      return { state: "not-found" };
    },
  });
  assert.equal(uncertain.state, "uncertain");

  const retried = await executeCreateOperation({
    identity,
    async post(received) {
      attempts.push(received);
      return {
        response: { ok: true, status: 200 },
        data: { id: "ord_same", actionKey: "server-key" },
      };
    },
    async reconcile() {
      return { state: "unknown" };
    },
  });
  assert.equal(retried.state, "confirmed");
  assert.deepEqual(attempts, [identity, identity]);
  assert.equal(operationFailureIsTerminal(400), true);
  assert.equal(operationFailureIsTerminal(409), false);
  assert.equal(operationFailureIsTerminal(429), false);
  assert.equal(
    operationReconciliationState(
      { ok: true, status: 200 },
      { order: { id: identity.clientOrderId } },
      identity,
    ),
    "confirmed",
  );
  assert.equal(
    operationReconciliationState(
      { ok: false, status: 400 },
      {},
      identity,
    ),
    "unknown",
  );
});

test("fences current events by round and active claim metadata", () => {
  const order = {
    status: "processing",
    roundNo: 3,
    claimId: "claim-3",
    attemptNo: 7,
    leaseUntil: "2099-01-01T00:00:00Z",
  };
  assert.equal(
    isCurrentOrderEvent(
      { roundNo: 3, claimId: "claim-3", attemptNo: 7 },
      order,
    ),
    true,
  );
  assert.equal(
    isCurrentOrderEvent(
      { roundNo: 2, claimId: "claim-3", attemptNo: 7 },
      order,
    ),
    false,
  );
  assert.equal(
    isCurrentOrderEvent(
      { roundNo: 3, claimId: "claim-3", attemptNo: 6 },
      order,
    ),
    false,
  );
  assert.equal(isCurrentOrderEvent({ roundNo: null }, order), false);
});

test("keeps a completed result fenced to its own attempt", () => {
  const completed = {
    status: "awaiting_approval",
    roundNo: 3,
    claimId: null,
    attemptNo: 8,
    leaseUntil: null,
  };

  assert.equal(
    isCurrentOrderEvent(
      { roundNo: 3, claimId: "expired-claim", attemptNo: 7 },
      completed,
    ),
    false,
  );
  assert.equal(
    isCurrentOrderEvent(
      { roundNo: 3, claimId: "winning-claim", attemptNo: 8 },
      completed,
    ),
    true,
  );
  assert.equal(
    isCurrentOrderEvent({ roundNo: 3, attemptNo: null }, completed),
    false,
  );
  assert.equal(
    isCurrentOrderEvent(
      { roundNo: 3, attemptNo: null },
      { status: "completed", roundNo: 3, attemptNo: null },
    ),
    true,
  );
});

test("distinguishes queued, active lease, expired lease and error states", () => {
  const now = Date.parse("2026-07-31T07:00:00Z");

  assert.equal(orderProcessingState({ status: "queued" }, now), "queued");
  assert.equal(
    orderProcessingState(
      { status: "processing", leaseUntil: "2026-07-31T07:01:00Z" },
      now,
    ),
    "processing-active",
  );
  assert.equal(
    orderProcessingState(
      { status: "processing", leaseUntil: "2026-07-31T06:59:00Z" },
      now,
    ),
    "processing-expired",
  );
  assert.equal(
    orderProcessingState({ status: "processing", leaseUntil: null }, now),
    "processing-expired",
  );
  assert.equal(orderProcessingState({ status: "error" }, now), "error");
});

test("shows safe rotating progress summaries without exposing reasoning", () => {
  const startedAt = "2026-08-04T06:18:30Z";
  const events = [
    { stage: "understanding", createdAt: "2026-08-04T06:18:31Z" },
    { stage: "model", createdAt: "2026-08-04T06:18:35Z" },
  ];

  assert.deepEqual(
    activeOrderProgress(events, startedAt, Date.parse("2026-08-04T06:18:40Z")),
    {
      title: "Разбираю все части запроса",
      elapsed: "10 сек",
    },
  );
  assert.deepEqual(
    activeOrderProgress(events, startedAt, Date.parse("2026-08-04T06:19:05Z")),
    {
      title: "Сверяю каталог, цены и доступные данные",
      elapsed: "35 сек",
    },
  );
  assert.deepEqual(
    activeOrderProgress(
      [...events, { stage: "review", createdAt: "2026-08-04T06:20:00Z" }],
      startedAt,
      Date.parse("2026-08-04T06:20:10Z"),
    ),
    {
      title: "Проверяю, что ответ охватывает все просьбы",
      elapsed: "1 мин 40 сек",
    },
  );
});

test("a committed PATCH clears its lost-response error after reconciliation", () => {
  const before = orderMutationVersion({
    status: "awaiting_approval",
    roundNo: 1,
    updatedAt: "2026-07-31T09:00:00Z",
  });
  const recalculated = orderMutationVersion({
    status: "awaiting_approval",
    roundNo: 2,
    updatedAt: "2026-07-31T09:01:00Z",
  });
  assert.equal(
    reconciledMutationError("Запрос превысил время ожидания", true),
    "",
  );
  assert.notEqual(before, recalculated);
  assert.equal(
    reconciledMutationError("Сервер не принял изменение", false),
    "Сервер не принял изменение",
  );
  assert.equal(
    mutationPostconditionMet(
      { status: "awaiting_approval", managerOptionId: "other" },
      { managerOptionId: "wanted" },
    ),
    false,
  );
});

test("reconciliation retries one failed read without overlapping requests", async () => {
  let calls = 0;
  const result = await loadWithOneRetry(async () => {
    calls += 1;
    return calls === 1 ? null : { status: "ready_to_send" };
  });

  assert.equal(calls, 2);
  assert.deepEqual(result, { status: "ready_to_send" });
});

test("fetchWithTimeout aborts a hanging request", async () => {
  const hangingFetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => reject(init.signal.reason),
        { once: true },
      );
    });

  const keepAlive = setTimeout(() => {}, 50);
  try {
    await assert.rejects(
      fetchWithTimeout("/api/orders", {}, 5, hangingFetch),
      (error) => error?.name === "TimeoutError",
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test("fetchJson uses the shared API timeout and the upload budget remains explicit", async () => {
  const seenSignals = [];
  const fakeFetch = async (_input, init) => {
    seenSignals.push(init.signal);
    return { ok: true, async json() { return { ok: true }; } };
  };

  const { data } = await fetchJson(
    "/api/orders",
    {},
    apiTimeoutMs,
    fakeFetch,
  );
  assert.deepEqual(data, { ok: true });
  assert.equal(seenSignals.length, 1);
  assert.equal(seenSignals[0].aborted, false);
  assert.equal(uploadTimeoutMs, 60_000);
});

test("serial poller never overlaps requests", async () => {
  const scheduled = [];
  const releases = [];
  let running = 0;
  let maxRunning = 0;
  let calls = 0;
  const poller = createSerialPoller({
    intervalMs: 3_000,
    schedule(callback) {
      scheduled.push(callback);
      return callback;
    },
    cancel() {},
    async task() {
      calls += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => releases.push(resolve));
      running -= 1;
    },
  });

  poller.start();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(scheduled.length, 0);

  releases.shift()();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(scheduled.length, 1);

  scheduled.shift()();
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(maxRunning, 1);

  poller.stop();
  releases.shift()();
});
