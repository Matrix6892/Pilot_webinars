import assert from "node:assert/strict";
import test from "node:test";
import demoData from "../data/paint-demo.json" with { type: "json" };
import {
  applySupplierMarketStockChange,
  supplierMarketFromState,
  supplierMarketStateValue,
  supplierMarketWithIds,
} from "../lib/supplier-market.mjs";

test("добавляет предложениям стабильные id для GET /api/market", () => {
  const first = supplierMarketWithIds(demoData.market);
  const second = supplierMarketWithIds(structuredClone(demoData.market));

  assert.equal(first.length, demoData.market.length);
  assert.deepEqual(
    first.map((offer) => offer.id),
    second.map((offer) => offer.id),
  );
  assert.ok(first.every((offer) => offer.id && offer.stockKg >= 0));
  assert.equal(new Set(first.map((offer) => offer.id)).size, first.length);
});

test("PATCH меняет только выбранное предложение и возвращает from/to", () => {
  const market = supplierMarketWithIds(demoData.market);
  const selected = market.find(
    (offer) => offer.competitor === "Индустрия Покрытий",
  );
  assert.ok(selected);

  const result = applySupplierMarketStockChange(
    market,
    selected.id,
    150,
    "30.07.2026, 15:10",
  );

  assert.deepEqual(result.changed, {
    id: selected.id,
    from: 260,
    to: 150,
  });
  assert.equal(
    result.market.find((offer) => offer.id === selected.id)?.stockKg,
    150,
  );
  assert.equal(
    result.market.find((offer) => offer.id === selected.id)?.stockCheckedAt,
    "30.07.2026, 15:10",
  );
  assert.deepEqual(
    result.market.filter((offer) => offer.id !== selected.id),
    market.filter((offer) => offer.id !== selected.id),
  );
});

test("живой снимок хранит только изменяемые остатки поверх учебного каталога", () => {
  const defaults = supplierMarketWithIds(demoData.market);
  const selected = defaults.find(
    (offer) => offer.competitor === "Индустрия Покрытий",
  );
  assert.ok(selected);
  const changed = applySupplierMarketStockChange(
    defaults,
    selected.id,
    150,
    "30.07.2026, 15:15",
  );
  assert.ok(changed);

  const value = supplierMarketStateValue(changed.market);
  const restored = supplierMarketFromState(defaults, value);

  assert.equal(
    restored.find((offer) => offer.id === selected.id)?.stockKg,
    150,
  );
  assert.equal(
    restored.find((offer) => offer.id === selected.id)?.pricePerKg,
    selected.pricePerKg,
  );
});
