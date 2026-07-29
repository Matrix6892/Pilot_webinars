import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyReviewerResult,
  isCompleteAgentResult,
  normalizeAgentResult,
} from "../lib/agent-guard.mjs";

const demoData = JSON.parse(
  await readFile(new URL("../data/paint-demo.json", import.meta.url), "utf8"),
);

function catalogProduct(sku) {
  const product = demoData.products.find((item) => item.sku === sku);
  assert.ok(product, `В демонстрационном каталоге должен быть товар ${sku}`);
  return product;
}

function assertSafeManagerOptions(result, rejectedIds = []) {
  assert.equal(result.zone, "red");
  assert.equal(result.decision, "escalate");
  assert.equal(result.route, "manager");
  assert.equal(result.options.length, 3);
  assert.equal(
    new Set(result.options.map((option) => option.id)).size,
    result.options.length,
  );
  assert.ok(result.options.every((option) => option.id.trim()));
  for (const rejectedId of rejectedIds) {
    assert.equal(
      result.options.some((option) => option.id === rejectedId),
      false,
    );
  }
}

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
          id: "partial-delivery",
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
  assert.equal(result.product.name, catalogProduct("КР-001").name);
  assert.match(result.product.name, /краск.*металл.*ржавчин/iu);
  assert.equal(result.product.stockKg, 300);
  assert.equal(result.product.pricePerKg, 349);
  assert.equal(result.options.length, 3);
  assert.match(result.market.summary, /Цена «Колер»: 349 ₽\/кг/);
  assert.match(result.reply.body, /выберет руководитель/);
  assert.deepEqual(result.sources.slice(0, 3), [
    "Входящее письмо",
    "Каталог и остатки",
    "Правила продаж",
  ]);
  assert.equal(result.sources.length, 5);
  assert.match(
    result.sources.join(" "),
    /цен.*(?:поставщик|предлож)|рын/iu,
  );
  assert.match(result.sources.join(" "), /влияет на работу клиента/iu);
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
    /клиентск[а-яё]*\s+текст.*ясн[а-яё]*\s+русск[а-яё]*\s+шаблон/iu,
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
  assert.match(result.reply.body, /Подтверждаем наличие: 200 кг/);
  assert.equal("unexpected" in result, false);
});

test("turns an internal profit-floor phrase into customer-facing Russian", () => {
  const draft = agentDraft();
  draft.understood = [
    "Минимальная цена с прибылью: 278 ₽/кг",
  ];

  const result = normalizeAgentResult(draft, demoData, {
    company: "Учебный заказчик",
    subject: "Стандартный заказ КР-001",
    body: "Нужно 200 кг КР-001 для наружных работ, цвет RAL 7024.",
  });

  assert.match(
    result.understood.join(" "),
    /цена, от которой завод зарабатывает на заказе: 278 ₽\/кг/iu,
  );
  assert.doesNotMatch(result.understood.join(" "), /минимальн|с прибылью/iu);
});

