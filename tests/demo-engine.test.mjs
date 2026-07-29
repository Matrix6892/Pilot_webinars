import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test, { after, before } from "node:test";
import { createServer } from "vite";

const baseCatalog = JSON.parse(
  await readFile(new URL("../data/paint-demo.json", import.meta.url), "utf8"),
);

let server;
let buildDemoResult;

before(async () => {
  server = await createServer({
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true },
    resolve: { alias: { "@": resolve(".") } },
  });
  ({ buildDemoResult } = await server.ssrLoadModule("/lib/demo-engine.ts"));
});

after(async () => {
  await server?.close();
});

test("keeps a photo request without a product code or weight", () => {
  const result = buildDemoResult({
    subject: "Хочу покрасить забор",
    body: "Добрый день! Не знаю, какая краска нужна и сколько покупать. Прикладываю фото забора.",
    company: "Сад у озера",
    attachment: {
      name: "забор.jpg",
      src: "/fence-demo.jpg",
      alt: "Фотография забора из заявки",
    },
  });

  assert.equal(result.zone, "yellow");
  assert.equal(result.decision, "clarify");
  assert.equal(result.route, "needs_info");
  assert.equal(result.product, null);
  assert.deepEqual(result.missing, [
    "материал забора",
    "размер забора",
    "стороны покраски",
    "цвет забора",
  ]);
  assert.match(result.understood.join(" "), /покрасить забор/i);
  assert.match(result.understood.join(" "), /фотограф/i);
  assert.match(result.reply.body, /из чего сделан забор/i);
  assert.match(result.reply.body, /длину и среднюю высоту/i);
  assert.match(result.businessContext, /фото дополняет заявку/i);
});

test("does not claim that a photo was received when the attachment is absent", () => {
  const result = buildDemoResult({
    subject: "Хочу покрасить забор",
    body: "Добрый день! Прикладываю фото забора, помогите подобрать краску.",
  });

  assert.equal(result.route, "needs_info");
  assert.doesNotMatch(result.understood.join(" "), /фотограф.*получен/i);
  assert.doesNotMatch(result.reply.body, /фото приложено/i);
  assert.match(
    result.reply.body,
    /приложите фотографию, которую упомянули в письме/iu,
  );
});

test("asks for a mentioned photo before sending an otherwise ready quote", () => {
  const result = buildDemoResult({
    subject: "Краска для ограждений",
    body: "Нужны 200 кг краски для металлических ограждений на улице, цвет серый. Вот фото.",
  });

  assert.equal(result.zone, "yellow");
  assert.equal(result.route, "needs_info");
  assert.deepEqual(result.missing, ["приложите фотографию"]);
  assert.match(
    result.reply.body,
    /приложите фотографию, которую упомянули в письме/iu,
  );
});

test("lets a customer describe the color in words or use the RAL catalogue", () => {
  const result = buildDemoResult({
    subject: "Краска для ограждений",
    body: "Нужны 200 кг краски для металлических ограждений на улице.",
  });

  assert.equal(result.route, "needs_info");
  assert.match(
    result.reply.body,
    /можно описать его словами или указать номер из каталога цветов RAL/iu,
  );
});

test("calculates fence paint by area, coats, reserve and whole packages", () => {
  const result = buildDemoResult({
    subject: "Расчёт краски на забор",
    body: "Деревянный забор длиной 30 м и высотой 1,8 м. Красим с двух сторон, цвет коричневый. Забор стоит на улице.",
  });

  assert.equal(result.route, "ready");
  assert.equal(result.zone, "green");
  assert.equal(result.product?.sku, "КР-005");
  assert.equal(result.product?.requestedKg, 40);
  assert.deepEqual(
    {
      material: result.calculation?.material,
      areaPerSideM2: result.calculation?.areaPerSideM2,
      sides: result.calculation?.sides,
      paintAreaM2: result.calculation?.paintAreaM2,
      estimatedKg: result.calculation?.estimatedKg,
      packages: result.calculation?.packages,
      roundedKg: result.calculation?.roundedKg,
    },
    {
      material: "дерево",
      areaPerSideM2: 54,
      sides: 2,
      paintAreaM2: 108,
      estimatedKg: 33.26,
      packages: 4,
      roundedKg: 40,
    },
  );
  assert.match(result.calculation?.explanation ?? "", /2 слоя/i);
  assert.match(result.calculation?.explanation ?? "", /10% запаса/i);
  assert.match(result.calculation?.explanation ?? "", /4 упаковки/i);
});

