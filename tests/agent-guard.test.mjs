import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyReviewerResult,
  normalizeAgentResult,
} from "../lib/agent-guard.mjs";

const demoData = JSON.parse(
  await readFile(new URL("../data/paint-demo.json", import.meta.url), "utf8"),
);

function agentDraft({
  sku = "КР-001",
  requestedKg = 200,
  zone = "green",
  options = [],
} = {}) {
  return {
    zone,
    decision: zone === "green" ? "quote" : "escalate",
    confidence: 0.92,
    understood: [`Объём: ${requestedKg} кг`],
    missing: [],
    product: {
      sku,
      name: "Ответ модели",
      stockKg: 9999,
      requestedKg,
      pricePerKg: 1,
      total: requestedKg,
      replenishmentDays: 0,
    },
    market: { checked: false, summary: "", items: [] },
    businessContext: "Компания работает с промышленными объектами.",
    zoneReason: "Модель считает заказ выполнимым.",
    managerNote: "Подготовить предложение.",
    options,
    reply: {
      subject: "Предложение по заказу",
      body: "Подтверждаем заказ по каталожной цене.",
    },
    checks: [],
    sources: [],
    review: { model: "", verdict: "", notes: [] },
  };
}

test("grounds a red order in catalog data and keeps visible copy clean", () => {
  const result = normalizeAgentResult(
    {
      zone: "green",
      decision: "quote",
      confidence: 0.92,
      understood: ["Объём: 800 кг"],
      missing: [],
      product: {
        sku: "КР-001",
        name: "Invented product",
        stockKg: 900,
        requestedKg: 800,
        pricePerKg: 1,
        total: 800,
        replenishmentDays: 0,
      },
      market: {
        checked: true,
        summary: "Price is in market range",
        items: [],
      },
      businessContext: "Машиностроение: важен срок.",
      zoneReason: "Everything is available",
      managerNote: "",
      options: [
        {
          id: "split",
          title: "Разделить поставку",
          rationale: "Отгрузить первую партию со склада.",
          tradeoff: "Клиент получает часть объёма раньше.",
          reply: "Предлагаем разделить поставку.",
        },
      ],
      reply: {
        subject: "Offer RAL 7024",
        body: "We have available 300 kg product.",
      },
      checks: ["targetMargin passed"],
      sources: ["product catalog", "stock data"],
      review: { model: "", verdict: "", notes: [] },
    },
    demoData,
    {
      company: "ВолгаМаш",
      subject: "Заказ грунт-эмали",
      body: "Нужно 800 кг для оборудования снаружи, цвет RAL 7024.",
    },
  );

  assert.equal(result.zone, "red");
  assert.equal(result.decision, "escalate");
  assert.equal(result.product.name, "Барьер 3в1");
  assert.equal(result.product.stockKg, 300);
  assert.equal(result.product.pricePerKg, 349);
  assert.equal(result.options.length, 3);
  assert.match(result.market.summary, /Цена «Колер»: 349 ₽\/кг/);
  assert.match(result.reply.body, /выберет руководитель/);
  assert.deepEqual(result.sources, [
    "Входящее письмо",
    "Каталог и остатки",
    "Правила продаж",
    "Демонстрационный срез рынка",
    "Демонстрационный отраслевой сценарий",
  ]);
  assert.doesNotMatch(
    JSON.stringify({
      market: result.market,
      reply: result.reply,
      checks: result.checks,
      sources: result.sources,
    }),
    /available|product catalog|stock data|targetMargin/i,
  );
});

test("records a safe template replacement without leaking rejected Latin copy", () => {
  const draft = agentDraft();
  draft.reply.body =
    "We can deliver 200 kg tomorrow at a special price.";

  const result = normalizeAgentResult(draft, demoData, {
    company: "Завод",
    subject: "Стандартный заказ КР-001",
    body: "Нужно 200 кг КР-001 для наружных работ, цвет RAL 7024.",
  });

  assert.match(
    result.checks.join(" "),
    /клиентский текст заменён безопасным шаблоном.*латиниц/i,
  );
  assert.doesNotMatch(
    JSON.stringify({
      checks: result.checks,
      reply: result.reply,
      options: result.options,
    }),
    /We can deliver|special price/i,
  );
});

