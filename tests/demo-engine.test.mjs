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
  assert.doesNotMatch(result.businessContext, /фото/iu);
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

test("does not offer a paint replacement without recalculating a large fence", () => {
  const result = buildDemoResult({
    subject: "Краска для большого забора",
    body: "Металлический забор длиной 500 м и высотой 2 м. Красим с одной стороны, цвет серый. Забор стоит на улице.",
  });

  assert.equal(result.route, "manager");
  assert.equal(result.product?.sku, "КР-001");
  assert.equal(result.product?.requestedKg, 400);
  assert.equal(result.calculation?.paintAreaM2, 1000);
  assert.equal(
    result.options.some((option) => option.id === "замена-краски"),
    false,
  );
});

test("offers a stocked replacement only when it has the requested color", () => {
  const unavailableColor = buildDemoResult({
    subject: "Большой заказ краски для металла",
    body: "Нужны 800 кг тёмно-серой краски для металла на улице, цвет RAL 7024.",
  });
  const availableColor = buildDemoResult({
    subject: "Большой заказ краски для металла",
    body: "Нужны 800 кг чёрной краски для металла на улице, цвет RAL 9005.",
  });

  assert.equal(unavailableColor.route, "manager");
  assert.equal(
    unavailableColor.options.some((option) => option.id === "замена-краски"),
    false,
  );
  assert.equal(
    availableColor.options.some((option) => option.id === "замена-краски"),
    true,
  );
});

test("keeps a corrected color and the customer's delivery plan in the replacement letter", () => {
  const result = buildDemoResult({
    subject: "Заказ краски для металла",
    body: [
      "Нужно 800 кг краски для металла на улице, цвет RAL 7024.",
      "Ответ клиента 1: Меняем цвет на RAL 9005. Всего нужно 800 кг: 200 кг сейчас, остальные 600 кг позже.",
    ].join("\n\n"),
  });
  const replacement = result.options.find(
    (option) => option.id === "замена-краски",
  );

  assert.equal(result.route, "manager");
  assert.equal(result.product?.requestedKg, 800);
  assert.equal(result.product?.firstDeliveryKg, 200);
  assert.equal(result.product?.color, "RAL 9005");
  assert.ok(replacement);
  assert.match(replacement.reply, /RAL 9005/u);
  assert.doesNotMatch(replacement.reply, /RAL 7024/u);
  assert.match(replacement.reply, /200 кг[^.]*первой поставки/iu);
  assert.match(replacement.reply, /600 кг[^.]*следующей/iu);
  assert.match(
    result.options.find((option) => option.id === "две-поставки")?.reply ?? "",
    /200 кг сейчас и 600 кг/iu,
  );
});

