import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  asksCompatibility,
  asksPaymentAfterDelivery,
  explicitSkuFromText,
  fenceMaterialFromText,
  fenceMeasurementsFromText,
  hasColor,
  hasSpecialTerms,
  hasUsableEnvironment,
  innFromText,
  isFenceRequest,
  matchProduct,
  orderFactsFromText,
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
      "Нужны 40 кг износостойкой краски для металлических корпусов техники.",
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

test("understands everyday phrases about payment after delivery", () => {
  for (const phrase of [
    "Просим оплату через 90 дней после поставки.",
    "Оплатим после получения товара.",
    "Срок оплаты — 60 дней.",
    "Работаем без предоплаты.",
    "Сначала поставка, затем оплата.",
  ]) {
    assert.equal(hasSpecialTerms(phrase), true, phrase);
    assert.equal(asksPaymentAfterDelivery(phrase), true, phrase);
  }
  assert.equal(
    hasSpecialTerms("Оплатим заказ сегодня по выставленному счёту."),
    false,
  );
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

test("keeps an unqualified fence request and extracts a stated company INN", () => {
  const facts = orderFactsFromText(
    "ИНН: 7805 059 867. Хочу покрасить забор, прикладываю фото. Краску и количество подберите.",
  );

  assert.equal(innFromText("Наш ИНН 7805059867."), "7805059867");
  assert.equal(innFromText("Телефон 7805059867."), "");
  assert.equal(isFenceRequest("Вот фото, хочу покрасить забор."), true);
  assert.equal(facts.inn, "7805059867");
  assert.equal(facts.fence?.requested, true);
  assert.equal(facts.fence?.mentionsPhoto, true);
  assert.equal(facts.fence?.material, "неясно");
});

test("extracts fence material, dimensions, area and painted sides", () => {
  assert.equal(
    fenceMaterialFromText("Деревянный забор со старой краской."),
    "дерево",
  );
  assert.equal(
    fenceMaterialFromText("Забор из профнастила, металлический."),
    "металл",
  );

  assert.deepEqual(
    fenceMeasurementsFromText(
      "Деревянный забор длиной 30 м и высотой 1,8 м. Красим с двух сторон.",
    ),
    {
      lengthM: 30,
      heightM: 1.8,
      areaM2: null,
      sides: 2,
      areaPerSideM2: 54,
      paintAreaM2: 108,
    },
  );

  assert.deepEqual(
    fenceMeasurementsFromText(
      "Площадь забора 75 м², красим только снаружи.",
    ),
    {
      lengthM: null,
      heightM: null,
      areaM2: 75,
      sides: 1,
      areaPerSideM2: 75,
      paintAreaM2: 75,
    },
  );
});

test("reads compact fence dimensions without confusing length and height", () => {
  assert.deepEqual(
    fenceMeasurementsFromText(
      "Забор 30 метров длиной, 2 метра высотой, одну сторону.",
    ),
    {
      lengthM: 30,
      heightM: 2,
      areaM2: null,
      sides: 1,
      areaPerSideM2: 60,
      paintAreaM2: 60,
    },
  );
  assert.deepEqual(
    fenceMeasurementsFromText(
      "Металлический забор 20 × 2 м, красим обе стороны.",
    ),
    {
      lengthM: 20,
      heightM: 2,
      areaM2: null,
      sides: 2,
      areaPerSideM2: 40,
      paintAreaM2: 80,
    },
  );
});