test("removes CJK fragments from every visible model field", () => {
  const draft = agentDraft();
  draft.understood = [
    "Продукт КР-001",
    "В заказ 也包括 срочная доставка",
    "Фрагмент ㄅ",
  ];
  draft.product.note = "Скидка согласована 也包括";
  draft.unexpected = "Скрытый вывод 也包括";
  draft.businessContext = "Компания 也包括 несколько площадок.";
  draft.zoneReason = "Заказ 也包括 особые условия.";
  draft.managerNote = "Проверить 也包括 график.";
  draft.research = {
    checked: true,
    summary: "Источник 也包括 сведения о компании.",
    sources: [
      {
        title: "Карточка 也包括 компании",
        url: "https://example.com/company",
        checkedAt: "2026-07-28 也包括",
        fact: "Компания 也包括 выпускает оборудование.",
      },
    ],
  };
  draft.reply.body = "Подтверждаем 也包括 заказ.";

  const result = normalizeAgentResult(draft, demoData, {
    company: "Завод",
    subject: "Стандартный заказ КР-001",
    body: "Нужно 200 кг КР-001 для наружных работ, цвет RAL 7024.",
  });

  assert.doesNotMatch(
    JSON.stringify(result),
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u,
  );
  assert.match(result.reply.body, /Подтвердили 200 кг/);
  assert.equal("unexpected" in result, false);
});

test("replaces client rhetoric that violates the Russian copy contract", () => {
  const draft = agentDraft();
  const rejectedCopy = [
    "Мы",
    "не",
    "обещаем полный объём,",
    "а",
    "предлагаем особый ход.",
  ].join(" ");
  draft.reply.body = rejectedCopy;

  const result = normalizeAgentResult(draft, demoData, {
    company: "Завод",
    subject: "Стандартный заказ КР-001",
    body: "Нужно 200 кг КР-001 для наружных работ, цвет RAL 7024.",
  });

  assert.match(
    result.checks.join(" "),
    /клиентский текст заменён безопасным шаблоном.*русского текста/i,
  );
  assert.doesNotMatch(result.reply.body, /особый ход/i);
});

test("does not repeat unsafe client rhetoric in the reply subject", () => {
  const draft = agentDraft();
  draft.zone = "yellow";
  draft.decision = "clarify";
  draft.product = null;
  draft.missing = ["назначение покрытия"];

  const result = normalizeAgentResult(draft, demoData, {
    company: "Завод",
    subject: "Это не заказ, а запрос",
    body: "Нужна краска для нового помещения.",
  });

  assert.equal(result.reply.subject, "Уточнение по заказу: краска");
  assert.doesNotMatch(result.reply.subject, /не\s+.+\s+а\s+/iu);
});

test("replaces a red option set with an all-caps heading", () => {
  const options = [
    {
      id: "shout",
      title: "РАЗДЕЛИТЬ ПОСТАВКУ",
      rationale: "Отгрузить доступную партию по подтверждённому графику.",
      tradeoff: "Потребуются две отгрузки.",
      reply: "Предлагаем разделить поставку по согласованному графику.",
    },
    {
      id: "ask",
      title: "Уточнить график",
      rationale: "Получить допустимые даты от клиента.",
      tradeoff: "Расчёт продолжится после ответа.",
      reply: "Уточните допустимый график поставки.",
    },
  ];

  const result = normalizeAgentResult(
    agentDraft({ sku: "КР-001", requestedKg: 800, options }),
    demoData,
    {
      company: "Завод",
      subject: "Заказ КР-001",
      body: "Нужно 800 кг КР-001 для металла снаружи, цвет RAL 7024.",
    },
  );

  assert.equal(result.options.length, 3);
  assert.doesNotMatch(
    result.options.map((option) => option.title).join(" "),
    /РАЗДЕЛИТЬ ПОСТАВКУ/,
  );
});

test("replaces an all-caps model reason with a calm fallback", () => {
  const draft = agentDraft();
  draft.zoneReason = "СРОЧНО СОГЛАСУЙТЕ УСЛОВИЕ";

  const result = normalizeAgentResult(draft, demoData, {
    company: "Завод",
    subject: "Стандартный заказ КР-001",
    body: "Нужно 200 кг КР-001 для наружных работ, цвет RAL 7024.",
  });

  assert.equal(result.zoneReason, "Товар, объём и цена подтверждены.");
});

test("keeps a completed research check visible when no sources were found", () => {
  const draft = agentDraft();
  draft.research = {
    checked: true,
    summary: "Поиск завершён, подтверждённых публичных источников не найдено.",
    sources: [],
  };

  const result = normalizeAgentResult(draft, demoData, {
    company: "Завод",
    subject: "Стандартный заказ КР-001",
    body: "Нужно 200 кг КР-001 для наружных работ, цвет RAL 7024.",
  });

  assert.equal(result.research.checked, true);
  assert.deepEqual(result.research.sources, []);
  assert.match(result.research.summary, /поиск завершён/i);
});

