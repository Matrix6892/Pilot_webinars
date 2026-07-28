import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  asksCompatibility,
  explicitSkuFromText,
  hasColor,
  hasUsableEnvironment,
  matchProduct,
  quantityFromText,
  quotedUnitPrices,
} from "../lib/order-facts.mjs";

const demoData = JSON.parse(
  await readFile(new URL("../data/paint-demo.json", import.meta.url), "utf8"),
);

test("matches named and semantic products without reading delivery as wood", () => {
  assert.equal(
    matchProduct(
      "Нужны 200 кг грунт-эмали для металлических ограждений. Доставка в Ярославль.",
      demoData.products,
    )?.sku,
    "КР-001",
  );
  assert.equal(
    matchProduct(
      "Покрытие Барьер 3в1 заберём со склада.",
      demoData.products,
    )?.sku,
    "КР-001",
  );
  assert.equal(
    matchProduct(
      "Нужно 600 кг продукта Металл Про для корпусов.",
      demoData.products,
    )?.sku,
    "КР-002",
  );
  assert.equal(
    matchProduct(
      "Нужно эпоксидное покрытие бетонного пола.",
      demoData.products,
    )?.sku,
    "КР-003",
  );
  assert.equal(
    matchProduct(
      "Требуется краска для фасада здания. Доставка в Самару.",
      demoData.products,
    ),
    null,
  );
});

test("marks ambiguous environment and compatibility questions as gaps", () => {
  assert.equal(
    hasUsableEnvironment(
      "Пока неизвестно, будет оборудование стоять внутри цеха или на улице.",
    ),
    false,
  );
  assert.equal(
    asksCompatibility(
      "Уточните, подходит ли покрытие для постоянного контакта с маслами.",
    ),
    true,
  );
});

test("extracts the customer's target unit price", () => {
  assert.deepEqual(quotedUnitPrices("Цена не выше 320 ₽/кг."), [320]);
});

test("does not read a budget in thousands as tonnes", () => {
  assert.equal(quantityFromText("Бюджет 300 тыс. рублей."), 0);
  assert.equal(quantityFromText("Требуется 1,5 тонны покрытия."), 1500);
  assert.equal(quantityFromText("Требуется 2 т. покрытия."), 2000);
});

test("does not read packaging or a unit-price request as order volume", () => {
  assert.equal(
    quantityFromText(
      "Нужна грунт-эмаль в таре по 20 кг. Общий объём уточним позже.",
    ),
    0,
  );
  assert.equal(quantityFromText("Пришлите цену за 1 кг и сроки."), 0);
  assert.equal(
    quantityFromText("Фасовка 20 кг. Общий объём заказа 800 кг."),
    800,
  );
  assert.equal(quantityFromText("Нужно 40 вёдер по 20 кг."), 0);
  assert.equal(quantityFromText("Нужно 20 банок по 25 кг."), 0);
  assert.equal(quantityFromText("Нужно по 800 кг на каждый объект."), 800);
  assert.equal(quantityFromText("Объём 5 т.к. график ещё обсуждаем."), 0);
});

test("treats a short mistyped SKU as an explicit unknown identifier", () => {
  assert.equal(explicitSkuFromText("Нужно 200 кг КР-99."), "КР-99");
  assert.equal(
    matchProduct(
      "Нужно 200 кг КР-99 для внутренних стен, цвет белый.",
      demoData.products,
    ),
    null,
  );
});

test("requires an actual color value", () => {
  assert.equal(hasColor("Компания ТехСервис просит расчёт."), false);
  assert.equal(hasColor("Цвет согласуем позже, сертификат приложим."), false);
  assert.equal(hasColor("Нужен светло-серый цвет."), true);
  assert.equal(hasColor("Цвет RAL 7024."), true);
});
