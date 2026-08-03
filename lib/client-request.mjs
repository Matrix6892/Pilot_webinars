export const apiTimeoutMs = 15_000;
export const uploadTimeoutMs = 60_000;

const operationUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const operationKeyPattern = /^[0-9a-f]{64}$/u;

export function timestampMs(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) return Number.NaN;
  const sqliteUtc =
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(candidate)
      ? `${candidate.replace(" ", "T")}Z`
      : candidate;
  return Date.parse(sqliteUtc);
}

export function isOperationIdentity(value) {
  return Boolean(
    value &&
      typeof value.clientOrderId === "string" &&
      operationUuidPattern.test(value.clientOrderId) &&
      typeof value.clientActionKey === "string" &&
      operationKeyPattern.test(value.clientActionKey),
  );
}

export function createOperationIdentity(cryptoImpl = globalThis.crypto) {
  if (
    !cryptoImpl ||
    typeof cryptoImpl.randomUUID !== "function" ||
    typeof cryptoImpl.getRandomValues !== "function"
  ) {
    throw new Error("Web Crypto is unavailable for order creation.");
  }

  const clientOrderId = cryptoImpl.randomUUID();
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  const clientActionKey = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const identity = { clientOrderId, clientActionKey };
  if (!isOperationIdentity(identity)) {
    throw new Error("Web Crypto returned an invalid order identity.");
  }
  return identity;
}

export function operationReconciliationUrl(identity) {
  if (!isOperationIdentity(identity)) {
    throw new TypeError("A valid order operation identity is required.");
  }
  return `/api/orders?id=${encodeURIComponent(identity.clientOrderId)}`;
}

function observedClientOrderId(data) {
  return data?.clientOrderId ?? data?.order?.clientOrderId ?? "";
}

function observedOrderId(data) {
  return data?.order?.id ?? data?.orderId ?? data?.id ?? "";
}

function operationClientIdMatches(data, identity) {
  const marker = observedClientOrderId(data);
  return (
    marker === identity.clientOrderId ||
    (!marker && observedOrderId(data) === identity.clientOrderId)
  );
}

export function operationResponseConfirmed(data, identity) {
  return Boolean(
    isOperationIdentity(identity) &&
      typeof data?.id === "string" &&
      typeof data?.actionKey === "string" &&
      (!observedClientOrderId(data) ||
        observedClientOrderId(data) === identity.clientOrderId),
  );
}

export function operationReconciliationConfirmed(data, identity) {
  return Boolean(
    isOperationIdentity(identity) &&
      typeof observedOrderId(data) === "string" &&
      observedOrderId(data) &&
      operationClientIdMatches(data, identity),
  );
}

export function operationOrderId(data, identity) {
  return operationReconciliationConfirmed(data, identity)
    ? observedOrderId(data)
    : "";
}

export function operationReconciliationState(response, data, identity) {
  if (response?.ok && operationReconciliationConfirmed(data, identity)) {
    return "confirmed";
  }
  if (response?.status === 404) return "not-found";
  return "unknown";
}

export function operationFailureIsTerminal(status) {
  return (
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    status !== 409 &&
    status !== 429
  );
}

export async function executeCreateOperation({ identity, post, reconcile }) {
  let postResult;
  let postError;
  try {
    postResult = await post(identity);
  } catch (error) {
    postError = error;
  }

  if (postResult?.response?.ok && operationResponseConfirmed(postResult.data, identity)) {
    return {
      state: "confirmed",
      orderId: postResult.data.id,
      data: postResult.data,
    };
  }

  let reconciliation;
  try {
    reconciliation = await reconcile(identity);
  } catch (error) {
    reconciliation = { state: "unknown", error };
  }
  if (reconciliation?.state === "confirmed") return reconciliation;

  if (
    postResult &&
    operationFailureIsTerminal(postResult.response?.status) &&
    reconciliation?.state === "not-found"
  ) {
    return { state: "terminal-failure", data: postResult.data };
  }

  return {
    state: "uncertain",
    data: postResult?.data,
    error: postError,
  };
}