test("keeps a public source with a Latin date label", () => {
  const draft = agentDraft();
  draft.research = {
    checked: true,
    summary: "Публичная карточка компании найдена.",
    sources: [
      {
        title: "Карточка компании",
        url: "https://example.com/company",
        checkedAt: "28 Jul 2026",
        fact: "Компания выпускает промышленное оборудование.",
      },
    ],
  };

  const result = normalizeAgentResult(draft, demoData, {
    company: "Завод",
    subject: "Стандартный заказ КР-001",
    body: "Нужно 200 кг КР-001 для наружных работ, цвет RAL 7024.",
  });

  assert.equal(result.research.sources.length, 1);
  assert.equal(result.research.sources[0].checkedAt, "28 Jul 2026");
});

test("clips a long research summary at a word boundary", () => {
  const draft = agentDraft();
  draft.research = {
    checked: true,
    summary: `${"Подтверждённый факт. ".repeat(40)}НезавершённоеСлово`,
    sources: [],
  };

  const result = normalizeAgentResult(draft, demoData, {
    company: "Завод",
    subject: "Стандартный заказ КР-001",
    body: "Нужно 200 кг КР-001 для наружных работ, цвет RAL 7024.",
  });

  assert.ok(result.research.summary.length <= 700);
  assert.match(result.research.summary, /…$/);
  assert.doesNotMatch(result.research.summary, /НезавершённоеСлово/);
});

test("forces an unknown SKU from the letter into the yellow zone", () => {
  const result = normalizeAgentResult(agentDraft(), demoData, {
    company: "ПромРемонт",
    subject: "Заказ КР-099",
    body: "Нужно 220 кг продукта КР-099 для металла внутри помещения, цвет серый.",
  });

  assert.equal(result.zone, "yellow");
  assert.equal(result.decision, "clarify");
  assert.equal(result.product, null);
  assert.match(result.missing.join(" "), /КР-099/);
});

test("stops a quote when the model SKU disagrees with the product named in the letter", () => {
  const draft = agentDraft({ sku: "КР-001", requestedKg: 200 });
  draft.reply.body =
    "Подтверждаем 200 кг продукта «Барьер 3в1» по цене 349 ₽/кг.";

  const result = normalizeAgentResult(draft, demoData, {
    company: "МехПром",
    subject: "Заказ Металл Про",
    body: "Нужно 200 кг Металл Про для наружных металлоконструкций, цвет RAL 7024.",
  });

  assert.equal(result.zone, "yellow");
  assert.equal(result.decision, "clarify");
  assert.equal(result.product?.sku, "КР-002");
  assert.match(result.missing.join(" "), /артикул.*модел/i);
  assert.doesNotMatch(result.reply.body, /подтверждаем|349 ₽\/кг/i);
});

test("recomputes material gaps from the letter and removes the model quote", () => {
  const draft = agentDraft({ sku: "КР-001", requestedKg: 200 });
  draft.missing = ["Подтверждаем цену 1 ₽/кг"];
  draft.reply.body =
    "Подтверждаем наличие 200 кг по цене 349 ₽/кг и совместимость покрытия.";

  const result = normalizeAgentResult(draft, demoData, {
    company: "МехПром",
    subject: "Проверка покрытия КР-001",
    body: "Нужно 200 кг. Подходит ли покрытие для нашего оборудования?",
  });

  assert.equal(result.zone, "yellow");
  assert.equal(result.decision, "clarify");
  assert.match(result.missing.join(" "), /условия эксплуатации/i);
  assert.match(result.missing.join(" "), /цвет|RAL/i);
  assert.match(result.missing.join(" "), /совместимость/i);
  assert.doesNotMatch(
    result.reply.body,
    /подтверждаем|349 ₽\/кг|совместимость покрытия/i,
  );
});

test("keeps a shortage red when color and environment are missing", () => {
  const result = normalizeAgentResult(
    agentDraft({ sku: "КР-001", requestedKg: 800 }),
    demoData,
    {
      company: "Завод",
      subject: "Заказ КР-001",
      body: "Нужно 800 кг КР-001.",
    },
  );

  assert.equal(result.zone, "red");
  assert.equal(result.decision, "escalate");
  assert.match(result.missing.join(" "), /условия эксплуатации/i);
  assert.match(result.missing.join(" "), /цвет|RAL/i);
  assert.match(result.zoneReason, /запрошено 800 кг.*в наличии 300 кг/i);
  assert.equal(result.options.length, 3);
});

for (const [risk, condition] of [
  ["a price below the minimum", "Цена не выше 320 ₽/кг."],
  ["a requested discount", "Просим скидку 10%."],
  ["special terms", "Просим отсрочку 60 дней."],
]) {
  test(`keeps ${risk} red when color and environment are missing`, () => {
    const result = normalizeAgentResult(agentDraft(), demoData, {
      company: "Завод",
      subject: "Заказ КР-001",
      body: `Нужно 200 кг КР-001. ${condition}`,
    });

    assert.equal(result.zone, "red");
    assert.equal(result.decision, "escalate");
    assert.match(result.missing.join(" "), /условия эксплуатации/i);
    assert.match(result.missing.join(" "), /цвет|RAL/i);
    assert.equal(result.options.length, 3);
  });
}

