import assert from "node:assert/strict";
import test from "node:test";
import {
  changedProductInventory,
  productInventoryChanged,
  resultInventorySkus,
} from "../lib/inventory-freshness.mjs";

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

test("tracks the alternative named in a manager option", () => {
  const managerResult = {
    product: { sku: "КР-005", stockKg: 40, requestedKg: 180 },
    options: [
      {
        title: "Поставить весь объём краской КР-001",
        reply: "На складе есть весь объём краски КР-001.",
      },
    ],
  };
  const saved = {
    items: [
      { sku: "КР-005", name: "Основная краска", stockKg: 40, revision: 7 },
      {
        sku: "КР-001",
        name: "Краска по металлу",
        stockKg: 180,
        revision: 3,
      },
    ],
  };
  const live = [
    { sku: "КР-005", name: "Основная краска", stockKg: 40, revision: 7 },
    {
      sku: "КР-001",
      name: "Краска по металлу",
      stockKg: 90,
      revision: 4,
    },
  ];

  assert.deepEqual(resultInventorySkus(saved, managerResult), [
    "КР-005",
    "КР-001",
  ]);
  assert.equal(productInventoryChanged(saved, managerResult, live), true);
  assert.equal(
    changedProductInventory(saved, managerResult, live)?.sku,
    "КР-001",
  );
});

test("tracks an allowed alternative that can appear after replenishment", () => {
  const managerResult = {
    product: { sku: "КР-001", stockKg: 40, requestedKg: 180 },
    options: [{ title: "Разделить поставку" }],
  };
  const saved = {
    items: [
      { sku: "КР-001", stockKg: 40, revision: 7 },
      { sku: "КР-002", stockKg: 90, revision: 3 },
    ],
  };
  const live = [
    { sku: "КР-001", stockKg: 40, revision: 7 },
    { sku: "КР-002", stockKg: 180, revision: 4 },
  ];
  const catalog = [
    { sku: "КР-001", analogues: ["КР-002"] },
    { sku: "КР-002", analogues: ["КР-001"] },
  ];

  assert.equal(
    productInventoryChanged(saved, managerResult, live, catalog),
    true,
  );
});
