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

test("uses only sourced company facts and labels the test-order idea as a hypothesis", () => {
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
  assert.equal(result.research?.sources.length, 3);
  assert.match(result.businessContext, /пробн/iu);
  assert.match(result.businessContext, /агент предполагает/iu);
  assert.match(result.managerNote, /какие свойства краски клиент проверяет/i);
  assert.doesNotMatch(copy, /на один трактор|расход.*трактор/i);
  assert.doesNotMatch(copy, /minPricePerKg|\"split\"|нарушен/i);
  assert.match(
    result.market.profitOpportunity,
    /сохраняем цену.*спрашиваем.*объём/iu,
  );
  assert.match(
    result.market.summary,
    /сохраняем цену.*спрашиваем.*объём/iu,
  );
  assert.match(result.zoneReason, /выглядит пробной партией/iu);
  assert.match(
    result.zoneReason,
    /какие свойства краски клиент проверяет.*какой объём понадобится/iu,
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
});

test("keeps delayed payment visible when stock is short", () => {
  const result = buildDemoResult({
    company: "ГрандСтрой",
    subject: "Краска для стен с оплатой после поставки",
    body: "Заказываем 1400 кг белой моющейся краски для внутренних стен по штукатурке. Просим оплату через 90 дней после поставки.",
  });

  assert.equal(result.route, "manager");
  assert.equal(result.product?.requestedKg, 1400);
  assert.ok((result.product?.stockKg ?? 0) < 1400);
  assert.match(
    result.zoneReason,
    /оплат\p{L}*\s+через\s+90\s+дн\p{L}*\s+после\s+поставк/iu,
  );
  assert.equal(result.options.length, 3);
  assert.ok(
    result.options.some(
      (option) => option.title === "Разделить оплату по партиям",
    ),
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