test("does not invent a metal industry for an office order", () => {
  const draft = agentDraft({ sku: "КР-004", requestedKg: 200 });
  draft.businessContext = "";
  const result = normalizeAgentResult(draft, demoData, {
    company: "ГородПроект",
    subject: "Краска для офиса",
    body: "Нужно 200 кг белой краски для стен офиса после ремонта.",
  });

  assert.match(result.businessContext, /строительство/);
  assert.doesNotMatch(result.businessContext, /металлоконструк|корроз/i);
});

test("routes a requested price below the minimum to the red zone", () => {
  const result = normalizeAgentResult(agentDraft(), demoData, {
    company: "МеталлИнвест",
    subject: "Цена для металлоконструкций",
    body: "Нужно 200 кг грунт-эмали КР-001 для наружных работ, RAL 7024. Цена не выше 320 ₽/кг.",
  });

  assert.equal(result.zone, "red");
  assert.match(result.zoneReason, /ниже минимальной границы 332 ₽\/кг/);
  assert.equal(result.options.length, 3);
});

test("routes special commercial terms to the red zone", () => {
  const result = normalizeAgentResult(agentDraft(), demoData, {
    company: "Завод",
    subject: "Заказ с отсрочкой",
    body: "Нужно 200 кг грунт-эмали КР-001 для наружных работ, RAL 7024. Просим отсрочку 60 дней.",
  });

  assert.equal(result.zone, "red");
  assert.equal(result.decision, "escalate");
  assert.equal(result.options.length, 3);
});

test("routes special terms found only in client copy to the red zone", () => {
  const draft = agentDraft();
  draft.reply.body =
    "Подтверждаем заказ и предоставляем отсрочку оплаты на 60 дней.";

  const result = normalizeAgentResult(draft, demoData, {
    company: "Завод",
    subject: "Стандартный заказ КР-001",
    body: "Нужно 200 кг КР-001 для наружных работ, цвет RAL 7024.",
  });

  assert.equal(result.zone, "red");
  assert.equal(result.decision, "escalate");
  assert.equal(result.options.length, 3);
  assert.doesNotMatch(result.reply.body, /отсрочк/i);
});

test("keeps two unique safe manager options for a red order", () => {
  const options = [
    {
      id: "manager-split",
      title: "Разделить поставку",
      rationale: "Отгрузить доступную партию, остаток поставить по графику.",
      tradeoff: "Потребуются две отгрузки.",
      reply:
        "Предлагаем отгрузить 300 кг из наличия. График оставшихся 500 кг подтвердим после согласования.",
    },
    {
      id: "ask-schedule",
      title: "Уточнить допустимый график",
      rationale: "Согласовать объём первой партии и дату второй.",
      tradeoff: "Расчёт продолжится после ответа клиента.",
      reply:
        "Уточните минимальный объём первой партии и допустимую дату поставки остатка.",
    },
  ];

  const result = normalizeAgentResult(
    agentDraft({ sku: "КР-001", requestedKg: 800, options }),
    demoData,
    {
      company: "Завод",
      subject: "Заказ КР-001",
      body: "Нужно 800 кг КР-001 для металла снаружи, цвет RAL 7024.",
    },
  );

  assert.equal(result.zone, "red");
  assert.deepEqual(
    result.options.map((option) => option.id),
    ["manager-split", "ask-schedule"],
  );
});

test("replaces the whole red option set when ids are duplicated", () => {
  const options = ["same-id", "same-id", "third-id"].map((id, index) => ({
    id,
    title: `Безопасный вариант ${index + 1}`,
    rationale: "Передать руководителю выполнимый следующий ход.",
    tradeoff: "Условие требует согласования.",
    reply: "Проверяем условия и вернёмся с подтверждённым предложением.",
  }));

  const result = normalizeAgentResult(
    agentDraft({ sku: "КР-001", requestedKg: 800, options }),
    demoData,
    {
      company: "Завод",
      subject: "Заказ КР-001",
      body: "Нужно 800 кг КР-001 для металла снаружи, цвет RAL 7024.",
    },
  );

  assert.deepEqual(
    result.options.map((option) => option.id),
    ["split", "alternative", "contract"],
  );
});

test("replaces the whole red option set when an id is empty", () => {
  const options = ["", "other-id"].map((id, index) => ({
    id,
    title: `Безопасный вариант ${index + 1}`,
    rationale: "Передать руководителю выполнимый следующий ход.",
    tradeoff: "Условие требует согласования.",
    reply: "Проверяем условия и вернёмся с подтверждённым предложением.",
  }));

  const result = normalizeAgentResult(
    agentDraft({ sku: "КР-001", requestedKg: 800, options }),
    demoData,
    {
      company: "Завод",
      subject: "Заказ КР-001",
      body: "Нужно 800 кг КР-001 для металла снаружи, цвет RAL 7024.",
    },
  );

  assert.deepEqual(
    result.options.map((option) => option.id),
    ["split", "alternative", "contract"],
  );
});

