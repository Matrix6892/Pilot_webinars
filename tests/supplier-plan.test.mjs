import assert from "node:assert/strict";
import test from "node:test";
import demoData from "../data/paint-demo.json" with { type: "json" };
import {
  buildSupplierPlan,
  confirmSupplierPlan,
  supplierPlanChangeDetail,
} from "../lib/supplier-plan.mjs";

const floorPaint = demoData.products.find(
  (product) => product.sku === "КР-003",
);

test("считает совместную поставку по ценам каждой части", () => {
  const plan = buildSupplierPlan(floorPaint, demoData.market, 620);

  assert.deepEqual(plan, {
    category: "краска для бетонного пола",
    supplierName: "Индустрия Покрытий",
    ourKg: 420,
    supplierKg: 200,
    ourPricePerKg: 415,
    supplierPricePerKg: 402,
    ourSubtotal: 174300,
    supplierSubtotal: 80400,
    total: 254700,
    deliveryDays: 4,
    supplierStockKg: 260,
    stockCheckedAt: "30.07.2026, 10:40",
    offersChecked: 3,
    eligibleOffers: 2,
    selectionRule:
      "Сначала весь недостающий объём. Среди таких предложений — меньший срок, затем меньшая цена.",
    comparedOffers: [
      {
        supplierName: "Индустрия Покрытий",
        pricePerKg: 402,
        deliveryDays: 4,
        stockKg: 260,
        stockCheckedAt: "30.07.2026, 10:40",
        canCover: true,
        selected: true,
      },
      {
        supplierName: "Покрытия Волга",
        pricePerKg: 410,
        deliveryDays: 7,
        stockKg: 340,
        stockCheckedAt: "30.07.2026, 10:44",
        canCover: true,
        selected: false,
      },
      {
        supplierName: "Быстрый Цвет",
        pricePerKg: 398,
        deliveryDays: 2,
        stockKg: 120,
        stockCheckedAt: "30.07.2026, 10:42",
        canCover: false,
        selected: false,
      },
    ],
  });
});

test("график первой партии не меняет недостающий складской объём", () => {
  const plan = buildSupplierPlan(floorPaint, demoData.market, 620);

  assert.equal(plan?.ourKg, 420);
  assert.equal(plan?.supplierKg, 200);
});

test("повторная проверка принимает только то же актуальное предложение", () => {
  const plan = buildSupplierPlan(floorPaint, demoData.market, 620);
  assert.ok(plan);
  assert.deepEqual(confirmSupplierPlan(plan, demoData.market), plan);

  const changed = (patch) =>
    demoData.market.map((item) =>
      item.competitor === "Индустрия Покрытий"
        ? { ...item, ...patch }
        : item,
    );

  assert.equal(confirmSupplierPlan(plan, changed({ stockKg: 199 })), null);
  assert.equal(confirmSupplierPlan(plan, changed({ stockKg: 200 })), null);
  assert.equal(confirmSupplierPlan(plan, changed({ stockKg: 300 })), null);
  assert.equal(
    confirmSupplierPlan(plan, changed({ pricePerKg: 403 })),
    null,
  );
  assert.equal(
    confirmSupplierPlan(plan, changed({ deliveryDays: 5 })),
    null,
  );
  assert.equal(
    confirmSupplierPlan(
      plan,
      changed({ stockCheckedAt: "30.07.2026, 11:15" }),
    ),
    null,
  );
  assert.equal(
    confirmSupplierPlan(
      plan,
      demoData.market.filter(
        (item) => item.competitor !== "Индустрия Покрытий",
      ),
    ),
    null,
  );
});

test("объясняет, какой факт поставщика изменился", () => {
  const plan = buildSupplierPlan(floorPaint, demoData.market, 620);
  assert.ok(plan);
  const changedMarket = demoData.market.map((item) =>
    item.competitor === "Индустрия Покрытий"
      ? {
          ...item,
          stockKg: 200,
          pricePerKg: 405,
          deliveryDays: 8,
          stockCheckedAt: "30.07.2026, 11:30",
        }
      : item,
  );

  assert.equal(
    supplierPlanChangeDetail(plan, changedMarket),
    "«Индустрия Покрытий»: доступный объём 260 → 200 кг; цена 402 → 405 ₽/кг; срок 4 → 8 дн.; свежая проверка от 30.07.2026, 11:30; теперь лучше подходит «Покрытия Волга».",
  );
});

test("выбирает полный недостающий объём и замечает более сильное предложение", () => {
  const plan = buildSupplierPlan(floorPaint, demoData.market, 620);
  assert.equal(plan?.supplierName, "Индустрия Покрытий");
  assert.equal(
    plan?.comparedOffers.find((item) => item.supplierName === "Быстрый Цвет")
      ?.canCover,
    false,
  );

  const strongerMarket = demoData.market.map((item) =>
    item.competitor === "Покрытия Волга"
      ? {
          ...item,
          deliveryDays: 3,
          pricePerKg: 399,
          stockCheckedAt: "30.07.2026, 11:20",
        }
      : item,
  );

  assert.equal(confirmSupplierPlan(plan, strongerMarket), null);
  assert.equal(
    buildSupplierPlan(floorPaint, strongerMarket, 620)?.supplierName,
    "Покрытия Волга",
  );
});