test("keeps a complete green letter aligned with the customer's color and delivery", () => {
  const job = {
    company: "Посёлок «Сосны»",
    subject: "Краска для деревянных конструкций",
    body: "Добрый день! Нужны 100 кг коричневой краски для деревянных конструкций на улице. Доставка в Тверь через две недели. Просим подтвердить наличие и подготовить предложение.",
  };
  const draft = agentDraft({
    sku: "КР-005",
    requestedKg: 100,
  });
  draft.understood = [
    "Клиент — компания «Посёлок «Сосны»",
    "Доставка: Тверь, срок 14 дней",
    "Клиент просит доставку через две недели",
  ];
  draft.reply.body =
    "Подтвердили 100 кг краски. Подготовим отгрузку после подтверждения адреса.";

  const result = applyReviewerResult(
    normalizeAgentResult(draft, demoData, job),
    {
      approved: true,
      verdict: "Ответ можно отправить после уточнения формулировок",
      notes: ["Добавьте в письмо цвет и срок доставки."],
      blockingIssues: [],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );

  assert.match(result.understood.join(" "), /Клиент: Посёлок «Сосны»/u);
  assert.doesNotMatch(
    result.understood.join(" "),
    /компания «Посёлок «Сосны»/u,
  );
  assert.match(
    result.understood.join(" "),
    /Клиент просит доставку через две недели/u,
  );
  assert.match(result.reply.body, /цвет — коричневый/iu);
  assert.match(result.reply.body, /доставка в Тверь через две недели/iu);
  assert.match(result.reply.body, /точный адрес разгрузки/iu);
  assert.equal(result.review.verdict, "Ответ проверен и готов к отправке");
  assert.match(
    result.review.notes.join(" "),
    /нижней выгодной границы 278 ₽\/кг — заказ приносит прибыль/iu,
  );
  assert.match(
    result.review.notes.join(" "),
    /письмо повторяет цвет и условия поставки из заявки/iu,
  );
  assert.doesNotMatch(
    `${result.review.verdict} ${result.review.notes.join(" ")}`,
    /после уточнения|добавьте в письмо/iu,
  );
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
    /клиентск[а-яё]*\s+текст.*правил[а-яё]*\s+делов[а-яё]*\s+переписк/iu,
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

  assert.equal(result.zoneReason, "Краска, объём и цена подтверждены.");
});

test("does not mark a search as source-checked without an opened URL", () => {
  const draft = agentDraft();
  draft.research = {
    checked: true,
    summary: "Поиск завершён, подтверждённых публичных источников не найдено.",
    sources: [],
  };

  const result = normalizeAgentResult(draft, demoData, {
    company: "Завод",
    website: "zavod.example.ru",
    subject: "Стандартный заказ КР-001",
    body: "Нужно 200 кг КР-001 для наружных работ, цвет RAL 7024.",
  });

  assert.equal(result.research.checked, false);
  assert.deepEqual(result.research.sources, []);
  assert.match(result.research.summary, /поиск завершён/i);
  assert.match(
    result.research.summary,
    /решение опирается на письмо и внутренние данные/iu,
  );
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
    website: "zavod.example.ru",
    openedSourceUrls: ["https://example.com/company"],
    subject: "Стандартный заказ КР-001",
    body: "Нужно 200 кг КР-001 для наружных работ, цвет RAL 7024.",
  });

  assert.equal(result.research.checked, true);
  assert.equal(result.research.sources.length, 1);
  assert.equal(result.research.sources[0].checkedAt, "28 Jul 2026");
});

test("allows a cautious company-name match and labels it explicitly", () => {
  const draft = agentDraft();
  draft.research = {
    checked: true,
    summary: "Модель нашла компанию с похожим названием.",
    sources: [
      {
        title: "Компания с похожим названием",
        url: "https://example.com/company",
        checkedAt: "2026-07-29",
        fact: "Факт относится к другой организации.",
      },
    ],
  };

  const result = normalizeAgentResult(draft, demoData, {
    company: "Учебная компания",
    openedSourceUrls: ["https://example.com/company"],
    subject: "Стандартный заказ КР-001",
    body: "Нужно 200 кг КР-001 для наружных работ, цвет RAL 7024.",
  });

  assert.equal(result.research.checked, true);
  assert.equal(result.research.sources.length, 1);
  assert.match(result.research.summary, /совпадение по названию/iu);
  assert.match(
    result.research.sources[0].fact,
    /совпадение по названию/iu,
  );
});

test("keeps an unopened model link out of conclusions", () => {
  const draft = agentDraft();
  draft.businessContext = "Выручка клиента — 50 млрд рублей.";
  draft.zoneReason = "Крупный клиент получит особые условия.";
  draft.reply.body = "Для крупного клиента согласовали особые условия.";
  draft.research = {
    checked: true,
    summary: "Компания выпускает тысячу станков в год.",
    sources: [
      {
        title: "Карточка компании",
        url: "https://example.com/company",
        checkedAt: "2026-07-29",
        fact: "Выручка клиента — 50 млрд рублей.",
      },
    ],
  };
  draft.decisionBasis = [
    {
      fact: "Клиент крупный.",
      source: "Карточка компании",
      checkedAt: "2026-07-29",
    },
  ];

  const result = normalizeAgentResult(draft, demoData, {
    company: "Завод",
    website: "zavod.ru",
    subject: "Стандартный заказ КР-001",
    body: "Нужно 200 кг КР-001 для наружных работ, цвет RAL 7024.",
  });

  assert.equal(result.research.checked, false);
  assert.match(
    result.research.sources[0].fact,
    /решение опирается на письмо, каталог и склад/iu,
  );
  assert.doesNotMatch(
    `${result.businessContext} ${result.zoneReason} ${result.reply.body}`,
    /50 млрд|тысяч[ау] станков|крупн.*клиент|особые условия/iu,
  );
  assert.doesNotMatch(
    JSON.stringify(result.decisionBasis),
    /карточка компании|клиент крупный/iu,
  );
});