test("replaces the whole red option set when the model returns more than three", () => {
  const options = Array.from({ length: 4 }, (_, index) => ({
    id: `option-${index + 1}`,
    title: `Безопасный вариант ${index + 1}`,
    rationale: "Передать руководителю выполнимый следующий ход.",
    tradeoff: "Условие требует согласования.",
    reply: "Проверяем условия и вернёмся с подтверждённым предложением.",
  }));

  const result = normalizeAgentResult(
    agentDraft({ sku: "КР-001", requestedKg: 800, options }),
    demoData,
    {
      company: "Завод",
      subject: "Заказ КР-001",
      body: "Нужно 800 кг КР-001 для металла снаружи, цвет RAL 7024.",
    },
  );

  assert.deepEqual(
    result.options.map((option) => option.id),
    ["split", "alternative", "contract"],
  );
});

test("replaces every model option after a promise of the unavailable full volume", () => {
  const options = [
    {
      id: "promise-full",
      title: "Пообещать полный объём",
      rationale: "Закрыть заказ одной отгрузкой.",
      tradeoff: "Нет.",
      reply:
        "В наличии полный объём — 800 кг продукта «Барьер 3в1».",
    },
    {
      id: "safe-check",
      title: "Проверить график",
      rationale: "Подтвердить срок внутри компании.",
      tradeoff: "Ответ потребует проверки.",
      reply: "Проверяем график и вернёмся с подтверждёнными условиями.",
    },
    {
      id: "safe-ask",
      title: "Уточнить приоритет",
      rationale: "Узнать допустимый график.",
      tradeoff: "Нужен ответ клиента.",
      reply: "Уточните допустимый график поставки.",
    },
  ];

  const result = normalizeAgentResult(
    agentDraft({ sku: "КР-001", requestedKg: 800, options }),
    demoData,
    {
      company: "Завод",
      subject: "Заказ КР-001",
      body: "Нужно 800 кг КР-001 для металла снаружи, цвет RAL 7024.",
    },
  );

  assert.deepEqual(
    result.options.map((option) => option.id),
    ["split", "alternative", "contract"],
  );
  assert.doesNotMatch(
    result.options.map((option) => option.reply).join(" "),
    /в наличии полный объём/i,
  );
});

test("replaces every model option after a quoted price below the catalog minimum", () => {
  const options = [
    {
      id: "below-minimum",
      title: "Предложить Металл Про",
      rationale: "Закрепить цену для клиента.",
      tradeoff: "Цена ниже действующей границы.",
      reply: "Подтверждаем цену 340 ₽/кг для аналога.",
    },
    {
      id: "safe-check",
      title: "Проверить экономику",
      rationale: "Передать условие руководителю.",
      tradeoff: "Ответ потребует проверки.",
      reply: "Проверяем коммерческие условия и вернёмся с предложением.",
    },
    {
      id: "safe-ask",
      title: "Уточнить приоритет",
      rationale: "Узнать целевое условие клиента.",
      tradeoff: "Нужен ответ клиента.",
      reply: "Уточните приоритет: цена, срок или график поставки.",
    },
  ];

  const result = normalizeAgentResult(
    agentDraft({ sku: "КР-001", requestedKg: 800, options }),
    demoData,
    {
      company: "Завод",
      subject: "Заказ КР-001",
      body: "Нужно 800 кг КР-001 для металла снаружи, цвет RAL 7024.",
    },
  );

  assert.deepEqual(
    result.options.map((option) => option.id),
    ["split", "alternative", "contract"],
  );
  assert.doesNotMatch(
    result.options.map((option) => option.reply).join(" "),
    /340 ₽\/кг/,
  );
});

test("replaces every model option after an unapproved analogue is offered", () => {
  const options = [
    {
      id: "wrong-analogue",
      title: "Предложить Аква Стена",
      rationale: "Закрыть объём продуктом из наличия.",
      tradeoff: "Потребуется замена продукта.",
      reply:
        "Можем предложить «Аква Стена» из наличия в полном объёме по цене 228 ₽/кг.",
    },
    {
      id: "safe-check",
      title: "Проверить аналог",
      rationale: "Передать подбор технологу.",
      tradeoff: "Ответ потребует проверки.",
      reply: "Проверяем допустимую замену и вернёмся с предложением.",
    },
    {
      id: "safe-ask",
      title: "Уточнить приоритет",
      rationale: "Узнать допустимость замены.",
      tradeoff: "Нужен ответ клиента.",
      reply: "Уточните, допустима ли замена после подтверждения технологом.",
    },
  ];

  const result = normalizeAgentResult(
    agentDraft({ sku: "КР-001", requestedKg: 800, options }),
    demoData,
    {
      company: "Завод",
      subject: "Заказ КР-001",
      body: "Нужно 800 кг КР-001 для металла снаружи, цвет RAL 7024.",
    },
  );

  assert.deepEqual(
    result.options.map((option) => option.id),
    ["split", "alternative", "contract"],
  );
  assert.doesNotMatch(
    result.options.map((option) => option.reply).join(" "),
    /Аква Стена/,
  );
});