test("calculates wall paint from area and material without asking for a model or weight", () => {
  const result = buildDemoResult({
    subject: "Помогите рассчитать краску для стен",
    body: "Красим 120 м² стен по штукатурке в помещении, цвет белый. Подберите краску и количество.",
    company: "Учебный центр",
  });

  assert.equal(result.route, "ready");
  assert.equal(result.zone, "green");
  assert.equal(result.product?.sku, "КР-004");
  assert.equal(result.product?.requestedKg, 42);
  assert.deepEqual(
    {
      kind: result.calculation?.kind,
      surface: result.calculation?.surface,
      material: result.calculation?.material,
      source: result.calculation?.source,
      paintAreaM2: result.calculation?.paintAreaM2,
      estimatedKg: result.calculation?.estimatedKg,
      packages: result.calculation?.packages,
      roundedKg: result.calculation?.roundedKg,
    },
    {
      kind: "wall-area",
      surface: "стена",
      material: "штукатурка",
      source: "письмо клиента",
      paintAreaM2: 120,
      estimatedKg: 39.6,
      packages: 3,
      roundedKg: 42,
    },
  );
  assert.deepEqual(result.missing, []);
  assert.match(
    result.businessContext,
    /клиенту достаточно описать задачу обычными словами/iu,
  );
});

test("uses material and area recognized in a photo to calculate floor paint", () => {
  const result = buildDemoResult({
    subject: "Хочу покрасить пол",
    body: "Помогите подобрать серую краску для пола в помещении. Модель и количество не знаю.",
    company: "Мастерская",
    attachment: {
      name: "пол-мастерской.jpg",
      src: "/floor-demo.jpg",
      alt: "Распознано на фото: бетонный пол, площадь 80 м².",
    },
  });

  assert.equal(result.route, "ready");
  assert.equal(result.zone, "green");
  assert.equal(result.product?.sku, "КР-003");
  assert.equal(result.product?.requestedKg, 80);
  assert.equal(result.calculation?.kind, "floor-area");
  assert.equal(result.calculation?.surface, "пол");
  assert.equal(result.calculation?.material, "бетон");
  assert.equal(result.calculation?.source, "распознанное фото");
  assert.equal(result.calculation?.paintAreaM2, 80);
  assert.equal(result.calculation?.estimatedKg, 61.6);
  assert.equal(result.calculation?.packages, 4);
  assert.equal(result.calculation?.roundedKg, 80);
  assert.match(
    result.decisionBasis.map((basis) => basis.source).join(" "),
    /распознанные сведения о фото/iu,
  );
});

test("a live stock change alters the next decision and records its revision", () => {
  const input = {
    subject: "Краска для деревянных конструкций",
    body: "Нужны 100 кг коричневой краски для деревянных конструкций на улице.",
  };
  const lowStock = structuredClone(baseCatalog);
  lowStock.products = lowStock.products.map((product) =>
    product.sku === "КР-005"
      ? {
          ...product,
          stockKg: 40,
          stockRevision: 7,
          stockUpdatedAt: "2026-07-29T10:15:00+03:00",
        }
      : product,
  );
  const replenished = structuredClone(lowStock);
  replenished.products = replenished.products.map((product) =>
    product.sku === "КР-005"
      ? {
          ...product,
          stockKg: 180,
          stockRevision: 8,
          stockUpdatedAt: "2026-07-29T10:17:00+03:00",
        }
      : product,
  );

  const beforeRestock = buildDemoResult(input, lowStock);
  const afterRestock = buildDemoResult(input, replenished);

  assert.equal(beforeRestock.product?.requestedKg, 100);
  assert.equal(beforeRestock.product?.stockKg, 40);
  assert.equal(beforeRestock.route, "manager");
  assert.match(beforeRestock.zoneReason, /оставшиеся 60 кг/i);
  assert.equal(afterRestock.product?.stockKg, 180);
  assert.equal(afterRestock.route, "ready");
  assert.match(afterRestock.zoneReason, /весь объём подтверждён складом/i);
  assert.match(
    afterRestock.decisionBasis
      .map((basis) => basis.stockVersion ?? "")
      .join(" "),
    /обновление склада №8/iu,
  );
});

