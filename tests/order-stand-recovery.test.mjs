import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Не найдено начало фрагмента: ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `Не найден конец фрагмента: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("keeps order creation idempotent and capability secrets in memory", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );
  const submit = sourceBetween(stand, "const submit", "const approve");

  assert.match(stand, /createOperationIdentity\(\)/);
  assert.match(stand, /executeCreateOperation\(/);
  assert.match(submit, /clientOrderId: identity\.clientOrderId/);
  assert.match(submit, /clientActionKey: identity\.clientActionKey/);
  assert.match(submit, /createOperationRef\.current/);
  assert.match(submit, /uncertain: true/);
  assert.match(stand, /operationReconciliationUrl\(operation\.identity\)/);
  assert.match(
    stand,
    /headers:\s*\{\s*"x-order-key": operation\.identity\.clientActionKey/,
  );
  assert.doesNotMatch(stand, /orderActionKeyStoragePrefix/);
  assert.doesNotMatch(stand, /sessionStorage\.setItem\([^\n]*action/i);
  assert.doesNotMatch(stand, /clientActionKey[^\n]*sessionStorage/);
});

test("fences current reviewer events and keeps queued results historical", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );
  const reviewer = sourceBetween(
    stand,
    "function reviewerTransportState",
    "function countNoun",
  );

  assert.match(stand, /roundNo\?: number \| null/);
  assert.match(stand, /claimId\?: string \| null/);
  assert.match(stand, /attemptNo\?: number \| null/);
  assert.match(reviewer, /isCurrentOrderEvent\(events\[index\], order\)/);
  assert.match(stand, /reviewerTransportCopy\(events, order, result\)/);
  assert.match(stand, /const showResult =/);
  assert.match(stand, /!orderIsActive && processingState !== "error"/);
  assert.match(stand, /isCurrentOrderEvent\(item, order\)/);
  for (const postcondition of [
    "managerOptionId: optionId",
    'status: "reserved"',
    'status: "sent", sentAt: true',
    'status: "awaiting_customer"',
    'status: "queued"',
  ]) {
    assert.match(stand, new RegExp(postcondition));
  }
  assert.match(stand, /roundNo: beforeRoundNo \+ 1/);
});

test("does not encode scenario-specific recovery controls in the order surface", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );

  for (const forbidden of [
    "showFloorReplyPresets",
    "floorReplyPresets",
    "ПРОТЕК",
    "Twin Peaks",
    "startFenceExample",
    "startSupplierRescueExample",
    "420",
    "620",
    "700",
    "150",
    "260",
  ]) {
    assert.doesNotMatch(stand, new RegExp(forbidden));
  }
});