test("rejects an analogue SKU that is not in the approved catalogue list", () => {
  const options = [
    {
      id: "unknown-analogue",
      title: "Предложить КР-999",
      rationale: "Заменить продукт неизвестным аналогом.",
      tradeoff: "Потребуется замена продукта.",
      reply: "Можем предложить КР-999 в полном объёме по цене 400 ₽/кг.",
    },
    {
      id: "safe-check",
      title: "Проверить условие",
      rationale: "Передать запрос руководителю.",
      tradeoff: "Ответ потребует проверки.",
      reply: "Проверяем коммерческие условия и вернёмся с предложением.",
    },
  ];

  const result = normalizeAgentResult(
    agentDraft({ sku: "КР-001", requestedKg: 200, options }),
    demoData,
    {
      company: "Завод",
      subject: "Заказ КР-001 с отсрочкой",
      body: "Нужно 200 кг КР-001 для металла снаружи, цвет RAL 7024. Просим отсрочку 60 дней.",
    },
  );

  assert.deepEqual(
    result.options.map((option) => option.id),
    ["standard", "volume", "clarify"],
  );
  assert.doesNotMatch(
    result.options.map((option) => option.reply).join(" "),
    /КР-999/,
  );
});

test("offers only an explicitly approved stocked analogue", () => {
  const result = normalizeAgentResult(
    agentDraft({ sku: "КР-001", requestedKg: 800 }),
    demoData,
    {
      company: "Завод",
      subject: "Грунт-эмаль для металла",
      body: "Нужно 800 кг покрытия КР-001 для металла снаружи, цвет RAL 7024.",
    },
  );
  const alternative = result.options.find((option) => option.id === "alternative");

  assert.equal(result.zone, "red");
  assert.ok(alternative);
  assert.match(alternative.title, /Металл Про/);
});

test("does not substitute wall paint for a floor coating", () => {
  const result = normalizeAgentResult(
    agentDraft({ sku: "КР-003", requestedKg: 800 }),
    demoData,
    {
      company: "Склад",
      subject: "Покрытие бетонного пола",
      body: "Нужно 800 кг покрытия КР-003 для бетонного пола внутри склада, цвет серый.",
    },
  );

  assert.equal(result.zone, "red");
  assert.equal(
    result.options.some((option) => option.id === "alternative"),
    false,
  );
  assert.doesNotMatch(
    result.options.map((option) => option.title).join(" "),
    /Аква Стена/,
  );
});