test("calculates a sourced trial-order opportunity and labels estimates", () => {
  const result = buildDemoResult({
    company: "АО «Петербургский тракторный завод»",
    website: "kirovets-ptz.com",
    subject: "Краска для металлических корпусов",
    body: "Добрый день! ИНН 7805059867. Нужны 40 кг износостойкой краски для металлических корпусов на улице, цвет RAL 9005.",
  });
  const copy = JSON.stringify(result);

  assert.equal(result.route, "ready");
  assert.equal(result.product?.sku, "КР-002");
  assert.equal(result.research?.checked, true);
  assert.equal(result.research?.sources.length, 4);
  assert.match(result.businessContext, /пробн/iu);
  assert.match(result.businessContext, /агент предполагает/iu);
  assert.match(result.businessContext, /2\s*348 машин за 2016 год/iu);
  assert.match(result.businessContext, /40 кг на одну машину/iu);
  assert.match(result.businessContext, /93\s*920 кг/iu);
  assert.match(result.businessContext, /93,92 т/iu);
  assert.match(
    result.businessContext,
    /текущий план выпуска и фактический расход подтвердит клиент/iu,
  );
  assert.match(result.managerNote, /записать фактический расход/iu);
  assert.match(result.managerNote, /текущий план выпуска/iu);
  assert.match(
    result.decisionBasis.map((basis) => basis.fact).join(" "),
    /2\s*348 машин.*40 кг на одну машину.*93\s*920 кг/iu,
  );
  assert.doesNotMatch(copy, /minPricePerKg|\"split\"|нарушен/i);
  assert.match(
    result.market.profitOpportunity,
    /сохраняем цену.*измерить фактический расход.*план выпуска/iu,
  );
  assert.match(
    result.market.summary,
    /сохраняем цену.*измерить фактический расход.*план выпуска/iu,
  );
  assert.match(result.zoneReason, /выглядит пробной партией/iu);
  assert.match(
    result.zoneReason,
    /93\s*920 кг возможной годовой потребности/iu,
  );
});

test("uses positive, readable checks in standard and manager routes", () => {
  const standard = buildDemoResult({
    subject: "Краска для ограждений",
    body: "Нужны 200 кг краски для металлических ограждений на улице, цвет RAL 7024.",
  });
  const manager = buildDemoResult({
    subject: "Крупная партия для ограждений",
    body: "Нужны 800 кг краски для металлических ограждений на улице, цвет RAL 7024.",
  });
  const copy = JSON.stringify({ standard, manager });

  assert.deepEqual(standard.checks.slice(0, 3), [
    "По этой цене завод зарабатывает на заказе",
    "Весь объём подтверждён складом",
    "Письмо собрано по правилам завода",
  ]);
  assert.match(
    manager.checks.join(" "),
    /по этой цене завод зарабатывает на заказе/i,
  );
  assert.doesNotMatch(
    copy,
    /минимальн\p{L}*\s+границ|minPricePerKg|нарушен|"split"/iu,
  );
});

test("explains a high market position through confirmed value and the next profit move", () => {
  const result = buildDemoResult({
    subject: "Краска для пола цеха",
    body: "Нужны 200 кг серой краски для бетонного пола в помещении.",
  });

  assert.equal(result.route, "ready");
  assert.match(
    result.market.position,
    /цена выше большинства показанных предложений.*весь объём и срок поставки подтверждены/iu,
  );
  assert.equal(
    result.market.profitOpportunity,
    "Заработать больше поможет крупный заказ или удобный график поставки.",
  );
});

test("turns everyday payment terms into three concrete manager choices", () => {
  const result = buildDemoResult({
    company: "ГрандСтрой",
    subject: "Краска для стен с оплатой после поставки",
    body: "Заказываем 900 кг белой моющейся краски для внутренних стен по штукатурке. Просим оплату через 90 дней после поставки.",
  });

  assert.equal(result.route, "manager");
  assert.deepEqual(
    result.options.map((option) => option.title),
    [
      "Сохранить цену при оплате до отгрузки",
      "Разрешить оплату после поставки за план закупок",
      "Разделить оплату на два этапа",
    ],
  );
  assert.ok(result.options.every((option) => option.reply.length > 80));
  assert.ok(
    result.options.every(
      (option) =>
        typeof option.businessResult === "string" &&
        option.businessResult.length > 40,
    ),
  );
});

test("keeps delayed payment visible when stock is short", () => {
  const result = buildDemoResult({
    company: "ГрандСтрой",
    subject: "Краска для стен с оплатой после поставки",
    body: "Заказываем 1400 кг белой моющейся краски для внутренних стен по штукатурке. Просим оплату через 45 дней после поставки.",
  });

  assert.equal(result.route, "manager");
  assert.equal(result.product?.requestedKg, 1400);
  assert.ok((result.product?.stockKg ?? 0) < 1400);
  assert.match(result.zoneReason, /оплат\p{L}*\s+после\s+поставк/iu);
  assert.doesNotMatch(JSON.stringify(result), /90\s+дн/iu);
  assert.equal(result.options.length, 3);
  assert.ok(
    result.options.some(
      (option) => option.title === "Разделить оплату по партиям",
    ),
  );
});

test("keeps shortage, customer price and payment together for the manager", () => {
  const result = buildDemoResult({
    company: "МеталлИнвест",
    subject: "Крупная поставка для металлоконструкций",
    body: "Нужны 1500 кг чёрной краски для металла с защитой от ржавчины, работы на улице. Цена — 320 ₽/кг, оплата через 60 дней после поставки.",
  });

  assert.equal(result.route, "manager");
  assert.match(result.zoneReason, /склад подтверждает/iu);
  assert.match(result.zoneReason, /оплат\p{L}*\s+после\s+поставк/iu);
  assert.match(result.zoneReason, /цена клиента.*320\s*₽\/кг/iu);
  assert.match(
    result.zoneReason,
    /завод зарабатывает при цене от 332\s*₽\/кг/iu,
  );
});

test("falls back to the safe catalog value when a snapshot has invalid stock", () => {
  const brokenSnapshot = structuredClone(baseCatalog);
  brokenSnapshot.products = brokenSnapshot.products.map((product) =>
    product.sku === "КР-005" ? { ...product, stockKg: -500 } : product,
  );

  const result = buildDemoResult(
    {
      subject: "Краска для деревянных конструкций",
      body: "Нужны 100 кг коричневой краски для деревянных конструкций на улице.",
    },
    brokenSnapshot,
  );

  assert.equal(result.product?.stockKg, 180);
  assert.equal(result.route, "ready");
});
