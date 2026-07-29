import assert from "node:assert/strict";
import test from "node:test";
import { productInventoryChanged } from "../lib/inventory-freshness.mjs";

const result = { product: { sku: "КР-005" } };

test("keeps approval available when the selected paint is current", () => {
  assert.equal(
    productInventoryChanged(
      { items: [{ sku: "КР-005", stockKg: 40, revision: 7 }] },
      result,
      [{ sku: "КР-005", stockKg: 40, revision: 7 }],
    ),
    false,
  );
});

test("requires recalculation after the selected paint changes", () => {
  assert.equal(
    productInventoryChanged(
      { items: [{ sku: "КР-005", stockKg: 40, revision: 7 }] },
      result,
      [{ sku: "КР-005", stockKg: 180, revision: 8 }],
    ),
    true,
  );
});

test("ignores changes to paint that is not used by the card", () => {
  assert.equal(
    productInventoryChanged(
      { items: [{ sku: "КР-005", stockKg: 40, revision: 7 }] },
      result,
      [
        { sku: "КР-005", stockKg: 40, revision: 7 },
        { sku: "КР-001", stockKg: 900, revision: 12 },
      ],
    ),
    false,
  );
});

test("stops the action when the selected paint row cannot be verified", () => {
  assert.equal(
    productInventoryChanged(
      { items: [{ sku: "КР-005", stockKg: 40, revision: 7 }] },
      result,
      [],
    ),
    true,
  );
});