test("keeps the first delivery after the warehouse grows to the full order", () => {
  const catalogWithFullStock = {
    ...baseCatalog,
    products: baseCatalog.products.map((product) =>
      product.sku === "КР-001" ? { ...product, stockKg: 900 } : product,
    ),
  };
  const result = buildDemoResult(
    {
      subject: "Заказ краски для металла",
      body: [
        "Нужно 800 кг краски для металла на улице, цвет RAL 9005.",
        "Ответ клиента 1: Нужно 200 кг сейчас, остальное позже.",
      ].join("\n\n"),
    },
    catalogWithFullStock,
  );

  assert.equal(result.route, "ready");
  assert.equal(result.product?.requestedKg, 800);
  assert.equal(result.product?.firstDeliveryKg, 200);
  assert.match(result.reply.body, /200 кг/iu);
  assert.match(result.reply.body, /600 кг/iu);
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

test("uses a company profile to form a cautious floor hypothesis and one question", () => {
  const result = buildDemoResult({
    company: "ГК «ПРОТЕК»",
    website: "protek-group.ru",
    subject: "Помогите выбрать краску для пола",
    body: "Нужна светло-серая краска для пола в новом помещении площадью 800 м². Марку и количество не знаем. Пол моют каждый день.",
  });
  const visibleCopy = [
    result.businessContext,
    result.zoneReason,
    result.reply.body,
  ].join(" ");

  assert.equal(result.route, "needs_info");
  assert.equal(result.zone, "yellow");
  assert.equal(result.product?.sku, "КР-003");
  assert.equal(result.product?.requestedKg, 0);
  assert.equal(result.research?.checked, true);
  assert.equal(result.research?.sources.length, 2);
  assert.equal(result.missing.length, 1);
  assert.match(
    result.missing[0],
    /материал пола.*назначение помещения.*способ уборки.*нагрузка/iu,
  );
  assert.match(result.businessContext, /фармацевтическ.*медицинск/iu);
  assert.match(result.businessContext, /агент предполагает/iu);
  assert.match(
    result.businessContext,
    /подходит для цехов и складов.*выдерживает тележки и технику/iu,
  );
  assert.match(
    result.reply.body,
    /похоже, помещение может быть складом.*если (?:его|помещение) используют как медицинский склад.*первым вариантом станет краска/isu,
  );
  assert.match(
    result.reply.body,
    /обычный склад.*другое помещение.*подберём покрытие по назначению/isu,
  );
  assert.match(result.reply.body, /светло-серый.*есть в каталоге/iu);
  assert.match(
    result.reply.body,
    /как используют помещение/iu,
  );
  assert.match(result.understood.join(" "), /цвет: светло-серый/iu);
  assert.match(
    result.reply.body,
    /рассчитаем заказ на 800 м².*проверим цвет.*остаток на складе/isu,
  );
  assert.doesNotMatch(result.reply.body, /ГОСТ|дезинфиц|технолог/iu);
  assert.doesNotMatch(
    result.reply.body,
    /учебн\p{L}*\s+(?:таблиц|каталог)|\bагент\p{L}*/iu,
  );
  assert.equal((result.reply.body.match(/\?/gu) ?? []).length, 1);
  assert.doesNotMatch(
    visibleCopy,
    /КР-003\s+(?:соответствует|подходит)\s+(?:ГОСТ|GMP|ISO|СанПиН)|выдерживает\s+дезинфекц/iu,
  );
  assert.match(
    result.decisionBasis.map((basis) => basis.source).join(" "),
    /О группе компаний «ПРОТЕК».*Направления бизнеса/iu,
  );
});

test("continues the floor card through a customer reply and a live stock change", () => {
  const initialBody =
    "Нужна светло-серая краска для пола в новом помещении площадью 800 м². Марку и количество не знаем. Пол моют каждый день.";
  const input = {
    company: "ГК «ПРОТЕК»",
    website: "protek-group.ru",
    subject: "Помогите выбрать краску для пола",
    body: `${initialBody}\n\nОтвет клиента 1: Пол бетонный. Храним лекарства. Моем нейтральным средством. По полу ездят погрузчики.`,
  };
  const replenished = structuredClone(baseCatalog);
  replenished.products = replenished.products.map((product) =>
    product.sku === "КР-003"
      ? {
          ...product,
          stockKg: 700,
          stockRevision: 12,
          stockUpdatedAt: "2026-07-30T12:00:00+03:00",
        }
      : product,
  );

  const beforeRestock = buildDemoResult(input);
  const afterRestock = buildDemoResult(input, replenished);

  assert.equal(beforeRestock.route, "manager");
  assert.equal(beforeRestock.zone, "red");
  assert.equal(beforeRestock.product?.requestedKg, 620);
  assert.equal(beforeRestock.calculation?.paintAreaM2, 800);
  assert.match(beforeRestock.calculation?.explanation ?? "", /31 упаковку/iu);
  assert.doesNotMatch(
    beforeRestock.calculation?.explanation ?? "",
    /31 упаковок/iu,
  );
  assert.deepEqual(beforeRestock.missing, []);
  assert.match(beforeRestock.understood.join(" "), /хранение помещения:|назначение помещения:/iu);
  assert.match(beforeRestock.understood.join(" "), /нейтральное моющее средство/iu);
  assert.match(beforeRestock.understood.join(" "), /погрузчики/iu);
  const supplierHelp = beforeRestock.options.find(
    (option) => option.id === "помочь-с-недостающим-объёмом",
  );
  assert.ok(supplierHelp);
  assert.equal(beforeRestock.supplierPlan?.ourKg, 420);
  assert.equal(beforeRestock.supplierPlan?.supplierKg, 200);
  assert.equal(beforeRestock.supplierPlan?.ourSubtotal, 174300);
  assert.equal(beforeRestock.supplierPlan?.supplierSubtotal, 80400);
  assert.equal(beforeRestock.supplierPlan?.total, 254700);
  assert.equal(beforeRestock.supplierPlan?.deliveryDays, 4);
  assert.equal(beforeRestock.supplierPlan?.offersChecked, 3);
  assert.equal(beforeRestock.supplierPlan?.eligibleOffers, 2);
  const supplierCopy = `${supplierHelp.rationale} ${supplierHelp.reply}`;
  assert.match(supplierCopy, /Индустрия Покрытий/iu);
  assert.match(supplierCopy, /420 кг.*415 ₽/isu);
  assert.match(supplierCopy, /200 кг.*402 ₽/isu);
  assert.match(supplierHelp.reply, /254\s*700 ₽/u);
  assert.match(supplierCopy, /4 дня/iu);
  assert.match(supplierHelp.rationale, /на 6 дней раньше/iu);
  assert.match(supplierHelp.rationale, /на 2\s*600 ₽ меньше/iu);
  assert.doesNotMatch(
    supplierHelp.reply,
    /учебн\p{L}*\s+(?:таблиц|каталог)|\bагент\p{L}*/iu,
  );
  assert.match(
    supplierHelp.reply,
    /на складе «Колера» доступно 420 кг.*по данным от 30\.07\.2026, 10:40.*доступно 260 кг.*готовим запрос партнёру: подтвердить 200 кг; срок — 4 дня; цвет — «светло-серый»; совместимость.*после подтверждений пришлём единый график/isu,
  );
  assert.match(
    supplierHelp.reply,
    /после подтверждения.*(?:сократить ожидание|раньше).*6 дней.*2\s*600 ₽/isu,
  );
  assert.doesNotMatch(
    supplierHelp.reply,
    /подготовили способ собрать все|так вы получите весь объём/iu,
  );
  assert.match(
    beforeRestock.decisionBasis.map((basis) => basis.source).join(" "),
    /цен и наличия других поставщиков/iu,
  );

  assert.equal(afterRestock.route, "ready");
  assert.equal(afterRestock.zone, "green");
  assert.equal(afterRestock.product?.stockKg, 700);
  assert.equal(afterRestock.product?.requestedKg, 620);
  assert.deepEqual(afterRestock.missing, []);
  assert.doesNotMatch(afterRestock.reply.body, /что храните|чем его моете/iu);
  assert.match(
    afterRestock.reply.body,
    /подходит для цехов и складов.*ежедневной влажной уборки нейтральным средством/isu,
  );
  assert.match(afterRestock.reply.body, /паспорт качества/iu);
  assert.doesNotMatch(afterRestock.reply.body, /Клиент подтвердил/iu);
  assert.doesNotMatch(
    afterRestock.reply.body,
    /соответств\p{L}*\s+(?:ГОСТ|GMP|ISO|СанПиН)|выдерживает\s+дезинфекц/iu,
  );
  assert.match(
    afterRestock.decisionBasis.map((basis) => basis.stockVersion).join(" "),
    /12/u,
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

test("builds a complete green letter from the client order", () => {
  const result = buildDemoResult({
    company: "Посёлок «Сосны»",
    subject: "Краска для деревянных конструкций",
    body: "Нужны 100 кг коричневой краски для деревянных конструкций на улице. Доставка в Тверь через две недели.",
  });

  assert.equal(result.route, "ready");
  assert.match(result.reply.body, /предложение для компании Посёлок «Сосны»/u);
  assert.match(
    result.reply.body,
    /100 кг краски «Краска для дерева на улице», цвет — коричневый/iu,
  );
  assert.match(result.reply.body, /296 ₽\/кг, сумма — 29\s*600 ₽/u);
  assert.match(result.reply.body, /доставка в Тверь через две недели/iu);
  assert.match(result.reply.body, /точный адрес разгрузки/iu);
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

test("states the exact nearby market difference in both directions", () => {
  const input = {
    subject: "Краска для ограждений",
    body: "Нужны 200 кг краски для металлических ограждений на улице, цвет RAL 7024.",
  };
  const belowMarket = structuredClone(baseCatalog);
  belowMarket.products = belowMarket.products.map((product) =>
    product.sku === "КР-001"
      ? { ...product, pricePerKg: 345 }
      : product,
  );

  const above = buildDemoResult(input);
  const below = buildDemoResult(input, belowMarket);

  assert.equal(
    above.market.position,
    "Наша цена 349 ₽/кг, на 2 ₽ выше средней цены других поставщиков. Цена близка к рынку. Весь объём подтверждён складом.",
  );
  assert.equal(
    below.market.position,
    "Наша цена 345 ₽/кг, на 2 ₽ ниже средней цены других поставщиков. Цена выглядит привлекательно. Весь объём подтверждён складом.",
  );
  assert.match(
    `${above.market.position} ${below.market.position}`,
    /близка к рынку/iu,
  );
});

test("uses a direct rule for manager choices", () => {
  assert.equal(
    baseCatalog.rules.plainPolicy[2],
    "Руководитель выбирает скидку, оплату после поставки, условие о задержке, условия конкурса поставщиков и срок срочной поставки.",
  );
});

test("explains a high market position through confirmed value and the next profit move", () => {
  const result = buildDemoResult({
    subject: "Краска для пола цеха",
    body: "Нужны 200 кг серой краски для бетонного пола в помещении.",
  });

  assert.equal(result.route, "ready");
  assert.equal(
    result.market.position,
    "Наша цена 415 ₽/кг, на 12 ₽ выше средней цены других поставщиков. Агент покажет клиенту наличие, срок и свойства краски. Весь объём подтверждён складом.",
  );
  assert.equal(
    result.market.profitOpportunity,
    "Заработать больше поможет крупный заказ или удобный график поставки.",
  );

  const equalPriceCatalog = structuredClone(baseCatalog);
  equalPriceCatalog.products = equalPriceCatalog.products.map((product) =>
    product.sku === "КР-003" ? { ...product, pricePerKg: 402 } : product,
  );
  const equalPrice = buildDemoResult(
    {
      subject: "Краска для пола цеха",
      body: "Нужны 200 кг серой краски для бетонного пола в помещении.",
    },
    equalPriceCatalog,
  );
  assert.equal(
    equalPrice.market.position,
    "Наша цена 402 ₽/кг, на 1 ₽ ниже средней цены других поставщиков. Цена выглядит привлекательно. Весь объём подтверждён складом.",
  );
});

test("keeps the market note aligned with a stock shortage", () => {
  const result = buildDemoResult({
    subject: "Срочное покрытие пола терминала",
    body: "Нужны 650 кг серой краски для бетонного пола в помещении.",
  });

  assert.equal(result.route, "manager");
  assert.equal(result.product?.stockKg, 420);
  assert.equal(
    result.market.position,
    "Наша цена 415 ₽/кг, на 12 ₽ выше средней цены других поставщиков. Агент покажет клиенту наличие, срок и свойства краски. Склад подтверждает 420 из 650 кг. Поставку оставшейся части согласует руководитель.",
  );
  assert.doesNotMatch(
    `${result.market.position} ${result.market.summary}`,
    /весь объём.*подтверждён/iu,
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

test("uses confirmed conditions for an ordinary room at a researched company", () => {
  const replenished = structuredClone(baseCatalog);
  replenished.products = replenished.products.map((product) =>
    product.sku === "КР-003" ? { ...product, stockKg: 700 } : product,
  );
  const result = buildDemoResult(
    {
      company: "ГК «ПРОТЕК»",
      website: "protek-group.ru",
      subject: "Помогите выбрать краску для пола",
      body: [
        "Нужна светло-серая краска для пола в новом помещении площадью 800 м². Пол моют каждый день.",
        "Ответ клиента 1: Помещение будет мастерской. Пол бетонный, моем нейтральным средством, погрузчиков не будет.",
      ].join("\n\n"),
    },
    replenished,
  );
  const visibleCopy = `${result.businessContext} ${result.reply.body}`;

  assert.equal(result.route, "ready");
  assert.equal(result.product?.sku, "КР-003");
  assert.equal(result.product?.requestedKg, 620);
  assert.match(result.understood.join(" "), /мастерск/iu);
  assert.match(result.reply.body, /назначение «мастерской»/iu);
  assert.doesNotMatch(
    visibleCopy,
    /краска\s+(?:подходит|соответствует)\s+(?:для\s+)?(?:фармацевтическ|медицинск)|соответств\p{L}*\s+ГОСТ|выдерживает\s+дезинфекц/iu,
  );
});

test("keeps a named standard or disinfectant pending verification", () => {
  const result = buildDemoResult({
    company: "ГК «ПРОТЕК»",
    website: "protek-group.ru",
    subject: "Краска для пола медицинского склада",
    body: "Нужна светло-серая краска для бетонного пола медицинского склада площадью 400 м². Пол каждый день обрабатывают дезинфицирующим средством, по нему ездят погрузчики. Требуется соответствие ГОСТ.",
  });

  const optionCopy = result.options
    .map(
      (option) =>
        `${option.title} ${option.rationale} ${option.tradeoff} ${option.reply}`,
    )
    .join(" ");

  assert.equal(result.route, "manager");
  assert.equal(result.zone, "red");
  assert.match(result.missing.join(" "), /документ|ГОСТ|средств|технолог/iu);
  assert.match(
    optionCopy,
    /точное название.*(?:документ|средств).*технолог.*паспортом качества.*карточкой краски/isu,
  );
  assert.match(
    `${result.zoneReason} ${result.managerNote}`,
    /документ|дезинфиц|средств/iu,
  );
  assert.doesNotMatch(
    `${result.zoneReason} ${result.managerNote}`,
    /моторн\p{L}*\s+масл/iu,
  );
  assert.doesNotMatch(
    `${result.businessContext} ${result.reply.body} ${optionCopy}`,
    /подтверждаем\s+соответствие\s+ГОСТ|КР-003\s+соответствует\s+ГОСТ|выдерживает\s+дезинфекц/iu,
  );
});
