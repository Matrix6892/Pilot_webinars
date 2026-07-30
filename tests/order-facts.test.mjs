import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  asksCompatibility,
  asksPaymentAfterDelivery,
  calculatedSurfaceQuantityFromText,
  deliveryPlanFromText,
  explicitSkuFromText,
  fenceMaterialFromText,
  fenceMeasurementsFromText,
  floorUseFactsFromText,
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

test("recognizes cleaning and documented-use requirements as compatibility gaps", () => {
  for (const phrase of [
    "Пол будут убирать каждый день.",
    "Пол моют каждый день.",
    "Покрытие нужно для ежедневной санитарной обработки.",
    "Будем применять дезинфицирующее средство.",
    "Требуется соответствие ГОСТ для этого помещения.",
  ]) {
    assert.equal(asksCompatibility(phrase), true, phrase);
  }
});

test("collects floor use facts from the customer's continuation", () => {
  const facts = floorUseFactsFromText(
    [
      "Нужна краска для пола. Пол моют каждый день.",
      "Ответ клиента 1: Пол бетонный. Храним лекарства, моем нейтральным средством, по полу ездят погрузчики.",
    ].join("\n\n"),
  );

  assert.deepEqual(facts, {
    material: "бетон",
    purpose: "медицинский склад",
    cleaning: "нейтральное моющее средство",
    load: "погрузчики или тележки",
  });
});

test("understands a non-warehouse answer about how the room will be used", () => {
  const facts = floorUseFactsFromText(
    "Помещение будет мастерской. Пол бетонный, моем нейтральным средством, погрузчиков не будет.",
  );

  assert.deepEqual(facts, {
    material: "бетон",
    purpose: "мастерской",
    cleaning: "нейтральное моющее средство",
    load: "без погрузчиков и тележек",
  });
});

test("uses the latest customer reply for corrected order facts", () => {
  const conversation = [
    "Нужно 180 кг КР-099. Пока неизвестно, внутри или на улице.",
    "Ответ клиента 1: Берём КР-001, 220 кг. Красить будем на улице.",
  ].join("\n\n");

  assert.equal(hasUsableEnvironment(conversation), true);
  assert.equal(explicitSkuFromText(conversation), "КР-001");
  assert.equal(matchProduct(conversation, demoData.products)?.sku, "КР-001");
  assert.equal(quantityFromText(conversation), 220);
});

test("keeps the total volume when the customer names only the first delivery", () => {
  const conversation = [
    "Нужно 800 кг КР-001.",
    "Ответ клиента 1: Для старта достаточно 200 кг, остальная краска нужна к 15 августа.",
  ].join("\n\n");

  assert.equal(quantityFromText(conversation), 800);
});

test("reads a first delivery after an explicit total in the same sentence", () => {
  const facts = deliveryPlanFromText(
    [
      "Нужно 800 кг краски для металла на улице, цвет RAL 7024.",
      "Ответ клиента 1: Меняем цвет на RAL 9005. Всего нужно 800 кг: 200 кг сейчас, остальные 600 кг позже.",
    ].join("\n\n"),
  );

  assert.deepEqual(facts, {
    totalKg: 800,
    firstDeliveryKg: 200,
    remainingKg: 600,
  });
});

test("does not carry a resolved compatibility question into the current request", () => {
  const conversation = [
    "Подскажите, подходит ли покрытие для постоянного контакта с маслами?",
    "Ответ клиента 1: Контакта с маслами не будет.",
  ].join("\n\n");

  assert.equal(asksCompatibility(conversation), false);
});

test("keeps a cleaning requirement open when the customer only rules out oil", () => {
  const conversation = [
    "Пол будут убирать каждый день. Подберите подходящее покрытие.",
    "Ответ клиента 1: Масел на полу не будет.",
  ].join("\n\n");

  assert.equal(asksCompatibility(conversation), true);
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

test("treats a supplier competition as special terms", () => {
  for (const phrase of [
    "Проводим конкурс поставщиков.",
    "Условия конкурса поставщиков согласуем отдельно.",
  ]) {
    assert.equal(hasSpecialTerms(phrase), true, phrase);
  }
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

test("calculates a complete wall or floor request from area", () => {
  const wallPaint = demoData.products.find((product) => product.sku === "КР-004");
  const floorPaint = demoData.products.find((product) => product.sku === "КР-003");
  const reserve = demoData.rules.calculationReservePercent;

  assert.equal(
    calculatedSurfaceQuantityFromText(
      "Красим 120 м² стен по штукатурке в помещении, цвет белый.",
      wallPaint,
      reserve,
    ),
    42,
  );
  assert.equal(
    calculatedSurfaceQuantityFromText(
      "Нужно покрасить 80 м² бетонного пола в помещении, цвет серый.",
      floorPaint,
      reserve,
    ),
    80,
  );
  assert.equal(
    calculatedSurfaceQuantityFromText(
      "Красим стены по штукатурке в помещении, цвет белый.",
      wallPaint,
      reserve,
    ),
    0,
  );
});

test("calculates a complete fence request from dimensions and painted sides", () => {
  const woodPaint = demoData.products.find((product) => product.sku === "КР-005");
  assert.equal(
    calculatedSurfaceQuantityFromText(
      "Деревянный забор длиной 30 м и высотой 1,8 м. Красим с двух сторон, цвет коричневый.",
      woodPaint,
      demoData.rules.calculationReservePercent,
    ),
    40,
  );
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

test("understands natural fence length before a labelled height", () => {
  assert.deepEqual(
    fenceMeasurementsFromText(
      "Забор примерно 120 метров, высота 2 метра. Красим одну сторону.",
    ),
    {
      lengthM: 120,
      heightM: 2,
      areaM2: null,
      sides: 1,
      areaPerSideM2: 240,
      paintAreaM2: 240,
    },
  );
});