export function isCurrentOrderEvent(event, order) {
  const currentRound = order?.roundNo;
  const eventRound = event?.roundNo;
  if (
    !Number.isSafeInteger(currentRound) ||
    currentRound < 1 ||
    !Number.isSafeInteger(eventRound) ||
    eventRound !== currentRound
  ) {
    return false;
  }

  const attemptNo = order?.attemptNo;
  if (order?.claimId && event?.claimId !== order.claimId) return false;
  if (
    Number.isSafeInteger(attemptNo) &&
    attemptNo > 0 &&
    event?.attemptNo !== attemptNo
  ) {
    return false;
  }
  return true;
}

export function orderProcessingState(order, now = Date.now()) {
  const status = order?.status;
  if (status === "queued") return "queued";
  if (status === "processing") {
    const leaseUntil = timestampMs(order.leaseUntil);
    return Number.isFinite(leaseUntil) && leaseUntil > now
      ? "processing-active"
      : "processing-expired";
  }
  if (status === "error") return "error";
  return status || "unknown";
}

export function reconciledMutationError(
  currentError,
  postconditionMet = false,
) {
  return postconditionMet
    ? ""
    : currentError;
}

export function mutationPostconditionMet(order, expected = {}) {
  if (!order || typeof order !== "object") return false;
  if (
    expected.roundNo !== undefined &&
    order.roundNo !== expected.roundNo
  ) {
    return false;
  }
  if (expected.status !== undefined) {
    const statuses = Array.isArray(expected.status)
      ? expected.status
      : [expected.status];
    if (!statuses.includes(order.status)) return false;
  }
  if (
    expected.managerOptionId !== undefined &&
    order.managerOptionId !== expected.managerOptionId
  ) {
    return false;
  }
  if (expected.sentAt === true && !order.sentAt) return false;
  return true;
}

export function orderMutationVersion(order) {
  if (!order || typeof order !== "object") return "";
  return JSON.stringify([
    order.status ?? "",
    order.roundNo ?? 0,
    order.updatedAt ?? "",
    order.managerDecision ?? "",
    order.managerOptionId ?? "",
    order.sentAt ?? "",
    order.result?.route ?? "",
    order.result?.commitment ?? "",
    order.result?.reply?.subject ?? "",
    order.result?.reply?.body ?? "",
  ]);
}

export async function loadWithOneRetry(load) {
  return (await load()) ?? (await load());
}

export function createLatestRequestGate() {
  let generation = 0;
  return {
    next() {
      generation += 1;
      return generation;
    },
    isCurrent(candidate) {
      return candidate === generation;
    },
    invalidate() {
      generation += 1;
    },
  };
}

export async function fetchWithTimeout(
  input,
  init = {},
  timeoutMs = apiTimeoutMs,
  fetchImpl = fetch,
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetchImpl(input, { ...init, signal });
}

export async function fetchJson(
  input,
  init = {},
  timeoutMs = apiTimeoutMs,
  fetchImpl = fetch,
) {
  const response = await fetchWithTimeout(
    input,
    init,
    timeoutMs,
    fetchImpl,
  );
  let data = {};
  try {
    data = await response.json();
  } catch {
    // Empty and malformed error bodies use the caller's safe fallback text.
  }
  return { response, data };
}

export function createSerialPoller({
  task,
  intervalMs = 3_000,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let active = false;
  let timer = null;

  const run = async () => {
    if (!active) return;
    try {
      await task();
    } finally {
      if (active) timer = schedule(run, intervalMs);
    }
  };

  return {
    start() {
      if (active) return;
      active = true;
      void run();
    },
    stop() {
      active = false;
      if (timer !== null) cancel(timer);
      timer = null;
    },
  };
}