test("blocks a green reply after a negative model review", () => {
  const job = {
    company: "ГородПроект",
    subject: "Белая краска для офиса",
    body: "Нужно 200 кг продукта КР-004 для внутренних стен офиса, цвет белый.",
  };
  const normalized = normalizeAgentResult(
    agentDraft({ sku: "КР-004", requestedKg: 200 }),
    demoData,
    job,
  );
  const reviewed = applyReviewerResult(
    normalized,
    {
      approved: false,
      verdict: "Срок поставки требует подтверждения",
      notes: ["Нужно подтвердить дату отгрузки"],
      blockingIssues: ["В письме обещан неподтверждённый срок"],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );

  assert.equal(reviewed.zone, "red");
  assert.equal(reviewed.decision, "escalate");
  assert.equal(reviewed.options.length, 3);
  assert.match(reviewed.review.notes.join(" "), /Блокер/);
});

test("does not reuse client copy rejected by the reviewer", () => {
  const job = {
    company: "ГородПроект",
    subject: "Белая краска для офиса",
    body: "Нужно 200 кг продукта КР-004 для внутренних стен офиса, цвет белый.",
  };
  const draft = agentDraft({ sku: "КР-004", requestedKg: 200 });
  draft.missing = ["Гарантируем доставку завтра ровно к 10:00"];
  draft.reply.subject = "Гарантия поставки завтра к 10:00";
  draft.reply.body = "Гарантируем доставку завтра ровно к 10:00.";
  const normalized = normalizeAgentResult(draft, demoData, job);

  const reviewed = applyReviewerResult(
    normalized,
    {
      approved: false,
      verdict: "Обещание доставки заблокировано",
      notes: [],
      blockingIssues: ["Дата и время доставки не подтверждены"],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );

  assert.equal(reviewed.zone, "red");
  assert.doesNotMatch(
    [
      reviewed.reply.subject,
      ...reviewed.missing,
      ...reviewed.options.flatMap((option) => [
        option.title,
        option.rationale,
        option.tradeoff,
        option.reply,
      ]),
    ].join(" "),
    /гарантируем доставку завтра|10:00/i,
  );
});

test("removes unsupported business conclusions after a negative review", () => {
  const job = {
    company: "ВолгаМаш",
    website: "volgamash.ru",
    subject: "Заказ КР-001",
    body: "Нужно 800 кг КР-001 для металла снаружи, цвет RAL 7024.",
  };
  const draft = agentDraft({ sku: "КР-001", requestedKg: 800 });
  draft.understood = [
    "Объём: 800 кг",
    "Выручка клиента превышает 50 млрд рублей",
  ];
  draft.businessContext =
    "Доставка займёт один день, риск неплатежа низкий.";
  draft.managerNote =
    "Выручка клиента высокая, руководитель может принять риск.";
  draft.research = {
    checked: true,
    summary: "Риск неплатежа низкий, доставка займёт один день.",
    sources: [
      {
        title: "Карточка компании",
        url: "https://example.com/company",
        checkedAt: "2026-07-28",
        fact: "Компания обрабатывает металлические изделия.",
      },
    ],
  };
  const normalized = normalizeAgentResult(draft, demoData, job);

  const reviewed = applyReviewerResult(
    normalized,
    {
      approved: false,
      verdict: "Внешние выводы требуют проверки",
      notes: [],
      blockingIssues: ["Срок доставки и риск оплаты не подтверждены"],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );

  assert.doesNotMatch(
    `${reviewed.businessContext} ${reviewed.research.summary}`,
    /один день|риск неплатежа низкий/i,
  );
  assert.match(reviewed.businessContext, /исключил неподтверждённые выводы/i);
  assert.equal(reviewed.research.sources.length, 1);
  assert.equal(
    reviewed.research.sources[0].fact,
    "Источник найден. Руководитель проверяет сведения перед решением.",
  );
  assert.doesNotMatch(
    reviewed.research.sources[0].fact,
    /обрабатывает металлические изделия/i,
  );
  assert.doesNotMatch(reviewed.understood.join(" "), /выручк|50 млрд/i);
  assert.doesNotMatch(reviewed.managerNote, /выручк|принять риск/i);
  assert.match(reviewed.understood.join(" "), /Барьер 3в1.*КР-001/i);
  assert.match(reviewed.understood.join(" "), /800 кг/i);
});

test("keeps source company names when rebuilding understanding after review", () => {
  const job = {
    company: "VOLGA STEEL",
    subject: "Fwd: Заказ КР-001",
    body: "Нужно 800 кг КР-001 для металла снаружи, цвет RAL 7024.",
  };
  const reviewed = applyReviewerResult(
    normalizeAgentResult(
      agentDraft({ sku: "КР-001", requestedKg: 800 }),
      demoData,
      job,
    ),
    {
      approved: false,
      verdict: "Требуется решение руководителя",
      notes: [],
      blockingIssues: ["Условие требует подтверждения"],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );

  assert.match(reviewed.understood.join(" "), /VOLGA STEEL/);
  assert.match(reviewed.understood.join(" "), /Барьер 3в1.*КР-001/);
  assert.match(reviewed.understood.join(" "), /800 кг/);
});

test("keeps a deterministic SKU mismatch note after a negative review", () => {
  const job = {
    company: "МехПром",
    subject: "Заказ Металл Про",
    body: "Нужно 200 кг Металл Про для наружных металлоконструкций, цвет RAL 7024.",
  };
  const reviewed = applyReviewerResult(
    normalizeAgentResult(
      agentDraft({ sku: "КР-001", requestedKg: 200 }),
      demoData,
      job,
    ),
    {
      approved: false,
      verdict: "Артикул требует проверки",
      notes: [],
      blockingIssues: ["Модель выбрала другой продукт"],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );

  assert.match(
    reviewed.missing.join(" "),
    /модель указала КР-001.*письмо соответствует КР-002/i,
  );
});

test("mentions the catalogue when product is known and quantity is missing", () => {
  const job = {
    company: "ВолгаМаш",
    subject: "Заказ КР-001",
    body: "Нужен КР-001 для металла снаружи, цвет RAL 7024.",
  };
  const reviewed = applyReviewerResult(
    normalizeAgentResult(agentDraft({ sku: "КР-001" }), demoData, job),
    {
      approved: false,
      verdict: "Объём требует уточнения",
      notes: [],
      blockingIssues: ["Количество не указано"],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );

  assert.match(reviewed.understood.join(" "), /Барьер 3в1.*КР-001/i);
  assert.match(reviewed.businessContext, /письмо, каталог и остатки/i);
});

test("explains a completed public search with no confirmed sources", () => {
  const job = {
    company: "ГородПроект",
    subject: "Белая краска для офиса",
    body: "Нужно 200 кг продукта КР-004 для внутренних стен офиса, цвет белый.",
  };
  const draft = agentDraft({ sku: "КР-004", requestedKg: 200 });
  draft.research = {
    checked: true,
    summary: "Неподтверждённый вывод модели.",
    sources: [],
  };
  const reviewed = applyReviewerResult(
    normalizeAgentResult(draft, demoData, job),
    {
      approved: false,
      verdict: "Публичные сведения требуют подтверждения",
      notes: [],
      blockingIssues: ["Источник не найден"],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );

  assert.match(reviewed.research.summary, /поиск завершён/i);
  assert.match(reviewed.research.summary, /не нашёл/i);
  assert.doesNotMatch(
    `${reviewed.businessContext} ${reviewed.research.summary}`,
    /источники (?:ниже|дают)/i,
  );
});

test("logs final context after review without blocking result persistence", async () => {
  const source = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const reviewIndex = source.lastIndexOf("result = applyReviewerResult(");
  const contextIndex = source.indexOf('"research-result"');
  const resultIndex = source.indexOf('action: "result"');

  assert.ok(reviewIndex >= 0 && reviewIndex < contextIndex);
  assert.ok(contextIndex < resultIndex);
  assert.match(
    source.slice(contextIndex, resultIndex),
    /\.catch\(\(\) => \{\}\)/,
  );
});

test("rejects reviewer approval when blocking issues are not empty", () => {
  const job = {
    company: "ГородПроект",
    subject: "Белая краска для офиса",
    body: "Нужно 200 кг продукта КР-004 для внутренних стен офиса, цвет белый.",
  };
  const normalized = normalizeAgentResult(
    agentDraft({ sku: "КР-004", requestedKg: 200 }),
    demoData,
    job,
  );
  const reviewed = applyReviewerResult(
    normalized,
    {
      approved: true,
      verdict: "Черновик можно отправлять",
      notes: [],
      blockingIssues: ["В письме осталось неподтверждённое обещание"],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );

  assert.equal(reviewed.zone, "red");
  assert.equal(reviewed.decision, "escalate");
  assert.match(reviewed.review.notes.join(" "), /Блокер/);
});

test("requires reviewer approval to be the boolean true", () => {
  const job = {
    company: "ГородПроект",
    subject: "Белая краска для офиса",
    body: "Нужно 200 кг продукта КР-004 для внутренних стен офиса, цвет белый.",
  };
  const normalized = normalizeAgentResult(
    agentDraft({ sku: "КР-004", requestedKg: 200 }),
    demoData,
    job,
  );
  const reviewed = applyReviewerResult(
    normalized,
    {
      approved: "true",
      verdict: "Некорректный тип поля approved",
      notes: [],
      blockingIssues: [],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );

  assert.equal(reviewed.zone, "red");
  assert.equal(reviewed.decision, "escalate");
});

test("requires blockingIssues to be an explicit empty array", () => {
  const job = {
    company: "ГородПроект",
    subject: "Белая краска для офиса",
    body: "Нужно 200 кг продукта КР-004 для внутренних стен офиса, цвет белый.",
  };
  const normalized = normalizeAgentResult(
    agentDraft({ sku: "КР-004", requestedKg: 200 }),
    demoData,
    job,
  );
  const reviewed = applyReviewerResult(
    normalized,
    {
      approved: true,
      verdict: "Поле блокеров имеет неверный тип",
      notes: [],
      blockingIssues: "",
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );

  assert.equal(reviewed.zone, "red");
  assert.equal(reviewed.decision, "escalate");
});

test("keeps a negative review red when the product is still unknown", () => {
  const job = {
    company: "РегионСклад",
    subject: "Краска для нового цеха",
    body: "Нужна прочная краска для нового производственного помещения.",
  };
  const reviewed = applyReviewerResult(
    {
      ...agentDraft(),
      zone: "yellow",
      decision: "clarify",
      product: null,
      missing: ["назначение покрытия", "объём"],
      options: [],
      reply: {
        subject: "Уточнение по заказу",
        body: "Уточните назначение покрытия и объём.",
      },
    },
    {
      approved: false,
      verdict: "Вопрос требует проверки",
      notes: [],
      blockingIssues: ["Уточнение не снимает риск применения"],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );

  assert.equal(reviewed.zone, "red");
  assert.equal(reviewed.decision, "escalate");
  assert.equal(reviewed.options.length, 3);
});