test("does not hide a dropped source behind one opened URL", () => {
  const draft = agentDraft();
  draft.businessContext = "Компания открывает пять новых заводов.";
  draft.research = {
    checked: true,
    summary: "Компания открывает пять новых заводов.",
    sources: [
      {
        title: "Открытая карточка",
        url: "https://example.com/company",
        checkedAt: "2026-07-29",
        fact: "Компания выпускает оборудование.",
      },
      {
        title: "Неподходящая ссылка",
        url: "javascript:alert(1)",
        checkedAt: "2026-07-29",
        fact: "Компания открывает пять новых заводов.",
      },
    ],
  };

  const result = normalizeAgentResult(draft, demoData, {
    company: "Завод",
    website: "zavod.ru",
    openedSourceUrls: ["https://example.com/company"],
    subject: "Стандартный заказ КР-001",
    body: "Нужно 200 кг КР-001 для наружных работ, цвет RAL 7024.",
  });

  assert.equal(result.research.checked, false);
  assert.doesNotMatch(result.businessContext, /пять новых заводов/iu);
  assert.doesNotMatch(result.reply.body, /пять новых заводов/iu);
});

test("clips a long research summary at a word boundary", () => {
  const draft = agentDraft();
  draft.research = {
    checked: true,
    summary: `${"Подтверждённый факт. ".repeat(40)}НезавершённоеСлово`,
    sources: [
      {
        title: "Карточка компании",
        url: "https://example.com/company",
        checkedAt: "2026-07-29",
        fact: "Компания выпускает оборудование.",
      },
    ],
  };

  const result = normalizeAgentResult(draft, demoData, {
    company: "Завод",
    website: "zavod.example.ru",
    openedSourceUrls: ["https://example.com/company"],
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

test("keeps a fence photo request human and asks only for useful details", () => {
  const draft = agentDraft({ zone: "yellow" });
  draft.decision = "clarify";
  draft.product = null;
  draft.understood = [
    "Клиент хочет покрасить забор",
    "К письму приложена фотография",
  ];
  draft.missing = [
    "материал забора",
    "длина и высота забора",
    "стороны покраски",
    "цвет забора",
  ];
  draft.reply = {
    subject: "Уточнение по покраске забора",
    body: [
      "Добрый день!",
      "Из чего сделан забор?",
      "Какие у него длина и средняя высота?",
      "Красим одну или обе стороны?",
      "Какой цвет нужен?",
    ].join("\n"),
  };

  const result = normalizeAgentResult(draft, demoData, {
    company: "Сад у озера",
    subject: "Хочу покрасить забор",
    body: "Добрый день! Хочу покрасить забор. Прикладываю фото.",
    attachment: {
      name: "забор.jpg",
      src: "/fence-demo.jpg",
      alt: "Забор на даче",
    },
  });
  const questions = `${result.missing.join(" ")} ${result.reply.body}`;

  assert.equal(result.zone, "yellow");
  assert.equal(result.decision, "clarify");
  assert.equal(result.route, "needs_info");
  assert.equal(result.product, null);
  assert.match(questions, /материал|из чего сделан/iu);
  assert.match(questions, /длин[а-яё]*.*высот/isu);
  assert.match(questions, /(?:одн|обе)[а-яё]*\s+сторон/iu);
  assert.match(questions, /цвет/iu);
  assert.doesNotMatch(questions, /приложите\s+(?:фото|фотограф|снимок)/iu);
  assert.doesNotMatch(
    questions,
    /килограмм|(?:^|[^\p{L}])кг(?:[^\p{L}]|$)|объ[её]м|услови[а-яё]*\s+эксплуатац|улиц|помещ/iu,
  );
});

test("turns a mistaken red fence draft into exact yellow questions", () => {
  const job = {
    company: "Дачный посёлок",
    subject: "Краска для забора",
    body: "Забор примерно 120 метров, высота 2 метра. Фото прилагаю. Помогите выбрать краску.",
  };
  const reviewed = applyReviewerResult(
    agentDraft({ zone: "red" }),
    {
      approved: false,
      verdict: "Нужно уточнить задачу",
      notes: [],
      blockingIssues: ["Для подбора краски нужны сведения клиента"],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );

  assert.equal(reviewed.zone, "yellow");
  assert.equal(reviewed.decision, "clarify");
  assert.equal(reviewed.route, "needs_info");
  assert.deepEqual(reviewed.missing, [
    "материал забора",
    "стороны покраски",
    "желаемый цвет",
    "приложите фотографию",
  ]);
  assert.match(reviewed.reply.body, /из чего сделан забор/iu);
  assert.match(reviewed.reply.body, /одну сторону забора или обе/iu);
  assert.match(reviewed.reply.body, /какой цвет/iu);
  assert.match(
    reviewed.reply.body,
    /приложите фотографию, которую упомянули в письме/iu,
  );
  assert.doesNotMatch(reviewed.reply.body, /длин[а-яё]*.*высот/isu);
});

test("grounds a clarified fence in the wood paint and whole packages", () => {
  const draft = agentDraft({
    sku: "КР-005",
    requestedKg: 30,
    zone: "green",
  });
  draft.understood = [
    "Забор деревянный",
    "Размер: 25 × 1,8 м",
    "Покраска с обеих сторон",
    "Цвет: коричневый",
  ];
  draft.missing = [];
  draft.calculation = {
    kind: "fence-area",
    material: "дерево",
    lengthM: 25,
    heightM: 1.8,
    areaPerSideM2: 45,
    sides: 2,
    paintAreaM2: 90,
    coverageKgPerM2PerCoat: 0.14,
    coats: 2,
    reservePercent: 10,
    estimatedKg: 27.72,
    packageKg: 10,
    packages: 3,
    roundedKg: 30,
    explanation:
      "Площадь покраски 90 м². Два слоя и запас 10% дают 27,72 кг. Берём 3 упаковки по 10 кг.",
  };
  draft.zoneReason =
    "Краска подобрана, расход рассчитан целыми упаковками, склад подтверждает весь объём.";
  draft.reply = {
    subject: "Расчёт краски для забора",
    body: "Подобрали краску для дерева: 3 упаковки по 10 кг, всего 30 кг.",
  };

  const result = normalizeAgentResult(draft, demoData, {
    company: "Сад у озера",
    subject: "Хочу покрасить забор",
    body: "Добрый день! Хочу покрасить забор. Прикладываю фото.",
    attachment: {
      name: "забор.jpg",
      src: "/fence-demo.jpg",
      alt: "Забор на даче",
    },
    conversation: [
      {
        role: "customer",
        body: "Деревянный, 25 × 1,8 м, обе стороны, коричневый.",
      },
    ],
  });

  assert.equal(result.zone, "green");
  assert.equal(result.route, "ready");
  assert.equal(result.missing.length, 0);
  assert.equal(result.product?.sku, "КР-005");
  assert.equal(result.product?.name, catalogProduct("КР-005").name);
  assert.equal(result.product?.requestedKg, 30);
  assert.deepEqual(
    {
      material: result.calculation?.material,
      areaPerSideM2: result.calculation?.areaPerSideM2,
      sides: result.calculation?.sides,
      paintAreaM2: result.calculation?.paintAreaM2,
      packageKg: result.calculation?.packageKg,
      packages: result.calculation?.packages,
      roundedKg: result.calculation?.roundedKg,
    },
    {
      material: "дерево",
      areaPerSideM2: 45,
      sides: 2,
      paintAreaM2: 90,
      packageKg: 10,
      packages: 3,
      roundedKg: 30,
    },
  );
  assert.ok(
    Math.abs((result.calculation?.estimatedKg ?? 0) - 27.72) < 1e-9,
  );
  assert.match(result.calculation?.explanation ?? "", /3 упаковки по 10 кг/iu);
});

test("grounds wall and floor area calculations without asking for kilograms", () => {
  const cases = [
    {
      sku: "КР-004",
      subject: "Краска для стен",
      body: "Красим 120 м² стен по штукатурке в помещении, цвет белый.",
      kind: "wall-area",
      material: "штукатурка",
      roundedKg: 42,
      packages: 3,
    },
    {
      sku: "КР-003",
      subject: "Краска для пола",
      body: "Красим 80 м² бетонного пола в помещении, цвет серый.",
      kind: "floor-area",
      material: "бетон",
      roundedKg: 80,
      packages: 4,
    },
  ];

  for (const item of cases) {
    const draft = agentDraft({ sku: item.sku, requestedKg: 1 });
    draft.calculation = {
      kind: item.kind,
      material: item.material,
      areaPerSideM2: 1,
      sides: 1,
      paintAreaM2: 1,
      coverageKgPerM2PerCoat: 99,
      coats: 9,
      reservePercent: 90,
      estimatedKg: 1,
      packageKg: 1,
      packages: 1,
      roundedKg: 1,
      explanation: "Недостоверный расчёт модели.",
    };

    const job = {
      company: "Учебный объект",
      subject: item.subject,
      body: item.body,
    };
    const result = applyReviewerResult(
      normalizeAgentResult(draft, demoData, job),
      {
        approved: true,
        verdict: "Факты и расчёт подтверждены",
        notes: [],
        blockingIssues: [],
      },
      "opencode/gpt-5.6-sol",
      demoData,
      job,
    );

    assert.equal(result.zone, "green");
    assert.equal(result.route, "ready");
    assert.deepEqual(result.missing, []);
    assert.equal(result.product?.sku, item.sku);
    assert.equal(result.product?.requestedKg, item.roundedKg);
    assert.equal(result.calculation?.kind, item.kind);
    assert.equal(result.calculation?.material, item.material);
    assert.equal(result.calculation?.roundedKg, item.roundedKg);
    assert.equal(result.calculation?.packages, item.packages);
    assert.equal(isCompleteAgentResult(result), true);
  }
});

test("rejects a wall calculation when the client did not provide an area", () => {
  const draft = agentDraft({ sku: "КР-004", requestedKg: 42 });
  draft.calculation = {
    kind: "wall-area",
    material: "штукатурка",
    areaPerSideM2: 120,
    sides: 1,
    paintAreaM2: 120,
    coverageKgPerM2PerCoat: 0.15,
    coats: 2,
    reservePercent: 10,
    estimatedKg: 39.6,
    packageKg: 14,
    packages: 3,
    roundedKg: 42,
    explanation: "Расчёт модели без площади в письме.",
  };

  const result = normalizeAgentResult(draft, demoData, {
    company: "Учебный объект",
    subject: "Краска для стен",
    body: "Красим стены по штукатурке в помещении, цвет белый.",
  });

  assert.equal(result.zone, "yellow");
  assert.equal(result.route, "needs_info");
  assert.equal(result.calculation, undefined);
  assert.match(result.missing.join(" "), /площадь стен/iu);
});

test("records a fence photo only when the live order contains an attachment", () => {
  const job = {
    company: "Сад у озера",
    subject: "Хочу покрасить забор",
    body: "Хочу покрасить забор. Прикладываю фото.",
  };
  const normalized = normalizeAgentResult(
    {
      ...agentDraft({ zone: "yellow" }),
      product: null,
      missing: ["материал забора", "длина и высота забора"],
      options: [],
    },
    demoData,
    job,
  );
  const reviewed = applyReviewerResult(
    normalized,
    {
      approved: false,
      verdict: "Нужны данные клиента",
      notes: [],
      blockingIssues: ["Материал и размеры подтвердит клиент"],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );

  assert.doesNotMatch(reviewed.understood.join(" "), /фотограф/i);

  const withAttachment = applyReviewerResult(
    normalized,
    {
      approved: false,
      verdict: "Нужны данные клиента",
      notes: [],
      blockingIssues: ["Материал и размеры подтвердит клиент"],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    {
      ...job,
      attachmentJson: JSON.stringify({
        name: "забор.jpg",
        src: "/api/uploads?key=customer-images/demo.jpg",
        alt: "Фотография забора",
      }),
    },
  );

  assert.match(withAttachment.understood.join(" "), /фотограф/i);
});

test("stops a quote when the model SKU disagrees with the product named in the letter", () => {
  const requestedProduct = catalogProduct("КР-002");
  const draft = agentDraft({ sku: "КР-001", requestedKg: 200 });
  draft.reply.body = `Подтверждаем 200 кг продукта «${catalogProduct("КР-001").name}» по цене 349 ₽/кг.`;

  const result = normalizeAgentResult(draft, demoData, {
    company: "МехПром",
    subject: `Заказ ${requestedProduct.sku}: ${requestedProduct.name}`,
    body: `Нужно 200 кг ${requestedProduct.sku} для техники на улице, цвет RAL 7024.`,
  });

  assert.equal(result.zone, "yellow");
  assert.equal(result.decision, "clarify");
  assert.equal(result.product?.sku, "КР-002");
  assert.match(
    result.missing.join(" "),
    /(?=.*модел[^.]*КР-001)(?=.*письм[^.]*КР-002)/isu,
  );
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
  assert.match(result.missing.join(" "), /улиц|помещ/i);
  assert.match(result.missing.join(" "), /цвет|RAL/i);
  assert.match(result.missing.join(" "), /пользоваться окрашенной поверхностью/i);
  assert.doesNotMatch(
    result.reply.body,
    /подтверждаем|349 ₽\/кг|совместимость покрытия/i,
  );
  assert.match(
    result.reply.body,
    /можно описать его словами или указать номер из каталога цветов RAL/iu,
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
  assert.match(result.missing.join(" "), /улиц|помещ/i);
  assert.match(result.missing.join(" "), /цвет|RAL/i);
  assert.match(result.zoneReason, /(?=.*(?:склад|налич|остат))(?=.*300)(?=.*800)/isu);
  assert.equal(result.options.length, 3);
});

for (const [risk, condition] of [
  ["a price below the minimum", "Цена не выше 320 ₽/кг."],
  ["a requested discount", "Просим скидку 10%."],
  ["special terms", "Просим отсрочку 60 дней."],
  [
    "everyday post-delivery payment terms",
    "Просим оплату через 90 дней после поставки.",
  ],
]) {
  test(`keeps ${risk} red when color and environment are missing`, () => {
    const result = normalizeAgentResult(agentDraft(), demoData, {
      company: "Завод",
      subject: "Заказ КР-001",
      body: `Нужно 200 кг КР-001. ${condition}`,
    });

    assert.equal(result.zone, "red");
    assert.equal(result.decision, "escalate");
    assert.match(result.missing.join(" "), /улиц|помещ/i);
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

  assert.match(result.businessContext, /налич|логистик|объект/iu);
  assert.doesNotMatch(result.businessContext, /металлоконструк|корроз/i);
});

test("routes a requested price below the minimum to the red zone", () => {
  const result = normalizeAgentResult(agentDraft(), demoData, {
    company: "МеталлИнвест",
    subject: "Цена для металлоконструкций",
    body: "Нужно 200 кг грунт-эмали КР-001 для наружных работ, RAL 7024. Цена не выше 320 ₽/кг.",
  });

  assert.equal(result.zone, "red");
  assert.equal(result.route, "manager");
  assert.match(
    result.zoneReason,
    /(?=.*особ[а-яё]*\s+цен)(?=.*руководител)(?=.*(?:экономик|прибыл|заработ))/isu,
  );
  assert.doesNotMatch(result.zoneReason, /наруш|ниже минимальн/iu);
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
      id: "two-part-delivery",
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
    ["two-part-delivery", "ask-schedule"],
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

  assertSafeManagerOptions(result, ["same-id", "third-id"]);
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

  assertSafeManagerOptions(result, ["other-id"]);
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

  assertSafeManagerOptions(
    result,
    options.map((option) => option.id),
  );
});

test("replaces every model option after a promise of the unavailable full volume", () => {
  const options = [
    {
      id: "promise-full",
      title: "Пообещать полный объём",
      rationale: "Закрыть заказ одной отгрузкой.",
      tradeoff: "Нет.",
      reply: `В наличии полный объём — 800 кг продукта «${catalogProduct("КР-001").name}».`,
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

  assertSafeManagerOptions(result, ["promise-full", "safe-check", "safe-ask"]);
  assert.doesNotMatch(
    result.options.map((option) => option.reply).join(" "),
    /в наличии полный объём/i,
  );
});

test("replaces every model option after a quoted price below the catalog minimum", () => {
  const approvedAnalogue = catalogProduct("КР-002");
  const options = [
    {
      id: "below-minimum",
      title: `Предложить ${approvedAnalogue.name}`,
      rationale: "Закрепить цену для клиента.",
      tradeoff: "Особую цену выбирает руководитель.",
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

  assertSafeManagerOptions(result, ["below-minimum", "safe-check", "safe-ask"]);
  assert.doesNotMatch(
    result.options.map((option) => option.reply).join(" "),
    /340 ₽\/кг/,
  );
});

test("replaces every model option after an unapproved analogue is offered", () => {
  const unapprovedProduct = catalogProduct("КР-004");
  const options = [
    {
      id: "wrong-analogue",
      title: `Предложить ${unapprovedProduct.name}`,
      rationale: "Закрыть объём продуктом из наличия.",
      tradeoff: "Потребуется замена продукта.",
      reply: `Можем предложить «${unapprovedProduct.name}» из наличия в полном объёме по цене 228 ₽/кг.`,
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

  assertSafeManagerOptions(result, [
    "wrong-analogue",
    "safe-check",
    "safe-ask",
  ]);
  assert.equal(
    result.options.some((option) =>
      `${option.title} ${option.reply}`.includes(unapprovedProduct.name),
    ),
    false,
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
  const product = catalogProduct("КР-001");
  const approvedAnalogue = catalogProduct(product.analogues[0]);
  const result = normalizeAgentResult(
    agentDraft({ sku: "КР-001", requestedKg: 800 }),
    demoData,
    {
      company: "Завод",
      subject: "Грунт-эмаль для металла",
      body: "Нужно 800 кг покрытия КР-001 для металла снаружи, цвет RAL 7024.",
    },
  );
  const alternative = result.options.find((option) =>
    option.title.includes(approvedAnalogue.name),
  );

  assert.equal(result.zone, "red");
  assert.ok(alternative);
  assert.match(
    alternative.reply,
    /Специалист подтвердит, что краска подходит/iu,
  );
  assert.equal(product.analogues.includes(approvedAnalogue.sku), true);
});

test("does not substitute wall paint for a floor coating", () => {
  const wallPaint = catalogProduct("КР-004");
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
    result.options.some((option) =>
      `${option.title} ${option.reply}`.includes(wallPaint.name),
    ),
    false,
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
  assert.match(
    reviewed.review.notes.join(" "),
    /обещан[^.]*неподтвержд[её]нн[^.]*срок/iu,
  );
  assert.doesNotMatch(reviewed.reply.body, /подтвердили\s+200\s*кг/iu);
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
  assert.match(
    reviewed.businessContext,
    /(?=.*письм)(?=.*каталог)(?=.*склад)(?=.*ссылк)(?=.*решени)/isu,
  );
  assert.equal(reviewed.research.checked, false);
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
  assert.doesNotMatch(
    `${reviewed.zoneReason} ${reviewed.managerNote}`,
    /проверенн[а-яё]*\s+факт/iu,
  );
  assert.match(
    reviewed.zoneReason,
    /письм.*каталог.*склад.*подтвержд/iu,
  );
  assert.doesNotMatch(
    JSON.stringify(reviewed.decisionBasis),
    /обрабатывает металлические изделия|50 млрд|риск неплатежа/iu,
  );
  assert.ok(
    reviewed.understood
      .join(" ")
      .includes(catalogProduct("КР-001").name),
  );
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
  assert.ok(
    reviewed.understood
      .join(" ")
      .includes(catalogProduct("КР-001").name),
  );
  assert.match(reviewed.understood.join(" "), /800 кг/);
});

test("keeps a deterministic SKU mismatch note after a negative review", () => {
  const requestedProduct = catalogProduct("КР-002");
  const job = {
    company: "МехПром",
    subject: `Заказ ${requestedProduct.sku}: ${requestedProduct.name}`,
    body: `Нужно 200 кг ${requestedProduct.sku} для техники на улице, цвет RAL 7024.`,
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

  assert.ok(
    reviewed.understood
      .join(" ")
      .includes(catalogProduct("КР-001").name),
  );
  assert.match(reviewed.businessContext, /письм.*каталог.*(?:склад|остат)/iu);
});

test("explains a completed public search with no confirmed sources", () => {
  const job = {
    company: "ГородПроект",
    website: "gorodproekt.example.ru",
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
  assert.match(reviewed.research.summary, /письм.*внутренн[^.]*данн/iu);
  assert.doesNotMatch(reviewed.research.summary, /не\s+наш[её]л/iu);
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

test("passes the saved stock revision and timestamp into the live OpenCode catalog", async () => {
  const source = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function demoDataForJob(");
  const end = source.indexOf("function storedJobJson(", start);
  const snapshotAdapter = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(
    snapshotAdapter,
    /stockRevision\s*:[^,\n]{0,120}(?:stockRevision|revision)/,
  );
  assert.match(
    snapshotAdapter,
    /stockUpdatedAt\s*:[^,\n]{0,120}(?:stockUpdatedAt|updatedAt)/,
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
  assert.match(
    reviewed.review.notes.join(" "),
    /неподтвержд[её]нн[^.]*обещан/iu,
  );
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

test("keeps a safe clarification yellow after a negative review", () => {
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

  assert.equal(reviewed.zone, "yellow");
  assert.equal(reviewed.decision, "clarify");
  assert.equal(reviewed.route, "needs_info");
  assert.equal(reviewed.options.length, 0);
  assert.match(reviewed.reply.body, /уточните/iu);
});

for (const [boundary, job] of [
  [
    "a stock shortage",
    {
      company: "Завод",
      subject: "Заказ КР-001",
      body: "Нужно 800 кг КР-001.",
    },
  ],
  [
    "special terms",
    {
      company: "Завод",
      subject: "Заказ с отсрочкой",
      body: "Нужно 200 кг КР-001. Просим отсрочку 60 дней.",
    },
  ],
  [
    "a client price below the profitable price",
    {
      company: "Завод",
      subject: "Цена заказа",
      body: "Нужно 200 кг КР-001 по 320 ₽/кг.",
    },
  ],
  [
    "an unknown explicit product code",
    {
      company: "Завод",
      subject: "Заказ КР-099",
      body: "Нужно 200 кг КР-099.",
    },
  ],
]) {
  test(`keeps ${boundary} with the manager after a negative review`, () => {
    const reviewed = applyReviewerResult(
      agentDraft({ zone: "red" }),
      {
        approved: false,
        verdict: "Руководитель выбирает следующий шаг",
        notes: [],
        blockingIssues: ["Условие требует решения"],
      },
      "opencode/gpt-5.6-sol",
      demoData,
      job,
    );

    assert.equal(reviewed.zone, "red");
    assert.equal(reviewed.decision, "escalate");
    assert.equal(reviewed.route, "manager");
  });
}

test("accepts complete grounded live results on all three routes", () => {
  const greenJob = {
    company: "ГородПроект",
    subject: "Белая краска для офиса",
    body: "Нужно 200 кг продукта КР-004 для внутренних стен офиса, цвет белый.",
  };
  const review = {
    approved: true,
    verdict: "Факты и полномочия подтверждены",
    notes: [],
    blockingIssues: [],
  };
  const green = applyReviewerResult(
    normalizeAgentResult(
      agentDraft({ sku: "КР-004", requestedKg: 200 }),
      demoData,
      greenJob,
    ),
    review,
    "opencode/gpt-5.6-sol",
    demoData,
    greenJob,
  );
  const yellowJob = {
    company: "Дачный посёлок",
    subject: "Хочу покрасить забор",
    body: "Помогите выбрать краску и рассчитать количество.",
  };
  const yellow = applyReviewerResult(
    normalizeAgentResult(agentDraft(), demoData, yellowJob),
    review,
    "opencode/gpt-5.6-sol",
    demoData,
    yellowJob,
  );
  const redJob = {
    company: "МеталлСтрой",
    subject: "Крупная партия для ограждений",
    body: "Нужны 800 кг КР-001 для металлических ограждений на улице, цвет RAL 7024.",
  };
  const red = applyReviewerResult(
    normalizeAgentResult(
      agentDraft({ sku: "КР-001", requestedKg: 800 }),
      demoData,
      redJob,
    ),
    review,
    "opencode/gpt-5.6-sol",
    demoData,
    redJob,
  );

  assert.equal(green.route, "ready");
  assert.equal(yellow.route, "needs_info");
  assert.equal(red.route, "manager");
  assert.equal(isCompleteAgentResult(green), true);
  assert.equal(isCompleteAgentResult(yellow), true);
  assert.equal(isCompleteAgentResult(red), true);
});

test("rejects a contradictory or partial live result", () => {
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
      verdict: "Факты и полномочия подтверждены",
      notes: [],
      blockingIssues: [],
    },
    "opencode/gpt-5.6-sol",
    demoData,
    job,
  );
  const contradictory = structuredClone(reviewed);
  contradictory.route = "manager";
  const partial = structuredClone(reviewed);
  partial.market.items = [{ competitor: "Поставщик" }];

  assert.equal(isCompleteAgentResult(contradictory), false);
  assert.equal(isCompleteAgentResult(partial), false);
});
