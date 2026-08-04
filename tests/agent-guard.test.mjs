import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  applyReviewerResult,
  ambiguityReply,
  askCoverageGaps,
  compoundReplyCoverageGaps,
  isCompleteAgentResult,
  normalizeAgentResult,
  normalizeV2AgentResult,
  reviewerAllowedPathPrefixes,
  validateReviewerDecisionV2,
} from "../lib/agent-guard.mjs";

const demoData = JSON.parse(
  await readFile(new URL("../data/paint-demo.json", import.meta.url), "utf8"),
);
const researchedDemoData = {
  ...demoData,
  companyProfiles: [
    {
      name: "Исследованный склад",
      website: "research.example.com",
      summary:
        "Открытые источники подтверждают фармацевтическую и медицинскую деятельность компании.",
      sources: [
        {
          title: "Отраслевой профиль компании",
          url: "https://research.example.com/industry",
          checkedAt: "30.07.2026",
          fact: "Компания работает в фармацевтической и медицинской отраслях.",
        },
        {
          title: "Описание складского комплекса",
          url: "https://research.example.com/warehouse",
          checkedAt: "30.07.2026",
          fact: "Компания использует складской комплекс с разными зонами хранения.",
        },
      ],
    },
  ],
};

test("canonical pure ambiguity has an empty reviewer issue map for every alias", () => {
  const shortagePacket = {
    order: { body: "Нужна партия покрытия." },
    result: {
      options: [
        { id: "supplier", reply: "Проверить поставщика." },
        { id: "split", reply: "Разделить поставку." },
        { id: "wait", reply: "Подождать подтверждение." },
      ],
      reply: { body: "Руководитель подтвердит совместную поставку." },
      managerNote: "Выберите следующий шаг.",
      product: { sku: "КР-001" },
    },
  };
  const map = reviewerAllowedPathPrefixes(shortagePacket);

  assert.deepEqual(map.material_utility, [
    "/result/options/0/reply",
    "/result/options/1/reply",
    "/result/options/2/reply",
  ]);
  assert.equal(map.material_utility.includes("/result/reply"), false);
  assert.equal(map.material_utility.includes("/result/managerNote"), false);
  assert.deepEqual(map.unsupported_claim, [
    "/order",
    "/result/product",
    "/result/reply",
    "/result/options",
  ]);

  const question = "Что красим: стена, рамка или человек?";
  const choices = ["Стена", "Прямоугольная рамка", "Задняя часть головы с тёмными волосами"];
  const ambiguousPacket = {
    order: {
      subject: "Фото объекта",
      body: "Ну давай, умный агент, покрась это красиво. Фото приложил.",
      roundNo: 1,
    },
    result: {
      schemaVersion: 2,
      zone: "yellow",
      route: "needs_info",
      commitment: "none",
      resolvedIntent: {
        goal: "Покрасить объект на фото",
        target: {
          state: "ambiguous",
          candidates: [
            { label: choices[0] },
            { label: choices[1] },
            { label: choices[2] },
          ],
        },
        evidence: [
          {
            id: "message-1",
            claim: "Клиент не назвал объект действия",
          },
          {
            id: "vision-1",
            claim: "На фото видны стена, рамка и человек сзади",
          },
        ],
        blocker: { kind: "target_ambiguity", question, choices },
      },
      visionObservation: {
        targetCandidates: [
          { label: choices[0], evidence: "Основная светлая поверхность" },
          { label: choices[1], evidence: "Серый прямоугольный объект" },
          { label: choices[2], evidence: "Нейтральный видимый признак человека" },
        ],
        visibleFacts: ["На фото видны три возможных объекта."],
      },
      understood: ["Выбор цели ещё не сделан."],
      missing: [question],
      product: null,
      estimates: [],
      supplierLeads: [],
      options: [],
      reply: {
        body: ambiguityReply(question, choices).body,
      },
    },
  };
  const ambiguousMap = reviewerAllowedPathPrefixes(ambiguousPacket);
  assert.deepEqual(
    Object.fromEntries(Object.keys(ambiguousMap).map((rule) => [rule, []])),
    ambiguousMap,
  );

  const aliases = [
    ["/order/body", ambiguousPacket.order.body],
    [
      "/result/visionObservation/targetCandidates/2/label",
      choices[2],
    ],
    [
      "/result/resolvedIntent/evidence/1/claim",
      ambiguousPacket.result.resolvedIntent.evidence[1].claim,
    ],
    ["/result/resolvedIntent/target/candidates/2/label", choices[2]],
    ["/result/missing/0", question],
    ["/result/understood/0", ambiguousPacket.result.understood[0]],
    ["/result/reply/body", ambiguousPacket.result.reply.body],
  ];
  for (const rule of Object.keys(ambiguousMap)) {
    for (const [path, quote] of aliases) {
      assert.equal(
        validateReviewerDecisionV2(
          {
            schemaVersion: 2,
            approved: false,
            verdict: "reject",
            notes: [],
            blockingIssues: [{
              rule,
              path,
              quote,
              detail: "Нейтральный кандидат якобы является рекомендацией материала.",
            }],
          },
          ambiguousPacket,
        ),
        null,
        `${rule}:${path}`,
      );
    }
  }
  assert.deepEqual(
    validateReviewerDecisionV2(
      {
        schemaVersion: 2,
        approved: true,
        verdict: "Проверка завершена",
        notes: [],
        blockingIssues: [],
      },
      ambiguousPacket,
    ),
    {
      schemaVersion: 2,
      approved: true,
      verdict: "Проверка завершена",
      notes: [],
      blockingIssues: [],
    },
  );

  const nonCanonicalReplyPacket = {
    ...ambiguousPacket,
    result: {
      ...ambiguousPacket.result,
      reply: { body: "Черновик содержит неподтверждённый факт?" },
    },
  };
  assert.equal(
    validateReviewerDecisionV2(
      {
        schemaVersion: 2,
        approved: false,
        verdict: "reject",
        notes: [],
        blockingIssues: [{
          rule: "unsupported_claim",
          path: "/result/reply/body",
          quote: nonCanonicalReplyPacket.result.reply.body,
          detail: "В reply есть неподтверждённое утверждение.",
        }],
      },
      nonCanonicalReplyPacket,
    )?.blockingIssues.length,
    1,
  );
  assert.equal(
    validateReviewerDecisionV2(
      {
        schemaVersion: 2,
        approved: false,
        verdict: "reject",
        notes: [],
        blockingIssues: [{
          rule: "privacy",
          path: "/result/visionObservation/targetCandidates/2/label",
          quote: choices[2],
          detail: "Grounded privacy inference подтверждён наблюдением.",
        }],
      },
      nonCanonicalReplyPacket,
    )?.blockingIssues.length,
    1,
  );
  assert.equal(
    validateReviewerDecisionV2(
      {
        schemaVersion: 2,
        approved: false,
        verdict: "reject",
        notes: [],
        blockingIssues: [{
          rule: "evidence_integrity",
          path: "/result/resolvedIntent/evidence/1/claim",
          quote: ambiguousPacket.result.resolvedIntent.evidence[1].claim,
          detail: "Grounded source evidence is inconsistent.",
        }],
      },
      nonCanonicalReplyPacket,
    )?.blockingIssues.length,
    1,
  );
  const resolvedHuman = structuredClone(nonCanonicalReplyPacket);
  resolvedHuman.result.zone = "red";
  resolvedHuman.result.route = "manager";
  resolvedHuman.result.resolvedIntent.target = {
    state: "resolved",
    label: choices[2],
  };
  resolvedHuman.result.resolvedIntent.blocker = null;
  resolvedHuman.result.reply = {
    body: "Строительное покрытие нельзя рекомендовать человеку.",
  };
  const resolvedSafetyCases = [
    {
      label: "resolved human",
      packet: resolvedHuman,
      issue: {
        rule: "human_safety",
        path: "/result/reply/body",
        quote: resolvedHuman.result.reply.body,
        detail: "Строительное покрытие нельзя рекомендовать человеку.",
      },
    },
    {
      label: "product",
      packet: {
        ...structuredClone(resolvedHuman),
        result: {
          ...structuredClone(resolvedHuman.result),
          commitment: "commercial_offer",
          product: { sku: "КР-001" },
        },
      },
      issue: {
        rule: "human_safety",
        path: "/result/product",
        quote: JSON.stringify({ sku: "КР-001" }),
        detail: "Товар применён к human target.",
      },
    },
    {
      label: "estimate",
      packet: {
        ...structuredClone(resolvedHuman),
        result: {
          ...structuredClone(resolvedHuman.result),
          zone: "yellow",
          route: "ready",
          commitment: "estimate",
          reply: { body: "Диапазон требует safety проверки." },
          estimates: [{ metric: "paint_quantity", range: { min: 1, max: 2 } }],
        },
      },
      issue: {
        rule: "human_safety",
        path: "/result/estimates/0",
        quote: JSON.stringify({ metric: "paint_quantity", range: { min: 1, max: 2 } }),
        detail: "Оценка относится к human target.",
      },
    },
    {
      label: "commitment",
      packet: {
        ...structuredClone(resolvedHuman),
        result: { ...structuredClone(resolvedHuman.result), commitment: "commercial_offer" },
      },
      issue: {
        rule: "authority",
        path: "/result/commitment",
        quote: "commercial_offer",
        detail: "Обязательство требует полномочий.",
      },
    },
  ];
  for (const { label, packet, issue } of resolvedSafetyCases) {
    assert.equal(
      validateReviewerDecisionV2(
        {
          schemaVersion: 2,
          approved: false,
          verdict: "Нужна проверка",
          notes: [],
          blockingIssues: [issue],
        },
        packet,
      )?.blockingIssues.length,
      1,
      label,
    );
  }
  assert.deepEqual(reviewerAllowedPathPrefixes({ order: {}, result: {} }).material_utility, ["/order"]);
});

test("reviewer path guidance omits undefined packet fields", () => {
  const packet = {
    order: { body: "Нужна партия покрытия." },
    result: {
      supplierPlan: undefined,
      reply: { body: "План ещё не подтверждён." },
    },
  };

  assert.equal(
    reviewerAllowedPathPrefixes(packet).unsupported_claim.includes(
      "/result/supplierPlan",
    ),
    false,
  );
});

test("reviewer cannot claim material utility is absent when guarded options are complete", () => {
  const packet = {
    order: { body: "Нужна партия покрытия." },
    result: {
      options: [
        { id: "supplier", reply: "Подтвердить поставщика." },
        { id: "split", reply: "Разделить поставку." },
        { id: "wait", reply: "Дождаться производства." },
      ],
      reply: { body: "Руководитель выберет один из трёх вариантов." },
    },
  };

  assert.equal(
    validateReviewerDecisionV2(
      {
        schemaVersion: 2,
        approved: false,
        verdict: "Вариантов нет",
        notes: [],
        blockingIssues: [
          {
            rule: "material_utility",
            path: "/result/options",
            quote: JSON.stringify(packet.result.options),
            detail: "В результате якобы нет вариантов следующего шага.",
          },
        ],
      },
      packet,
    ),
    null,
  );
});

function openedWeb(url, excerpt, openedAt = "2026-08-02T10:00:00Z") {
  return {
    url,
    openedAt,
    excerpt,
    sha256: createHash("sha256").update(excerpt).digest("hex"),
  };
}

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

function v2ResolvedDraft(
  job,
  {
    targetLabel = "нестандартная поверхность",
    commitment = "none",
    estimates = [],
    supplierLeads = [],
    research = { checked: false, summary: "", sources: [] },
    options = [],
    reply = {
      subject: "Спокойный разбор",
      body: "Задача понятна, берём проверку на себя.",
    },
  } = {},
) {
  const request = String(job.body ?? job.subject ?? "Заявка клиента").slice(0, 240);
  return {
    schemaVersion: 2,
    zone: commitment === "estimate" ? "yellow" : "red",
    decision: commitment === "estimate" ? "clarify" : "escalate",
    route: commitment === "estimate" ? "ready" : "manager",
    confidence: 0.88,
    resolvedIntent: {
      goal: "Подготовить безопасное решение по свободной заявке",
      asks: [
        {
          id: "customer-request",
          request,
          evidenceIds: ["request"],
        },
      ],
      target: {
        state: "resolved",
        label: targetLabel,
        evidenceIds: ["request"],
      },
      evidence: [
        {
          id: "request",
          claim: "Клиент описал объект и требуемую работу",
          confidence: 1,
          source: { kind: "message", roundNo: 1, quote: request },
        },
      ],
      assumptions: [],
      blocker: null,
    },
    visionObservation: null,
    commitment,
    estimates,
    supplierLeads,
    product: null,
    options,
    reply,
    research,
    review: {
      model: "opencode-go/deepseek-v4-pro",
      verdict: "Черновик подготовлен",
      notes: [],
    },
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
  assert.match(result.reply.body, /выберите один подготовленный вариант/iu);
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

test("uses the same plain market explanation in the live model route", () => {
  const result = normalizeAgentResult(agentDraft(), demoData, {
    company: "Завод",
    subject: "Краска для ограждений",
    body: "Нужны 200 кг краски для металлических ограждений на улице, цвет RAL 7024.",
  });

  assert.equal(
    result.market.position,
    "Наша цена 349 ₽/кг, на 3 ₽ ниже средней цены других поставщиков. Цена выглядит привлекательно. Весь объём подтверждён складом.",
  );
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
    "opencode-go/deepseek-v4-pro",
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

  assert.equal(
    result.zoneReason,
    "Весь объём подтверждён складом. По этой цене завод зарабатывает на заказе. Письмо готово.",
  );
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
    openedSources: [
      openedWeb(
        "https://example.com/company",
        "Компания выпускает промышленное оборудование.",
      ),
    ],
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
    openedSources: [
      openedWeb(
        "https://example.com/company",
        "Факт относится к другой организации.",
      ),
    ],
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
  assert.deepEqual(result.research.sources, []);
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
    openedSources: [
      openedWeb(
        "https://example.com/company",
        "Компания выпускает оборудование.",
      ),
    ],
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
    "opencode-go/deepseek-v4-pro",
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
      "opencode-go/deepseek-v4-pro",
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
    "opencode-go/deepseek-v4-pro",
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
    "opencode-go/deepseek-v4-pro",
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

test("grounds a researched floor recommendation and removes invented sanitary claims", () => {
  const draft = agentDraft({ sku: "КР-003", requestedKg: 0 });
  draft.businessContext =
    "КР-003 соответствует требованиям фармацевтического склада, ГОСТ и выдерживает дезинфекцию.";
  draft.reply.body =
    "Подтверждаем соответствие ГОСТ и ежедневную обработку дезинфицирующими средствами.";
  draft.research = {
    checked: true,
    summary: "Компания работает в фармацевтической отрасли.",
    sources: [
      {
        title: "Отраслевой профиль компании",
        url: "https://research.example.com/industry",
        checkedAt: "2026-07-30",
        fact: "Группа работает в фармацевтической и медицинской отраслях.",
      },
      {
        title: "Описание складского комплекса",
        url: "https://research.example.com/warehouse",
        checkedAt: "2026-07-30",
        fact: "Группа использует логистический парк со складами для мультитемпературного хранения.",
      },
    ],
  };

  const result = normalizeAgentResult(draft, researchedDemoData, {
    company: "Исследованный склад",
    website: "research.example.com",
    subject: "Помогите выбрать краску для пола",
    body: "Нужна светло-серая краска для пола в новом помещении площадью 800 м². Пол моют каждый день.",
  });
  const visibleCopy = [
    result.businessContext,
    result.reply.body,
    result.zoneReason,
  ].join(" ");

  assert.equal(result.route, "needs_info");
  assert.equal(result.product?.sku, "КР-003");
  assert.equal(result.research.checked, true);
  assert.equal(result.missing.length, 1);
  assert.match(result.missing[0], /подскажите, пожалуйста/iu);
  assert.match(result.businessContext, /агент предполагает/iu);
  assert.match(
    result.businessContext,
    /подходит для цехов и складов.*выдерживает тележки и технику/iu,
  );
  assert.match(
    result.reply.body,
    /похоже, помещение может быть складом.*если (?:его|помещение) используют как медицинский склад.*первым вариантом станет краска/isu,
  );
  assert.doesNotMatch(
    result.reply.body,
    /учебн\p{L}*\s+(?:таблиц|каталог)|\bагент\p{L}*/iu,
  );
  assert.match(result.reply.body, /светло-серый.*есть в каталоге/iu);
  assert.match(
    result.reply.body,
    /рассчитаем заказ на 800 м².*проверим цвет.*остаток на складе/isu,
  );
  assert.equal((result.reply.body.match(/\?/gu) ?? []).length, 1);
  assert.doesNotMatch(
    visibleCopy,
    /КР-003 соответствует|соответстви\p{L}*\s+ГОСТ|выдерживает дезинфекц/iu,
  );
  assert.match(
    result.decisionBasis.map((basis) => basis.source).join(" "),
    /Описание краски в каталоге.*Отраслевой профиль компании.*Описание складского комплекса/iu,
  );
});

test("continues a researched floor order from questions to both stock routes", () => {
  const job = {
    company: "Исследованный склад",
    website: "research.example.com",
    subject: "Помогите выбрать краску для пола",
    body: [
      "Нужна светло-серая краска для пола в новом помещении площадью 800 м². Пол моют каждый день.",
      "Ответ клиента 1: Пол бетонный. Храним лекарства. Моем нейтральным средством. По полу ездят погрузчики.",
    ].join("\n\n"),
  };
  const replenished = structuredClone(researchedDemoData);
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
  const staleManagerOptions = [
    {
      id: "model-schedule",
      title: "Согласовать график",
      rationale: "Уточнить порядок работ и подготовить удобный график.",
      tradeoff: "Клиент подтвердит порядок работ.",
      reply: "Пришлите порядок работ, и мы подготовим удобный график.",
    },
    {
      id: "model-production",
      title: "Проверить ближайший выпуск",
      rationale: "Производство назовёт ближайшую доступную дату.",
      tradeoff: "Дата появится после проверки производства.",
      reply: "Проверим ближайший выпуск и направим точную дату.",
    },
    {
      id: "model-priority",
      title: "Уточнить приоритет клиента",
      rationale: "Клиент назовёт главный приоритет по сроку и поставке.",
      tradeoff: "Понадобится один короткий ответ.",
      reply: "Что важнее для вашего графика: первая партия или общая дата?",
    },
  ];

  const beforeRestock = normalizeAgentResult(
    agentDraft({
      sku: "КР-003",
      requestedKg: 0,
      zone: "red",
      options: staleManagerOptions,
    }),
    researchedDemoData,
    job,
  );
  const afterRestock = normalizeAgentResult(
    agentDraft({
      sku: "КР-003",
      requestedKg: 0,
      zone: "red",
      options: staleManagerOptions,
    }),
    replenished,
    job,
  );

  assert.equal(beforeRestock.route, "manager");
  assert.equal(beforeRestock.product.requestedKg, 620);
  assert.match(beforeRestock.calculation?.explanation ?? "", /31 упаковку/iu);
  assert.doesNotMatch(
    beforeRestock.calculation?.explanation ?? "",
    /31 упаковок/iu,
  );
  assert.deepEqual(beforeRestock.missing, []);
  assert.match(
    beforeRestock.understood.join(" "),
    /медицинский склад|лекарства/iu,
  );
  assert.match(beforeRestock.understood.join(" "), /нейтральное моющее средство/iu);
  assert.match(beforeRestock.understood.join(" "), /погрузчики/iu);
  const supplierHelp = beforeRestock.options.find(
    (option) => option.id === "помочь-с-недостающим-объёмом",
  );
  assert.ok(supplierHelp);
  assert.ok(
    beforeRestock.options.length >= 2 && beforeRestock.options.length <= 3,
  );
  assert.ok(
    beforeRestock.options.every((option) =>
      ["supplier", "internal"].includes(option.followUpActor),
    ),
  );
  assert.doesNotMatch(
    beforeRestock.options.map((option) => option.reply).join(" "),
    /\?/u,
  );
  assert.equal(beforeRestock.supplierPlan?.ourKg, 420);
  assert.equal(beforeRestock.supplierPlan?.supplierKg, 200);
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

  assert.equal(afterRestock.route, "ready");
  assert.equal(afterRestock.zone, "green");
  assert.equal(afterRestock.product.stockKg, 700);
  assert.equal(afterRestock.product.requestedKg, 620);
  assert.deepEqual(afterRestock.missing, []);
  assert.equal(afterRestock.research.checked, true);
  assert.doesNotMatch(afterRestock.reply.body, /что храните|чем его моете/iu);
  assert.match(
    afterRestock.reply.body,
    /подходит для цехов и складов.*ежедневной влажной уборки нейтральным средством/isu,
  );
  assert.match(
    afterRestock.decisionBasis
      .map((basis) => basis.stockVersion)
      .join(" "),
    /12/u,
  );
});

test("removes internal stand language from every client-facing letter", () => {
  const draft = agentDraft({
    sku: "КР-003",
    requestedKg: 620,
    zone: "red",
    options: [
      {
        id: "internal-one",
        title: "Первый вариант",
        rationale: "Собрать объём по доступным данным.",
        tradeoff: "Руководитель проверит срок.",
        reply:
          "Агент сверит учебную таблицу, после выбора руководителя подготовит письмо.",
      },
      {
        id: "internal-two",
        title: "Второй вариант",
        rationale: "Уточнить полный график.",
        tradeoff: "Понадобится один ответ.",
        reply: "Учебный каталог подтвердит краску после этапа стенда.",
      },
    ],
  });
  const result = normalizeAgentResult(draft, demoData, {
    company: "Склад",
    subject: "Краска для пола",
    body:
      "Нужны 620 кг светло-серой краски для бетонного пола внутри склада.",
  });
  const clientCopy = [
    result.reply.body,
    ...result.options.map((option) => option.reply),
  ].join("\n");

  assert.doesNotMatch(
    clientCopy,
    /учебн\p{L}*\s+(?:таблиц|каталог)|\bагент\p{L}*|этап\p{L}*\s+стенд\p{L}*|выбор\p{L}*\s+руководител\p{L}*/iu,
  );
  assert.match(
    clientCopy,
    /на складе «Колера» доступно 420 кг.*Индустрия Покрытий.*готовим запрос партнёру: подтвердить 200 кг.*предварительная стоимость/isu,
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

test("keeps safe manager options and adds a way to cover the deficit", () => {
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
  assert.ok(result.options.length >= 2 && result.options.length <= 3);
  assert.ok(
    result.options.every((option) =>
      ["supplier", "internal"].includes(option.followUpActor),
    ),
  );
  assert.ok(
    result.options.some(
      (option) => option.id === "помочь-с-недостающим-объёмом",
    ),
  );
  assert.doesNotMatch(
    result.options.map((option) => option.reply).join(" "),
    /\?/u,
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
      body: "Нужно 800 кг покрытия КР-001 для металла снаружи, цвет RAL 9005.",
    },
  );
  const alternative = result.options.find((option) =>
    option.title.includes(approvedAnalogue.name),
  );

  assert.equal(result.zone, "red");
  assert.ok(alternative);
  assert.match(
    alternative.reply,
    /Эта краска подходит для вашей задачи/iu,
  );
  assert.equal(product.analogues.includes(approvedAnalogue.sku), true);
});

test("does not offer a stocked analogue in another color", () => {
  const approvedAnalogue = catalogProduct("КР-002");
  const result = normalizeAgentResult(
    agentDraft({ sku: "КР-001", requestedKg: 800 }),
    demoData,
    {
      company: "Завод",
      subject: "Грунт-эмаль для металла",
      body: "Нужно 800 кг покрытия КР-001 для металла снаружи, цвет RAL 7024.",
    },
  );

  assert.equal(result.zone, "red");
  assert.equal(
    result.options.some((option) =>
      `${option.title} ${option.reply}`.includes(approvedAnalogue.name),
    ),
    false,
  );
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
    "opencode-go/deepseek-v4-pro",
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
    "opencode-go/deepseek-v4-pro",
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
    openedSourceUrls: ["https://example.com/company"],
    openedSources: [
      openedWeb(
        "https://example.com/company",
        "Компания обрабатывает металлические изделия.",
      ),
    ],
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
    "opencode-go/deepseek-v4-pro",
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
    "opencode-go/deepseek-v4-pro",
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
    "opencode-go/deepseek-v4-pro",
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
    "opencode-go/deepseek-v4-pro",
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
    "opencode-go/deepseek-v4-pro",
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

test("persists the reviewed result without a synthetic final-context event", async () => {
  const source = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const reviewIndex = source.lastIndexOf("result = applyReviewerResult(");
  const resultIndex = source.indexOf(
    "await agentRequestWithRetry(\n      resultPayload(",
    reviewIndex,
  );

  assert.ok(reviewIndex >= 0 && reviewIndex < resultIndex);
  assert.doesNotMatch(source.slice(reviewIndex, resultIndex), /"research-result"/u);
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

test("passes the supplier market saved with the order into OpenCode", async () => {
  const source = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function demoDataForJob(");
  const end = source.indexOf("function storedJobJson(", start);
  assert.ok(start >= 0 && end > start);
  const demoDataForJob = runInNewContext(
    `${source.slice(start, end)}\ndemoDataForJob`,
    { demoData },
  );
  const liveMarket = [
    {
      id: "floor--supplier",
      category: "краска для бетонного пола",
      competitor: "Поставщик",
      stockKg: 150,
      stockCheckedAt: "30.07.2026, 15:20",
      pricePerKg: 402,
      deliveryDays: 4,
    },
  ];

  const adapted = demoDataForJob({
    inventorySnapshotJson: JSON.stringify({
      version: 3,
      capturedAt: "2026-07-30T12:20:00.000Z",
      items: [],
      market: liveMarket,
    }),
  });
  const legacy = demoDataForJob({
    inventorySnapshotJson: JSON.stringify({
      version: 2,
      capturedAt: "2026-07-29T12:20:00.000Z",
      items: [],
    }),
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(adapted.market)),
    liveMarket,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(legacy.market)),
    demoData.market,
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
    "opencode-go/deepseek-v4-pro",
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

test("applies a grounded ReviewerDecisionV2 reject through the legacy adapter", () => {
  const job = {
    company: "ГородПроект",
    subject: "Белая краска для офиса",
    body: "Нужно 200 кг продукта КР-004 для внутренних стен офиса, цвет белый.",
  };
  const normalized = normalizeAgentResult(
    v2ResolvedDraft(job),
    demoData,
    job,
  );
  const reviewed = applyReviewerResult(
    normalized,
    {
      schemaVersion: 2,
      approved: false,
      verdict: "Нужна ручная проверка",
      notes: [],
      blockingIssues: [
        {
          rule: "authority",
          path: "/result/reply/body",
          quote: normalized.reply.body,
          detail: "Срок в ответе требует подтверждения полномочий.",
        },
      ],
    },
    "opencode-go/deepseek-v4-pro",
    demoData,
    job,
  );

  assert.equal(reviewed.zone, "red");
  assert.equal(reviewed.decision, "escalate");
  assert.equal(reviewed.route, "manager");
  assert.match(reviewed.review.notes.join(" "), /подтверждения полномочий/iu);
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
    "opencode-go/deepseek-v4-pro",
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
    "opencode-go/deepseek-v4-pro",
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
    "opencode-go/deepseek-v4-pro",
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
      "opencode-go/deepseek-v4-pro",
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
    "opencode-go/deepseek-v4-pro",
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
    "opencode-go/deepseek-v4-pro",
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
    "opencode-go/deepseek-v4-pro",
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
    "opencode-go/deepseek-v4-pro",
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

test("keeps a bare opened URL audit-only instead of using it as external evidence", () => {
  const job = {
    subject: "Косвенный цветовой ориентир",
    body: "Нужна предварительная оценка поверхности по описанию.",
    openedSources: [
      {
        url: "https://example.com/reference",
        openedAt: "2026-07-31T10:00:00Z",
      },
    ],
  };
  const draft = v2ResolvedDraft(job, {
    commitment: "estimate",
    estimates: [
      {
        metric: "surface_area",
        range: { min: 6, max: 10, unit: "м²" },
        method: "Диапазон по описанию клиента",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.7,
      },
    ],
  });

  const result = normalizeAgentResult(draft, demoData, job);
  const auditEvidence = result.resolvedIntent.evidence.find(
    (item) => item.source.kind === "web",
  );

  assert.ok(auditEvidence);
  assert.equal(auditEvidence.confidence, 0);
  assert.match(auditEvidence.claim, /аудит.+не подтвержд/iu);
  assert.equal(
    result.decisionBasis.some(
      (item) => item.source === auditEvidence.source.title,
    ),
    false,
  );
  assert.equal(result.sources.includes(auditEvidence.source.title), false);
  assert.doesNotMatch(result.understood.join(" "), /публичная страница/iu);

  const attemptedReuse = structuredClone(draft);
  attemptedReuse.resolvedIntent.assumptions = [
    {
      id: "external-style",
      claim: "Открытая страница подтверждает внешний ориентир",
      basedOnEvidenceIds: ["opened-web-audit-1"],
      confidence: 0.8,
      confirmBefore: "never",
    },
  ];
  attemptedReuse.estimates[0].evidenceIds = ["opened-web-audit-1"];
  attemptedReuse.estimates[0].assumptionIds = ["external-style"];
  const rejectedReuse = normalizeAgentResult(attemptedReuse, demoData, job);
  assert.deepEqual(rejectedReuse.resolvedIntent.assumptions, []);
  assert.deepEqual(rejectedReuse.estimates, []);
  assert.equal(rejectedReuse.commitment, "none");
});

test("does not launder an unopened discovery result through message evidence or reply", () => {
  const job = {
    subject: "Косвенный цветовой ориентир",
    body: "Стену хочу как в той сцене с тёмными шторами и шахматным полом; название забыл.",
    openedSourceUrls: [],
    openedSources: [],
  };
  const draft = v2ResolvedDraft(job, {
    targetLabel: "стена",
    commitment: "estimate",
    estimates: [
      {
        metric: "surface_area",
        range: { min: 8, max: 12, unit: "м²" },
        method: "Широкая оценка по описанию клиента",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.6,
      },
      {
        metric: "paint_quantity",
        range: { min: 2.4, max: 3.6, unit: "кг" },
        method: "Диапазон по типовой укрывистости",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.5,
      },
    ],
    reply: {
      subject: "Стена в стиле «Северного Архива»",
      body: "По поисковой выдаче это «Северный Архив» режиссёра Артёма Лучина. Сохраним тёмную атмосферу пробным выкрасом.",
    },
  });
  draft.resolvedIntent.goal =
    "Покрасить стену в стиле «Северного Архива» Артёма Лучина";
  draft.resolvedIntent.evidence[0].claim =
    "Клиент описал сцену; discovery-выдача опознала её как «Северный Архив» Артёма Лучина";

  const result = normalizeV2AgentResult(draft, demoData, job);
  const serialized = JSON.stringify(result);

  assert.equal(result.resolvedIntent.evidence[0].claim, job.body);
  assert.doesNotMatch(serialized, /Северн.+Архив|Арт[её]м.+Лучин/iu);
  assert.match(result.reply.body, /8–12 м²/u);
  assert.equal(result.route, "ready");

  const singleToken = structuredClone(draft);
  singleToken.resolvedIntent.goal = "Покрасить стену в стиле Люмен";
  singleToken.resolvedIntent.evidence[0].claim =
    "По выдаче референс опознан как Люмен";
  singleToken.reply = {
    subject: "Ориентир Люмен",
    body: "Ориентир: Люмен. Сохраним атмосферу пробным выкрасом.",
  };
  const singleTokenResult = normalizeV2AgentResult(singleToken, demoData, job);

  assert.equal(singleTokenResult.resolvedIntent.evidence[0].claim, job.body);
  assert.doesNotMatch(JSON.stringify(singleTokenResult), /Люмен/iu);
  assert.match(singleTokenResult.reply.body, /8–12 м²/u);
});

test("materializes exact neutral evidence for a surviving supplier lead page", () => {
  const firstUrl = "https://supplier.example/overview";
  const secondUrl = "https://supplier.example/catalog";
  const job = {
    subject: "Нестандартное покрытие",
    body: "Нужно подобрать покрытие для объекта: корпус лабораторной центрифуги.",
    openedSourceUrls: [firstUrl, secondUrl],
    openedSources: [
      openedWeb(
        firstUrl,
        "Первая страница содержит общую информацию о покрытиях.",
      ),
      openedWeb(
        secondUrl,
        "Страница описывает область применения специальных покрытий для промышленных объектов.",
      ),
    ],
  };
  const draft = v2ResolvedDraft(job, {
    targetLabel: "корпус лабораторной центрифуги",
    supplierLeads: [
      {
        supplier: "Поставщик общих покрытий",
        url: firstUrl,
        openedAt: "2026-08-02T10:00:00Z",
        observedClaims: ["Страница описывает общую информацию о покрытиях"],
        confirmationNeeded: ["Подтвердить совместимость, наличие, цену и срок"],
      },
      {
        supplier: "Поставщик специальных покрытий",
        url: secondUrl,
        openedAt: "2026-08-02T10:00:00Z",
        observedClaims: ["Страница описывает область применения специальных покрытий"],
        confirmationNeeded: ["Подтвердить совместимость, наличие, цену и срок"],
      },
    ],
  });
  draft.resolvedIntent.evidence.push({
    id: "ungrounded-web-claim",
    claim: "Поставщик обещает индивидуальную скидку без ограничений",
    confidence: 0.8,
    source: {
      kind: "web",
      url: secondUrl,
      title: "Каталог поставщика",
      openedAt: "2026-08-02T10:00:00Z",
    },
  });

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(
    result.resolvedIntent.evidence.some(
      (item) => item.id === "ungrounded-web-claim",
    ),
    false,
  );
  assert.equal(isCompleteAgentResult(result), true);
  assert.equal(result.supplierLeads.length, 2);
  const webEvidence = result.resolvedIntent.evidence.filter(
    (item) => item.source.kind === "web",
  );
  assert.equal(webEvidence.length, 2);
  assert.equal(new Set(webEvidence.map((item) => item.id)).size, 2);
  assert.equal(new Set(webEvidence.map((item) => item.source.url)).size, 2);
  for (const item of webEvidence) {
    assert.equal(item.confidence, 0);
    assert.equal(
      item.claim,
      "Технический аудит: публичная страница успешно открыта; содержимое и связь с задачей не подтверждены",
    );
    assert.ok(item.source.excerpt.length <= 12_000);
    assert.match(item.source.sha256, /^[a-f0-9]{64}$/u);
  }
  const secondEvidence = webEvidence.find(
    (item) => item.source.url === secondUrl,
  );
  assert.equal(secondEvidence.source.excerpt, job.openedSources[1].excerpt);
  assert.equal(secondEvidence.source.sha256, job.openedSources[1].sha256);
});

test("does not duplicate neutral evidence when an exact authored web claim survives", () => {
  const firstUrl = "https://supplier.example/overview";
  const secondUrl = "https://supplier.example/catalog";
  const firstPage = openedWeb(
    firstUrl,
    "Первая страница содержит общую информацию о покрытиях.",
  );
  const secondPage = openedWeb(
    secondUrl,
    "Страница описывает область применения специальных покрытий для промышленных объектов.",
  );
  const job = {
    subject: "Нестандартное покрытие",
    body: "Нужно подобрать покрытие для объекта: корпус лабораторной центрифуги.",
    openedSourceUrls: [firstUrl, secondUrl],
    openedSources: [firstPage, secondPage],
  };
  const draft = v2ResolvedDraft(job, {
    targetLabel: "корпус лабораторной центрифуги",
    supplierLeads: [
      {
        supplier: "Поставщик общих покрытий",
        url: firstUrl,
        openedAt: firstPage.openedAt,
        observedClaims: ["Страница описывает общую информацию о покрытиях"],
        confirmationNeeded: ["Подтвердить совместимость, наличие, цену и срок"],
      },
      {
        supplier: "Поставщик специальных покрытий",
        url: secondUrl,
        openedAt: secondPage.openedAt,
        observedClaims: ["Страница описывает область применения специальных покрытий"],
        confirmationNeeded: ["Подтвердить совместимость, наличие, цену и срок"],
      },
    ],
  });
  draft.resolvedIntent.evidence.push({
    id: "exact-authored-web",
    claim: secondPage.excerpt,
    confidence: 0.8,
    source: {
      kind: "web",
      url: secondUrl,
      title: "Страница специальных покрытий",
      openedAt: secondPage.openedAt,
    },
  });

  const result = normalizeV2AgentResult(draft, demoData, job);
  const secondEvidence = result.resolvedIntent.evidence.filter(
    (item) => item.source.kind === "web" && item.source.url === secondUrl,
  );

  assert.equal(result.supplierLeads.length, 2);
  assert.equal(secondEvidence.length, 1);
  assert.equal(secondEvidence[0].id, "exact-authored-web");
  assert.equal(secondEvidence[0].confidence, 0.8);
  assert.equal(isCompleteAgentResult(result), true);
});

test("keeps the live Kremlin evidence and all compound estimates", () => {
  const sourceUrl = "https://reference.example/kremlin-scale";
  const claim =
    "Московский Кремль — крепость в центре Москвы, объект Всемирного наследия ЮНЕСКО и объект культурного наследия России; стены кирпичного Кремля Ивана III (1482–1495), протяжённость стен 2235 м, высота стен от 5 до 19 м, толщина от 3,5 до 6,5 м, 20 башен";
  const source = openedWeb(
    sourceUrl,
    claim,
  );
  const job = {
    subject: "Покраска и стоимость",
    body: "Покрасьте забор. Во сколько обойдётся окраска Кремля?",
    requireResolvedAsks: true,
    openedSourceUrls: [sourceUrl],
    openedSources: [source],
  };
  const draft = v2ResolvedDraft(job, {
    targetLabel: "Забор",
    commitment: "estimate",
    estimates: [
      ["surface_area", 30, 90, "м²", "Забор: отдельная оценка площади", "msg-fence"],
      ["paint_quantity", 8, 33, "кг", "Забор: отдельная оценка расхода", "msg-fence"],
      ["budget", 2_500, 11_300, "₽", "Забор: отдельный бюджет", "msg-fence"],
      ["surface_area", 45_000, 60_000, "м²", "Кремль: отдельная оценка площади", "kremlin-scale"],
      ["paint_quantity", 18_000, 30_000, "кг", "Кремль: отдельная оценка расхода", "kremlin-scale"],
      ["budget", 4_500_000, 12_000_000, "₽", "Кремль: широкий мысленный порядок бюджета", "kremlin-scale"],
    ].map(([metric, min, max, unit, method, evidenceId], index) => ({
      metric,
      range: { min, max, unit },
      method,
      evidenceIds: [evidenceId],
      assumptionIds: [],
      confidence: index < 3 ? 0.5 : 0.3,
    })),
    reply: {
      subject: "Забор и Кремль: оценки готовы",
      body:
        "Для забора подготовлены отдельные площадь, расход и бюджет. Для Кремля даю отдельную мысленную оценку площади, расхода и широкого бюджета с опорой на открытый источник.",
    },
  });
  draft.resolvedIntent.asks = [
    { id: "paint-fence", request: "Покрасьте забор.", evidenceIds: ["msg-fence"] },
    { id: "kremlin-cost", request: "Во сколько обойдётся окраска Кремля?", evidenceIds: ["msg-kremlin"] },
  ];
  draft.resolvedIntent.target.evidenceIds = ["msg-fence"];
  draft.resolvedIntent.evidence = [
    {
      id: "msg-fence",
      claim: "Клиент просит покрасить забор",
      confidence: 1,
      source: { kind: "message", roundNo: 1, quote: "Покрасьте забор" },
    },
    {
      id: "msg-kremlin",
      claim: "Клиент спрашивает стоимость окраски Кремля",
      confidence: 1,
      source: { kind: "message", roundNo: 1, quote: "Во сколько обойдётся окраска Кремля?" },
    },
    {
      id: "kremlin-scale",
      claim,
      confidence: 0.8,
      source: {
        kind: "web",
        url: sourceUrl,
        title: "Справка о Московском Кремле",
        openedAt: source.openedAt,
      },
    },
  ];

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(
    result.resolvedIntent.evidence.find((item) => item.id === "kremlin-scale")?.claim,
    claim,
  );
  assert.equal(result.estimates.length, 6);
  assert.deepEqual(
    result.estimates
      .filter((estimate) => estimate.metric === "budget")
      .map((estimate) => estimate.method.match(/(?:Забор|Кремль)/u)?.[0]),
    ["Забор", "Кремль"],
  );
  assert.deepEqual(askCoverageGaps(job, result), []);

  const englishUrl = "https://reference.example/moscow-kremlin-wall";
  const englishClaim =
    "Кремль — Kremlin; стены — wall: внешний периметр 2 235 м — outer perimeter of 2,235 metres; высота 5–19 м — height from 5 to 19 metres; 20 башен — twenty towers; стены кирпичные.";
  const englishSource = openedWeb(
    englishUrl,
    "The Moscow Kremlin Wall has an outer perimeter of 2,235 metres, ranges in height from 5 to 19 metres and includes twenty towers.",
  );
  const englishDraft = structuredClone(draft);
  const englishEvidence = englishDraft.resolvedIntent.evidence.find(
    (item) => item.id === "kremlin-scale",
  );
  englishEvidence.claim = englishClaim;
  englishEvidence.source = {
    kind: "web",
    url: englishUrl,
    title: "Moscow Kremlin Wall reference",
    openedAt: englishSource.openedAt,
  };
  const englishJob = {
    ...job,
    openedSourceUrls: [englishUrl],
    openedSources: [englishSource],
  };
  const englishResult = normalizeV2AgentResult(
    englishDraft,
    demoData,
    englishJob,
  );

  assert.equal(
    englishResult.resolvedIntent.evidence.find(
      (item) => item.id === "kremlin-scale",
    )?.claim,
    englishClaim,
  );
  assert.equal(englishResult.estimates.length, 6);
  assert.deepEqual(askCoverageGaps(englishJob, englishResult), []);
});

test("drops supplier leads and evidence for invalid, unopened, or snippet-only pages", () => {
  const firstUrl = "https://supplier.example/overview";
  const secondUrl = "https://supplier.example/catalog";
  const firstPage = openedWeb(
    firstUrl,
    "Первая страница содержит общую информацию о покрытиях.",
  );
  const validSecondPage = openedWeb(
    secondUrl,
    "Страница описывает область применения специальных покрытий для промышленных объектов.",
  );
  const draftJob = {
    subject: "Нестандартное покрытие",
    body: "Нужно подобрать покрытие для объекта: корпус лабораторной центрифуги.",
  };
  const draft = v2ResolvedDraft(draftJob, {
    targetLabel: "корпус лабораторной центрифуги",
    supplierLeads: [
      {
        supplier: "Поставщик специальных покрытий",
        url: secondUrl,
        openedAt: validSecondPage.openedAt,
        observedClaims: ["Страница описывает область применения специальных покрытий"],
        confirmationNeeded: ["Подтвердить совместимость, наличие, цену и срок"],
      },
    ],
  });

  const cases = [
    [
      "wrong SHA",
      [firstPage, { ...validSecondPage, sha256: "0".repeat(64) }],
    ],
    ["unopened", [firstPage]],
    [
      "snippet-only",
      [
        firstPage,
        {
          url: secondUrl,
          openedAt: validSecondPage.openedAt,
          excerpt: "Короткий фрагмент без проверенного хеша",
        },
      ],
    ],
  ];

  for (const [label, openedSources] of cases) {
    const job = {
      ...draftJob,
      openedSourceUrls: [firstUrl, secondUrl],
      openedSources,
    };
    const result = normalizeV2AgentResult(structuredClone(draft), demoData, job);

    assert.equal(result.supplierLeads.length, 0, label);
    assert.equal(
      result.resolvedIntent.evidence.some(
        (item) => item.source.kind === "web" && item.source.url === secondUrl,
      ),
      false,
      label,
    );
  }
});

test("turns surviving research into supplier and internal boundary actions", () => {
  for (const targetLabel of [
    "корпус лабораторной центрифуги",
    "декоративная панель для зимнего сада",
  ]) {
    const url = "https://supplier.example/special-coatings";
    const job = {
      subject: "Нестандартное покрытие",
      body: `Нужно подобрать покрытие для объекта: ${targetLabel}.`,
      openedSourceUrls: [url],
      openedSources: [
        openedWeb(
          url,
          "Страница описывает область применения специальных покрытий и направление поставок.",
        ),
      ],
    };
    const result = normalizeAgentResult(
      v2ResolvedDraft(job, {
        targetLabel,
        supplierLeads: [
          {
            supplier: "Поставщик специальных покрытий",
            url,
            openedAt: "2026-07-31T10:05:00Z",
            observedClaims: ["На странице описаны специальные покрытия"],
            confirmationNeeded: [
              "Подтвердить совместимость, наличие, цену и срок",
            ],
          },
        ],
        research: {
          checked: true,
          summary: "Найдено направление для проверки совместимости.",
          sources: [
            {
              title: "Специальные покрытия",
              url,
              checkedAt: "2026-07-31T10:05:00Z",
              fact: "Страница описывает область применения покрытий.",
            },
          ],
        },
      }),
      demoData,
      job,
    );
    const optionCopy = result.options
      .flatMap((option) => [
        option.title,
        option.rationale,
        option.tradeoff,
        option.reply,
      ])
      .join(" ");
    const clientCopy = `${result.reply.subject} ${result.reply.body}`;

    assert.equal(result.route, "manager", targetLabel);
    assert.equal(result.commitment, "none", targetLabel);
    assert.deepEqual(
      new Set(result.options.map((option) => option.followUpActor)),
      new Set(["supplier", "internal"]),
      targetLabel,
    );
    assert.match(optionCopy, /материал.+основан/iu, targetLabel);
    assert.match(optionCopy, /услови.+эксплуатац/iu, targetLabel);
    assert.match(optionCopy, /каталог/iu, targetLabel);
    assert.match(clientCopy, /параллельно.+каталог/iu, targetLabel);
    assert.doesNotMatch(`${optionCopy} ${clientCopy}`, /\?/u, targetLabel);
    assert.equal(isCompleteAgentResult(result), true, targetLabel);
  }
});

test("keeps the guarded primary reply visible on reviewer reject and timeout", () => {
  const job = {
    subject: "Нестандартное покрытие",
    body: "Нужно подобрать покрытие для необычной поверхности.",
  };
  const primary = normalizeAgentResult(
    v2ResolvedDraft(job, {
      reply: {
        subject: "Спокойный разбор задачи",
        body: "Задача понятна, проверку совместимости берём на себя.",
      },
    }),
    demoData,
    job,
  );

  for (const review of [
    {
      approved: false,
      verdict: "Нужна ручная проверка",
      notes: [],
      blockingIssues: ["Нужно повторно сверить область применения"],
    },
    null,
    {
      approved: false,
      unavailable: true,
      verdict: "Reviewer временно недоступен",
      notes: [],
      blockingIssues: ["Transport timeout"],
    },
  ]) {
    const reviewed = applyReviewerResult(
      structuredClone(primary),
      review,
      "opencode-go/deepseek-v4-pro",
      demoData,
      job,
    );

    assert.equal(reviewed.route, "manager");
    assert.equal(reviewed.zone, "red");
    assert.equal(reviewed.commitment, "none");
    assert.match(reviewed.reply.body, /Задача понятна/iu);
    assert.match(reviewed.reply.body, /ручн.+проверк/iu);
    assert.match(reviewed.reply.body, /не является коммерческим предложением/iu);
    assert.equal(isCompleteAgentResult(reviewed), true);
  }
});

test("keeps only complete standalone authored sentences", () => {
  const job = {
    subject: "Горячая зона",
    body: "Нужно проверить покрытие для нестандартной поверхности.",
  };
  const result = normalizeAgentResult(
    v2ResolvedDraft(job, {
      reply: {
        subject: "Спокойный разбор",
        body: [
          "С задачей разберёмся.",
          "подберём её по рабочей температуре.",
          "Полезный хвост без точки",
        ].join(" "),
      },
    }),
    demoData,
    job,
  );

  assert.match(result.reply.body, /^С задачей разберёмся\./u);
  assert.doesNotMatch(result.reply.body, /подберём её/iu);
  assert.doesNotMatch(result.reply.body, /хвост без точки/iu);
  assert.equal(isCompleteAgentResult(result), true);

  const linkedSentence = normalizeAgentResult(
    v2ResolvedDraft(job, {
      reply: {
        subject: "Проверка условий применения",
        body:
          "Наружную часть можно защитить подтверждённой термостойкой системой; подберём её по рабочей температуре.",
      },
    }),
    demoData,
    job,
  );
  assert.match(linkedSentence.reply.body, /^Понял:/u);
  assert.match(
    linkedSentence.reply.body,
    /Наружную часть.+; подберём её по рабочей температуре\./iu,
  );
  assert.equal(isCompleteAgentResult(linkedSentence), true);
});

test("uses catalog-fit boundary actions for unfamiliar targets without claiming research", () => {
  for (const targetLabel of [
    "кожух спектрометра",
    "подставка для акустического резонатора",
  ]) {
    const job = {
      subject: "Нестандартная задача",
      body: `Нужно обработать объект: ${targetLabel}.`,
    };
    const result = normalizeAgentResult(
      v2ResolvedDraft(job, {
        targetLabel,
        options: [
          {
            id: "authored-safe-path",
            title: "Проверить щадящий путь",
            rationale:
              "Сверить материал основания и условия эксплуатации.",
            tradeoff: "Выбор займёт внутреннюю проверку.",
            reply:
              "Параллельно подготовим обратимый тест на отдельном образце.",
            followUpActor: "internal",
          },
        ],
      }),
      demoData,
      job,
    );
    const optionCopy = result.options
      .flatMap((option) => [option.title, option.rationale, option.reply])
      .join(" ");
    const copy = `${optionCopy} ${result.reply.body}`;

    assert.equal(result.route, "manager", targetLabel);
    assert.equal(result.commitment, "none", targetLabel);
    assert.ok(
      result.options.some((option) => option.id === "authored-safe-path"),
      targetLabel,
    );
    assert.ok(
      result.options.every((option) => option.followUpActor === "internal"),
      targetLabel,
    );
    assert.match(copy, /материал.+основан/iu, targetLabel);
    assert.match(copy, /услови.+эксплуатац/iu, targetLabel);
    assert.match(copy, /каталог/iu, targetLabel);
    assert.doesNotMatch(copy, /открыт.+источник|найденн.+поставщик/iu, targetLabel);
    assert.equal(isCompleteAgentResult(result), true, targetLabel);
  }
});

test("keeps fail-closed target ambiguity only when reviewer is unavailable", () => {
  const job = {
    subject: "Фото необычного объекта",
    body: "Покрасить это на фото.",
  };
  const draft = v2ResolvedDraft(job);
  draft.resolvedIntent = {
    goal: "Определить объект действия",
    target: {
      state: "ambiguous",
      candidates: [
        { label: "панель", confidence: 0.52, evidenceIds: ["request"] },
        { label: "ремешок", confidence: 0.51, evidenceIds: ["request"] },
      ],
    },
    evidence: draft.resolvedIntent.evidence,
    assumptions: [],
    blocker: {
      kind: "target_ambiguity",
      question: "Что красим: панель или ремешок?",
      choices: ["панель", "ремешок"],
    },
  };
  const primary = normalizeAgentResult(draft, demoData, job);
  const unavailable = applyReviewerResult(
    structuredClone(primary),
    {
      approved: false,
      unavailable: true,
      verdict: "Модель проверки временно недоступна",
      notes: [],
      blockingIssues: ["Transport timeout"],
    },
    "opencode-go/deepseek-v4-pro",
    demoData,
    job,
  );

  assert.equal(unavailable.zone, "yellow");
  assert.equal(unavailable.route, "needs_info");
  assert.equal(unavailable.commitment, "none");
  assert.deepEqual(unavailable.reply, primary.reply);
  assert.deepEqual(unavailable.missing, primary.missing);
  assert.equal((unavailable.reply.body.match(/\?/gu) ?? []).length, 1);
  assert.equal(unavailable.options.length, 0);
  assert.match(unavailable.review.notes.join(" "), /недоступн/iu);
  assert.equal(isCompleteAgentResult(unavailable), true);

  const rejected = applyReviewerResult(
    structuredClone(primary),
    {
      approved: false,
      verdict: "Смысловой blocker требует ручной проверки",
      notes: [],
      blockingIssues: ["Кандидаты объекта сформулированы неточно"],
    },
    "opencode-go/deepseek-v4-pro",
    demoData,
    job,
  );
  assert.equal(rejected.zone, "red");
  assert.equal(rejected.route, "manager");
  assert.equal(rejected.commitment, "none");
  assert.match(rejected.review.verdict, /ручн.+проверк/iu);
  assert.equal(isCompleteAgentResult(rejected), true);
});

test("uses a generic ambiguity lead for a maximum-length single-token choice", () => {
  const choice = "д".repeat(160);
  const job = {
    subject: "Фото необычного объекта",
    body: "Покрасить это на фото.",
  };
  const draft = v2ResolvedDraft(job);
  draft.resolvedIntent = {
    ...draft.resolvedIntent,
    target: {
      state: "ambiguous",
      candidates: [
        { label: choice, confidence: 0.52, evidenceIds: ["request"] },
        { label: "панель", confidence: 0.51, evidenceIds: ["request"] },
      ],
    },
    blocker: {
      kind: "target_ambiguity",
      question: `Что красим: ${choice} или панель?`,
      choices: [choice, "панель"],
    },
  };

  const result = normalizeV2AgentResult(draft, demoData, job);
  const firstLine = result.reply.body.split("\n\n", 1)[0];

  assert.ok(firstLine.length <= 180);
  assert.equal(
    firstLine,
    "Вижу несколько одинаково правдоподобных целей; я уточню только объект и продолжу без повторных вопросов.",
  );
  assert.equal(result.resolvedIntent.target.candidates[0].label, choice);
  assert.equal(result.resolvedIntent.blocker.choices[0], choice);
  assert.equal((result.reply.body.match(/\?/gu) ?? []).length, 1);
  assert.match(result.reply.body, new RegExp(`${choice} или панель\\?`, "u"));
});

test("uses a generic ambiguity lead for a maximum-length spaced choice", () => {
  const choice = "редкая конструкция для уточнения дополнительная деталь "
    .repeat(3)
    .trim()
    .slice(0, 158)
    .trim();
  const job = {
    subject: "Фото необычного объекта",
    body: "Покрасить это на фото.",
  };
  const draft = v2ResolvedDraft(job);
  draft.resolvedIntent = {
    ...draft.resolvedIntent,
    target: {
      state: "ambiguous",
      candidates: [
        { label: choice, confidence: 0.52, evidenceIds: ["request"] },
        { label: "панель", confidence: 0.51, evidenceIds: ["request"] },
      ],
    },
    blocker: {
      kind: "target_ambiguity",
      question: `Что красим: ${choice} или панель?`,
      choices: [choice, "панель"],
    },
  };

  const result = normalizeV2AgentResult(draft, demoData, job);
  const firstLine = result.reply.body.split("\n\n", 1)[0];

  assert.ok(firstLine.length <= 180);
  assert.equal(
    firstLine,
    "Вижу несколько одинаково правдоподобных целей; я уточню только объект и продолжу без повторных вопросов.",
  );
  assert.equal(result.resolvedIntent.target.candidates[0].label, choice);
  assert.equal(result.resolvedIntent.blocker.choices[0], choice);
  assert.equal((result.reply.body.match(/\?/gu) ?? []).length, 1);
  assert.match(result.reply.body, new RegExp(`${choice} или панель\\?`, "u"));
});

test("latest explicit target outranks a conflicting vision target and does not publish a bogus question", () => {
  const job = {
    subject: "Покраска прибора",
    body: "Покрасьте 1 кг краски на корпусе прибора, а не на припаркованной рядом машине.",
    roundNo: 2,
    conversation: [
      {
        role: "customer",
        body: "Покрасьте 1 кг краски на корпусе прибора, а не на припаркованной рядом машине.",
      },
    ],
    visionObservation: {
      attachmentRef: "synthetic://appliance-car",
      relevance: "relevant",
      summary: "На фото видны прибор и машина рядом.",
      visibleFacts: ["Два возможных объекта"],
      targetCandidates: [],
      uncertainties: [],
    },
  };
  const draft = v2ResolvedDraft(job, { targetLabel: "припаркованная машина" });
  draft.resolvedIntent.target = {
    state: "ambiguous",
    candidates: [
      { label: "корпус прибора", confidence: 0.51, evidenceIds: ["request"] },
      { label: "припаркованная машина", confidence: 0.51, evidenceIds: ["request"] },
    ],
  };
  draft.resolvedIntent.evidence.push({
    id: "vision",
    claim: "На фото видны прибор и машина рядом",
    confidence: 0.8,
    source: {
      kind: "vision",
      attachmentRef: "synthetic://appliance-car",
      observation: "На фото видны прибор и машина рядом",
    },
  });
  const result = normalizeAgentResult(draft, demoData, job);

  assert.equal(result.route, "manager");
  assert.notEqual(result.resolvedIntent.target.state, "ambiguous");
  assert.doesNotMatch(result.reply.body, /что красим/iu);
});

test("preserves stored vision labels when the draft loses their distinguishing roots", () => {
  const job = {
    subject: "Покраска объекта на фото",
    body: "Покрасьте это на фото.",
  };
  const storedCandidates = [
    "модуль на плоской панели с меткой",
    "модуль на круглой панели с насечкой",
  ];
  const draft = v2ResolvedDraft(job);
  draft.resolvedIntent.target = {
    state: "ambiguous",
    candidates: [
      { label: "модуль на панели", confidence: 0.51, evidenceIds: ["request"] },
      { label: "модуль на панели", confidence: 0.5, evidenceIds: ["request"] },
    ],
  };
  draft.resolvedIntent.evidence.push({
    id: "vision",
    claim: "На фото видны два возможных модуля",
    confidence: 0.8,
    source: {
      kind: "vision",
      attachmentRef: "synthetic://neutral-objects",
      observation: "На фото видны два возможных модуля",
    },
  });
  draft.resolvedIntent.blocker = {
    kind: "target_ambiguity",
    question: "Что красим: модуль на панели или модуль на панели?",
    choices: ["модуль на панели", "модуль на панели"],
  };
  job.visionObservation = {
    attachmentRef: "synthetic://neutral-objects",
    relevance: "relevant",
    summary: "На фото видны два возможных модуля.",
    targetCandidates: storedCandidates.map((label, index) => ({
      label,
      confidence: 0.7 - index / 10,
      evidence: "Нейтральный видимый признак объекта.",
    })),
    visibleFacts: ["На фото видны два возможных модуля."],
    uncertainties: [],
  };

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(
    result.resolvedIntent.target.candidates.map((candidate) => candidate.label),
    storedCandidates,
  );
  assert.deepEqual(result.resolvedIntent.blocker.choices, storedCandidates);
  assert.equal(
    result.resolvedIntent.blocker.question,
    `Что красим: ${storedCandidates.join(" или ")}?`,
  );
});

test("vague photo resolves the inanimate branch when the other draft branch is human", () => {
  const job = {
    subject: "Покраска объекта на фото",
    body: "Покрасьте это на фото.",
  };
  const storedCandidates = ["Стена", "Поверхность стены", "Человек (задняя часть головы)"];
  const draft = v2ResolvedDraft(job);
  draft.resolvedIntent.target = {
    state: "ambiguous",
    candidates: [
      { label: "стена", confidence: 0.51, evidenceIds: ["request"] },
      { label: "задняя часть головы", confidence: 0.5, evidenceIds: ["request"] },
    ],
  };
  draft.resolvedIntent.evidence.push({
    id: "vision",
    claim: "На фото видны стена и задняя часть головы",
    confidence: 0.8,
    source: {
      kind: "vision",
      attachmentRef: "synthetic://wall-head",
      observation: "На фото видны стена и задняя часть головы",
    },
  });
  draft.resolvedIntent.blocker = {
    kind: "target_ambiguity",
    question: "Что красим: стена или задняя часть головы?",
    choices: ["стена", "задняя часть головы"],
  };
  job.visionObservation = {
    attachmentRef: "synthetic://wall-head",
    relevance: "relevant",
    summary: "На фото видны стена и задняя часть головы.",
    visibleFacts: ["На фото видны стена и задняя часть головы."],
    targetCandidates: storedCandidates.map((label, index) => ({
      label,
      confidence: 0.7 - index / 10,
      evidence: "Нейтральный видимый признак объекта.",
    })),
    uncertainties: [],
  };

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "resolved");
  assert.equal(result.resolvedIntent.target.label, "Стена");
  assert.equal(result.resolvedIntent.blocker, null);
  assert.equal(result.product, null);
  assert.deepEqual(result.estimates, []);
  assert.deepEqual(
    result.visionObservation.targetCandidates.map((candidate) => candidate.label),
    storedCandidates,
  );
  assert.deepEqual(result.visionObservation.visibleFacts, job.visionObservation.visibleFacts);
});

test("keeps stored vision candidate order when draft candidates are reordered", () => {
  const job = {
    subject: "Покраска объекта на фото",
    body: "Покрасьте это на фото.",
  };
  const storedCandidates = [
    "деталь с квадратной рамкой",
    "деталь с круглым кольцом",
  ];
  const draft = v2ResolvedDraft(job);
  draft.resolvedIntent.target = {
    state: "ambiguous",
    candidates: [
      { label: "деталь с кольцом", confidence: 0.51, evidenceIds: ["request"] },
      { label: "деталь с рамкой", confidence: 0.5, evidenceIds: ["request"] },
    ],
  };
  draft.resolvedIntent.evidence.push({
    id: "vision",
    claim: "На фото видны две детали",
    confidence: 0.8,
    source: {
      kind: "vision",
      attachmentRef: "synthetic://neutral-details",
      observation: "На фото видны две детали",
    },
  });
  draft.resolvedIntent.blocker = {
    kind: "target_ambiguity",
    question: "Что красим: деталь с кольцом или деталь с рамкой?",
    choices: ["деталь с кольцом", "деталь с рамкой"],
  };
  job.visionObservation = {
    attachmentRef: "synthetic://neutral-details",
    relevance: "uncertain",
    summary: "На фото видны две детали.",
    targetCandidates: storedCandidates.map((label, index) => ({
      label,
      confidence: 0.75 - index / 10,
      evidence: "Нейтральный видимый признак объекта.",
    })),
    visibleFacts: ["На фото видны две детали."],
    uncertainties: ["Точная цель не подтверждена."],
  };

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(
    result.resolvedIntent.target.candidates.map((candidate) => candidate.label),
    storedCandidates,
  );
  assert.deepEqual(result.resolvedIntent.blocker.choices, storedCandidates);
});

test("trusted substrate evidence blocks construction paint on human surfaces", () => {
  for (const target of ["ладонь", "ресницы", "губы", "кисть руки"]) {
    const job = {
      subject: "Нестандартная поверхность",
      body: `Нужно покрасить 1 кг краски на ${target}.`,
    };
    const draft = v2ResolvedDraft(job, {
      targetLabel: target,
      commitment: "commercial_offer",
    });
    draft.product = { sku: "КР-004", requestedKg: 1 };
    draft.resolvedIntent.evidence.push({
      id: "fabricated-substrate",
      claim: "Основание — штукатурка",
      confidence: 1,
      source: { kind: "message", roundNo: 1, quote: job.body },
    });
    const result = normalizeAgentResult(draft, demoData, job);
    assert.equal(result.product, null, target);
    assert.notEqual(result.commitment, "commercial_offer", target);
    assert.doesNotMatch(JSON.stringify(result), /КР-004|строительн.*краск/iu, target);
  }
});

test("target fit survives a trusted substrate only when the target itself matches catalog", () => {
  const target = "штукатурная стена";
  const job = {
    subject: "Штукатурная стена",
    body: `Нужно покрасить ${target}; substrate plaster.`,
  };
  const draft = v2ResolvedDraft(job, {
    targetLabel: target,
    commitment: "estimate",
    estimates: [
      {
        metric: "paint_quantity",
        range: { min: 1, max: 2, unit: "кг" },
        method: "Оценка по заявке",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.6,
        candidateSku: "КР-004",
      },
    ],
  });
  const result = normalizeV2AgentResult(draft, demoData, job);
  assert.equal(result.estimates[0].candidateSku, "КР-004");
});

test("compound estimates keep each ask distinct and surface grounded catalog guidance", () => {
  const sourceUrl = "https://reference.example/kremlin-scale";
  const source = openedWeb(
    sourceUrl,
    "Справочная страница описывает Московский Кремль как крупный архитектурный комплекс.",
  );
  const job = {
    subject: "Вопросики",
    body: "Добрый день! Хочу покрасить забор деревянный, на даче и еще скажите сколько будет стоить покрасить кремль в москве и какой цвет выбрать лучше?",
    openedSourceUrls: [sourceUrl],
    openedSources: [source],
  };
  const draft = v2ResolvedDraft(job, {
    targetLabel: "деревянный забор на даче",
    commitment: "estimate",
    estimates: [
      {
        metric: "surface_area",
        range: { min: 30, max: 80, unit: "м²" },
        method: "Дачный забор: широкий диапазон площади по описанию клиента",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.5,
      },
      {
        metric: "paint_quantity",
        range: { min: 9, max: 25, unit: "кг" },
        method: "Дачный забор: площадь × расход каталога × два слоя с запасом",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.5,
      },
      {
        metric: "budget",
        range: { min: 3_500, max: 8_000, unit: "₽" },
        method: "Дачный забор: количество краски × цена каталога",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.5,
      },
      {
        metric: "surface_area",
        range: { min: 20_000, max: 80_000, unit: "м²" },
        method: "Кремль: порядок площади по открытому масштабу комплекса",
        evidenceIds: ["kremlin-source"],
        assumptionIds: [],
        confidence: 0.25,
      },
      {
        metric: "paint_quantity",
        range: { min: 5_600, max: 22_400, unit: "кг" },
        method: "Кремль: условный расход для мысленного сценария",
        evidenceIds: ["kremlin-source"],
        assumptionIds: [],
        confidence: 0.2,
      },
      {
        metric: "budget",
        range: { min: 500_000_000, max: 3_000_000_000, unit: "₽" },
        method: "Кремль: широкий порядок бюджета с работами и доступом",
        evidenceIds: ["kremlin-source"],
        assumptionIds: [],
        confidence: 0.15,
      },
    ],
    reply: {
      subject: "Два цветовых решения",
      body:
        "Для дачного забора выбрал бы коричневый: он спокойно стареет рядом с деревом и землёй. " +
        "Для второго объекта подготовил отдельный мысленный расчёт. " +
        "Границы такой оценки явно обозначены. " +
        "Цвет у Кремля уже выбран — исторический красный кирпич, его определяют реставраторы, а не палитра магазина.",
    },
  });
  draft.resolvedIntent.goal =
    "Оценить покраску деревянного забора и мысленный сценарий для Кремля";
  draft.resolvedIntent.asks = [
    {
      id: "paint-fence",
      request: "хочу покрасить забор деревянный, на даче",
      evidenceIds: ["request"],
    },
    {
      id: "price-kremlin",
      request: "скажите сколько будет стоить покрасить кремль в москве",
      evidenceIds: ["request"],
    },
    {
      id: "choose-color",
      request: "какой цвет выбрать лучше",
      evidenceIds: ["request"],
    },
  ];
  draft.resolvedIntent.evidence.push({
    id: "kremlin-source",
    claim: source.excerpt,
    confidence: 0.7,
    source: {
      kind: "web",
      url: sourceUrl,
      title: "Справка о масштабе комплекса",
      openedAt: source.openedAt,
    },
  });
  draft.resolvedIntent.assumptions = [{
    id: "fence-geometry",
    claim: "До замера используем модельный диапазон площади забора 45–120 м².",
    basedOnEvidenceIds: ["request"],
    confidence: 0.3,
    range: { min: 45, max: 120, unit: "м²" },
    confirmBefore: "commercial_offer",
  }];
  for (const estimate of draft.estimates.filter((item) => /забор/iu.test(item.method))) {
    estimate.assumptionIds = ["fence-geometry"];
  }

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.commitment, "estimate");
  assert.equal(result.estimates.length, 6);
  assert.match(result.reply.body, /Дачный забор/iu);
  assert.match(result.reply.body, /Кремл/iu);
  assert.match(result.reply.body, /КР-005[^.]*Краска для дерева на улице/iu);
  assert.match(result.reply.body, /0,14 кг\/м²/iu);
  assert.match(result.reply.body, /296 ₽\/кг/iu);
  assert.match(result.reply.body, /белый, коричневый, зелёный/iu);
  assert.match(result.reply.body, /(?:выбрал бы|я бы выбрал) коричневый/iu);
  assert.match(result.reply.body, /историческ[^.]{0,80}палитр/iu);
  assert.match(
    result.reply.body,
    /Дачный забор: площадь — 20–60 м², краска — 6–19 кг, бюджет — 2\s*960–5\s*920 ₽/iu,
  );
  assert.match(result.reply.body, /пришлите длину, среднюю высоту/iu);
  const fenceAssumption = result.resolvedIntent.assumptions.find((item) =>
    /забор/iu.test(item.claim),
  );
  assert.deepEqual(fenceAssumption?.range, { min: 20, max: 60, unit: "м²" });
  assert.doesNotMatch(fenceAssumption?.claim ?? "", /45\s*[–-]\s*120/u);
  for (const estimate of result.estimates.filter((item) => /забор/iu.test(item.method))) {
    assert.deepEqual(estimate.assumptionIds, [fenceAssumption.id]);
  }
  assert.doesNotMatch(
    result.reply.body,
    /широкий диапазон площади по описанию клиента: площадь/iu,
  );
  assert.deepEqual(compoundReplyCoverageGaps(job, result), []);
  assert.equal(isCompleteAgentResult(result), true);

  const headedColorAdvice = structuredClone(result);
  headedColorAdvice.reply.body =
    "Цвет для дачного забора. Советую коричневый из подтверждённой палитры. " +
    "Цвет для Кремля. Здесь выбирать не нужно: красно-кирпичный вид сохраняют реставраторы.";
  assert.deepEqual(compoundReplyCoverageGaps(job, headedColorAdvice), []);

  const sectionedColorAdvice = structuredClone(result);
  sectionedColorAdvice.reply.body =
    "Добрый день! Понял: красим деревянный забор, а по Кремлю — оценить масштаб и подсказать цвет. " +
    "По Кремлю — честная граница. Цвет там тоже выбирается не из палитры: современный канонический вид — красный кирпич.\n\n" +
    "Для деревянного забора я бы выбрал коричневый из подтверждённой палитры.";
  assert.deepEqual(compoundReplyCoverageGaps(job, sectionedColorAdvice), []);

  const missingKremlinColor = structuredClone(result);
  missingKremlinColor.reply.body = missingKremlinColor.reply.body.replace(
    /Цвет у Кремля уже выбран[^.]*\./iu,
    "Для Кремля подготовлена отдельная мысленная оценка бюджета.",
  );
  assert.deepEqual(compoundReplyCoverageGaps(job, missingKremlinColor), [
    "какой цвет выбрать лучше",
  ]);
});

test("flags a compound reply that silently drops a second paint task", () => {
  const job = {
    subject: "Вопросики",
    body: "Добрый день! Хочу покрасить забор деревянный, на даче и еще скажите сколько будет стоить покрасить кремль в москве и какой цвет выбрать лучше?",
  };
  const draft = v2ResolvedDraft(job, {
    targetLabel: "деревянный забор на даче",
    commitment: "estimate",
    estimates: [
      {
        metric: "surface_area",
        range: { min: 30, max: 80, unit: "м²" },
        method: "Дачный забор: широкий диапазон площади",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.4,
      },
      {
        metric: "paint_quantity",
        range: { min: 8.4, max: 22.4, unit: "кг" },
        method: "Дачный забор: площадь × расход × два слоя",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.4,
      },
      {
        metric: "budget",
        range: { min: 2_500, max: 6_700, unit: "₽" },
        method: "Дачный забор: количество × цена каталога",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.4,
      },
    ],
    reply: {
      subject: "Оценка забора и ответ про Кремль",
      body: "Для дачного забора подготовил диапазон и рекомендую коричневый цвет.",
    },
  });
  draft.resolvedIntent.goal = "Оценить покраску деревянного забора";
  draft.resolvedIntent.asks = [
    {
      id: "paint-fence",
      request: "хочу покрасить забор деревянный, на даче",
      evidenceIds: ["request"],
    },
    {
      id: "price-kremlin",
      request: "скажите сколько будет стоить покрасить кремль в москве",
      evidenceIds: ["request"],
    },
    {
      id: "choose-color",
      request: "какой цвет выбрать лучше",
      evidenceIds: ["request"],
    },
  ];

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(compoundReplyCoverageGaps(job, result), [
    "скажите сколько будет стоить покрасить кремль в москве",
    "какой цвет выбрать лучше",
  ]);

  draft.reply.body =
    "Для дачного забора рекомендую коричневый цвет. Для Кремля сохранил бы краснокирпичный цвет.";
  const colorOnlyResult = normalizeV2AgentResult(draft, demoData, job);
  assert.deepEqual(compoundReplyCoverageGaps(job, colorOnlyResult), [
    "скажите сколько будет стоить покрасить кремль в москве",
  ]);
});

test("generic ask coverage keeps distinct objects and differently phrased requests", () => {
  const cases = [
    {
      body: "Хочу покрасить забор и беседку",
      reply: "Для забора рекомендую КР-005, беседку оценю отдельным диапазоном.",
    },
    {
      body: "Покрасьте забор. Во сколько обойдётся окраска Кремля?",
      reply: "Для забора подойдёт КР-005. Кремль оцениваю только как мысленный сценарий.",
      estimates: [
        { metric: "budget", method: "Забор: ориентировочный бюджет" },
        { metric: "budget", method: "Кремль: широкий порядок бюджета" },
      ],
    },
    {
      body: "По фото подберите краску, а сколько стоит покрасить гараж?",
      reply: "По фото подходит КР-005. Для гаража даю отдельный диапазон.",
      estimates: [{ metric: "budget", method: "Гараж: ориентировочный бюджет" }],
    },
    {
      body: "Какую краску взять для забора и какой цвет выбрать?",
      reply: "Для забора берите КР-005; из палитры практичнее коричневый.",
      product: { sku: "КР-005" },
    },
    {
      body: "Посчитайте расход и пришлите каталог",
      reply: "Расход КР-005 — 0,14 кг/м²; в каталоге доступны три цвета.",
      product: { sku: "КР-005" },
    },
    {
      body: "Можно покрасить деревянный забор? И сколько это будет стоить?",
      reply: "Деревянный забор можно покрасить КР-005; даю диапазон стоимости.",
      estimates: [{ metric: "budget", method: "Забор: ориентировочный бюджет" }],
    },
    {
      body: "Хочу обновить фасад, а ещё подскажите сроки высыхания",
      reply: "Фасад можно обновить после подготовки; срок высыхания сверим по карточке товара.",
    },
    {
      body: "Оцените площадь стены и бюджет покраски потолка",
      reply: "Площадь стены оцениваю отдельно. Для потолка — отдельный бюджет.",
      estimates: [{ metric: "budget", method: "Потолок: ориентировочный бюджет" }],
    },
    {
      body: "Нужно покрыть террасу и лестницу",
      reply: "Террасу и лестницу считаю как два отдельных объекта.",
    },
    {
      body: "Подберите товар для беседки; потом скажите, какой цвет практичнее",
      reply: "Для беседки подходит КР-005; практичнее коричневый цвет.",
      product: { sku: "КР-005" },
    },
  ];

  for (const item of cases) {
    const explicitAsks = askCoverageGaps(
      { body: item.body },
      {
        resolvedIntent: { asks: [] },
        reply: { body: "" },
        options: [],
        estimates: [],
      },
    );
    const result = {
      resolvedIntent: {
        asks: explicitAsks.map((request, index) => ({
          id: `request-${index + 1}`,
          request,
          evidenceIds: ["request"],
        })),
      },
      reply: { body: item.reply },
      options: [],
      estimates: item.estimates ?? [],
      product: item.product ?? null,
    };
    assert.deepEqual(askCoverageGaps({ body: item.body }, result), [], item.body);
  }

  assert.deepEqual(
    askCoverageGaps(
      { body: "Хочу покрасить забор и беседку" },
      { resolvedIntent: { asks: [] }, reply: { body: "Только забор." } },
    ),
    ["хочу покрасить забор", "хочу покрасить беседку"],
  );

  const priceBody = "Покрасьте забор. Во сколько обойдётся окраска Кремля?";
  const priceAsks = askCoverageGaps(
    { body: priceBody },
    { resolvedIntent: { asks: [] }, reply: { body: "" } },
  );
  const priceGaps = askCoverageGaps(
    { body: priceBody },
    {
      resolvedIntent: {
        asks: priceAsks.map((request, index) => ({
          id: `price-request-${index + 1}`,
          request,
          evidenceIds: ["request"],
        })),
      },
      reply: { body: "Для забора и Кремля подготовлены отдельные ориентиры." },
      options: [],
      estimates: [
        { metric: "budget", method: "Кремль: широкий порядок бюджета" },
      ],
    },
  );
  assert.equal(priceGaps.length, 1);
  assert.match(priceGaps[0], /забор/iu);

  const splitAuthored = {
    resolvedIntent: {
      asks: [
        {
          id: "choose-fence-paint",
          request: "Подберите краску для деревянного забора",
          evidenceIds: ["request"],
        },
        {
          id: "estimate-fence-consumption",
          request: "Дайте диапазон расхода для деревянного забора без размеров",
          evidenceIds: ["request"],
        },
      ],
    },
    reply: { body: "Для деревянного забора подобрал краску и диапазон расхода." },
    options: [],
    estimates: [],
  };
  assert.deepEqual(
    askCoverageGaps(
      { body: "Подберите краску и дайте диапазон расхода для деревянного забора без размеров." },
      splitAuthored,
    ),
    [],
  );

  const enumeratedBody =
    "Подберите краску, цвет и диапазон бюджета для деревянной беседки без размеров.";
  const enumeratedResult = {
    resolvedIntent: {
      asks: [
        { id: "paint", request: "Подберите краску для деревянной беседки", evidenceIds: ["request"] },
        { id: "color", request: "Подберите цвет для деревянной беседки", evidenceIds: ["request"] },
        { id: "budget", request: "Подберите диапазон бюджета", evidenceIds: ["request"] },
      ],
    },
    reply: {
      body: "Для деревянной беседки подходит КР-005; рекомендую коричневый цвет; бюджет — 1 700–5 000 ₽.",
    },
    options: [],
    estimates: [
      { metric: "paint_quantity", method: "Беседка: расход КР-005", candidateSku: "КР-005" },
      { metric: "budget", method: "Беседка: диапазон бюджета", candidateSku: "КР-005" },
    ],
  };
  assert.deepEqual(
    askCoverageGaps({ body: enumeratedBody }, enumeratedResult),
    [],
  );

  const withoutColor = structuredClone(enumeratedResult);
  withoutColor.resolvedIntent.asks.splice(1, 1);
  withoutColor.reply.body =
    "Для деревянной беседки подходит КР-005; бюджет — 1 700–5 000 ₽.";
  assert.deepEqual(askCoverageGaps({ body: enumeratedBody }, withoutColor), [
    enumeratedBody.toLowerCase().replace(/\.$/u, ""),
  ]);

  const ambiguousBody =
    "Хочу покрасить это на фотографии. Подберите краску и оцените расход.";
  const ambiguousAsks = askCoverageGaps(
    { body: ambiguousBody },
    { resolvedIntent: { asks: [] }, reply: { body: "" } },
  );
  assert.deepEqual(
    askCoverageGaps(
      { body: ambiguousBody },
      {
        resolvedIntent: {
          asks: ambiguousAsks.map((request, index) => ({
            id: `ambiguous-request-${index + 1}`,
            request,
            evidenceIds: ["request"],
          })),
          target: { state: "ambiguous", candidates: [] },
          blocker: { kind: "target_ambiguity" },
        },
        reply: { body: "Что красим: автомобиль или стиральную машину?" },
        options: [],
        estimates: [],
      },
    ),
    [],
  );
});

test("a target clarification reuses the original ask without hiding new requests", () => {
  const job = {
    body: "Хочу покрасить это на фотографии. Подберите краску и оцените расход.",
    roundNo: 2,
    conversation: [
      { role: "customer", body: "Нужно покрасить автомобиль, не стиральную машину." },
    ],
    resultJson: JSON.stringify({
      resolvedIntent: {
        target: {
          state: "ambiguous",
          candidates: [
            { label: "автомобиль" },
            { label: "стиральная машина" },
          ],
        },
        blocker: {
          kind: "target_ambiguity",
          choices: ["автомобиль", "стиральная машина"],
        },
      },
    }),
  };
  const result = {
    resolvedIntent: {
      asks: [{
        id: "paint-photo-object",
        request: job.body,
        evidenceIds: ["message-1"],
      }],
      target: { state: "resolved", label: "маленький автомобиль" },
      blocker: null,
    },
    reply: {
      body: "Принято: красим автомобиль с фото, а не стиральную машину. Подобрал краску и оценил расход.",
    },
    options: [],
    estimates: [],
  };

  assert.deepEqual(askCoverageGaps(job, result), []);

  const safeBoundary = structuredClone(result);
  safeBoundary.reply.body =
    "Для автомобиля строительное покрытие нельзя рекомендовать без проверки совместимости; сверим каталог и подготовим альтернативу.";
  assert.deepEqual(askCoverageGaps(job, safeBoundary), []);

  safeBoundary.reply.body =
    "Строительное покрытие нельзя рекомендовать без проверки совместимости.";
  const missingTargetGaps = askCoverageGaps(job, safeBoundary);
  assert.equal(missingTargetGaps.length, 2);
  assert.ok(missingTargetGaps.includes(job.body));

  const withColorRequest = structuredClone(job);
  withColorRequest.conversation[0].body =
    "Нужно покрасить автомобиль, не стиральную машину. И какой цвет выбрать?";
  assert.deepEqual(askCoverageGaps(withColorRequest, result), [
    "какой цвет выбрать",
  ]);
});

test("a follow-up color recommendation survives canonical estimate copy", () => {
  const job = {
    body: "Подберите краску и дайте диапазон расхода для деревянного забора без размеров.",
    roundNo: 2,
    conversation: [{
      role: "customer",
      body: "А теперь добавьте рекомендацию по практичному цвету для дачи.",
    }],
  };
  const draft = v2ResolvedDraft(job, {
    targetLabel: "Деревянный забор",
    commitment: "estimate",
    estimates: [
      {
        metric: "surface_area",
        range: { min: 20, max: 60, unit: "м²" },
        method: "Деревянный забор: типовой диапазон без замера",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.4,
      },
      {
        metric: "paint_quantity",
        range: { min: 6, max: 19, unit: "кг" },
        method: "Деревянный забор: площадь × расход КР-005 × два слоя",
        candidateSku: "КР-005",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.5,
      },
    ],
    reply: {
      subject: "Практичный цвет для дачного забора",
      body: "Цвет советую коричневый: он спокойно смотрится среди зелени.",
    },
  });
  draft.resolvedIntent.asks.push({
    id: "practical-color",
    request: job.conversation[0].body,
    evidenceIds: ["color-request"],
  });
  draft.resolvedIntent.evidence.push({
    id: "color-request",
    claim: "Клиент просит рекомендацию по практичному цвету для дачи.",
    confidence: 1,
    source: {
      kind: "message",
      roundNo: 2,
      quote: job.conversation[0].body,
    },
  });

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.match(
    result.reply.body,
    /(?:цвет советую коричневый|я бы выбрал коричневый)/iu,
  );
  assert.deepEqual(askCoverageGaps(job, result), []);

  const paletteOnly = structuredClone(result);
  paletteOnly.reply.body =
    "Совет по подготовке: очистите поверхность. Для забора доступны белый, коричневый и зелёный цвета.";
  assert.deepEqual(askCoverageGaps(job, paletteOnly), [
    job.conversation[0].body,
  ]);
});

test("a preparation follow-up keeps every earlier estimate ask visible", () => {
  const job = {
    body: "Подберите краску, цвет и диапазон бюджета для деревянной беседки без размеров.",
    roundNo: 2,
    conversation: [{
      role: "customer",
      body: "После перезагрузки добавьте, пожалуйста, совет по подготовке поверхности.",
    }],
  };
  const draft = v2ResolvedDraft(job, {
    targetLabel: "Деревянная беседка",
    commitment: "estimate",
    estimates: [
      {
        metric: "surface_area",
        range: { min: 12, max: 30, unit: "м²" },
        method: "Деревянная беседка: типовой диапазон без замера",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.4,
      },
      {
        metric: "paint_quantity",
        range: { min: 4, max: 9, unit: "кг" },
        method: "Деревянная беседка: площадь × расход КР-005 × два слоя",
        candidateSku: "КР-005",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.5,
      },
      {
        metric: "budget",
        range: { min: 1184, max: 2664, unit: "₽" },
        method: "Деревянная беседка: количество КР-005 × 296 ₽/кг",
        candidateSku: "КР-005",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.5,
      },
    ],
    reply: {
      subject: "Подготовка деревянной беседки",
      body: "Перед покраской очистите поверхность, отшлифуйте непрочное старое покрытие и нанесите совместимый грунт.",
    },
  });
  draft.resolvedIntent.asks.push({
    id: "surface-preparation",
    request: job.conversation[0].body,
    evidenceIds: ["preparation-request"],
  });
  draft.resolvedIntent.evidence.push({
    id: "preparation-request",
    claim: "Клиент просит совет по подготовке поверхности.",
    confidence: 1,
    source: {
      kind: "message",
      roundNo: 2,
      quote: job.conversation[0].body,
    },
  });

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.match(result.reply.body, /я бы выбрал коричневый/iu);
  assert.match(result.reply.body, /очистите поверхность.+отшлифуйте.+грунт/iu);
  assert.deepEqual(askCoverageGaps(job, result), []);
});

test("accepts close ask fragments without accepting unknown evidence", () => {
  const job = {
    body: "Подберите краску, цвет и диапазон бюджета для деревянной беседки без размеров.",
  };
  const draft = v2ResolvedDraft(job, { targetLabel: "Деревянная беседка" });
  draft.resolvedIntent.asks = [
    {
      id: "choose-paint",
      request: "Подберите краску для деревянной беседки без размеров",
      evidenceIds: ["request"],
    },
    {
      id: "choose-color",
      request: "Подберите цвет для деревянной беседки",
      evidenceIds: ["request"],
    },
    {
      id: "estimate-budget",
      request: "Дайте диапазон бюджета для деревянной беседки без размеров",
      evidenceIds: ["request"],
    },
  ];

  const result = normalizeV2AgentResult(draft, demoData, {
    ...job,
    requireResolvedAsks: true,
  });

  assert.equal(result.resolvedIntent.asks.length, 3);
  assert.equal(result.resolvedIntent.target.label, "Деревянная беседка");

  const invalid = structuredClone(draft);
  invalid.resolvedIntent.asks[2].evidenceIds = ["unknown-evidence"];
  const rejected = normalizeV2AgentResult(invalid, demoData, {
    ...job,
    requireResolvedAsks: true,
  });
  assert.equal(rejected.resolvedIntent.target.label, "задача из письма клиента");
});

test("does not turn a substrate claim into an exact offer for unknown application targets", () => {
  const cases = [
    "металлическая ладонь",
    "металлические ресницы",
  ];

  for (const targetLabel of cases) {
    const job = {
      subject: `Заказ КР-001 для ${targetLabel}`,
      body: `Нужно 20 кг КР-001 для ${targetLabel}. Материал — металл.`,
    };
    const result = normalizeV2AgentResult(
      v2ResolvedDraft(job, { targetLabel, commitment: "commercial_offer" }),
      demoData,
      job,
    );

    assert.equal(result.product, null, targetLabel);
    assert.notEqual(result.commitment, "commercial_offer", targetLabel);
    assert.notEqual(result.route, "ready", targetLabel);
  }
});

test("keeps bare SKU procurement and catalog application compatibility", () => {
  const shortageJob = {
    subject: "Заказ КР-001",
    body: "Нужно 2000 кг КР-001.",
  };
  const shortage = normalizeV2AgentResult(
    v2ResolvedDraft(shortageJob, {
      targetLabel: "КР-001",
      commitment: "commercial_offer",
    }),
    demoData,
    shortageJob,
  );
  assert.equal(shortage.product?.sku, "КР-001");
  assert.equal(shortage.commitment, "commercial_offer");
  assert.equal(shortage.product?.stockKg, 300);

  const applicationJob = {
    subject: "Покраска металлической поверхности",
    body: "Нужно покрытие для металлической поверхности.",
  };
  const application = normalizeV2AgentResult(
    v2ResolvedDraft(applicationJob, {
      targetLabel: "металлическая поверхность",
      commitment: "estimate",
      estimates: [
        {
          metric: "paint_quantity",
          range: { min: 2, max: 4, unit: "кг" },
          method: "Диапазон по описанию задачи",
          evidenceIds: ["request"],
          assumptionIds: [],
          confidence: 0.7,
          candidateSku: "КР-001",
        },
      ],
    }),
    demoData,
    applicationJob,
  );
  assert.equal(application.estimates[0].candidateSku, "КР-001");
  assert.equal(application.product, null);
});

test("arbitrary target labels cannot inherit a construction SKU from substrate copy", () => {
  for (const target of ["ладонь", "ресницы", "губы", "кисть руки", "arm", "synthetic unknown"]) {
    const job = {
      subject: "Нестандартная поверхность",
      body: `Нужно покрасить ${target}; substrate plaster.`,
    };
    const draft = v2ResolvedDraft(job, {
      targetLabel: target,
      commitment: "commercial_offer",
    });
    draft.product = { sku: "КР-004", requestedKg: 1 };
    const result = normalizeV2AgentResult(draft, demoData, job);
    assert.equal(result.product, null, target);
    assert.notEqual(result.commitment, "commercial_offer", target);
  }
});

test("never treats an SKU embedded in a human target as compatibility proof", () => {
  const targets = ["ладони", "ресниц", "губ", "руки", "arm"];

  for (const target of targets) {
    const job = {
      subject: `Заказ КР-001 для ${target}`,
      body: `Нужно 20 кг КР-001 для ${target}. Материал — металл.`,
    };
    const draft = v2ResolvedDraft(job, {
      targetLabel: `КР-001 для ${target}`,
      assumptions: [
        {
          id: "fabricated-substrate",
          claim: "Основание объекта — металл",
          basedOnEvidenceIds: ["request"],
          confidence: 1,
          confirmBefore: "never",
        },
      ],
      commitment: "commercial_offer",
      estimates: [],
      product: { sku: "КР-001", requestedKg: 20 },
      zone: "green",
      decision: "quote",
      route: "ready",
    });

    const result = normalizeV2AgentResult(draft, demoData, job);

    assert.equal(result.route, "manager", target);
    assert.equal(result.commitment, "none", target);
    assert.equal(result.product, null, target);
    assert.equal(result.estimates.length, 0, target);
    assert.doesNotMatch(
      `${result.commitment} ${result.reply.body}`,
      /commercial_offer|подтверждаем.*20\s*кг|349\s*₽/iu,
      target,
    );
    assert.equal(isCompleteAgentResult(result), true, target);
  }
});

test("keeps a clean SKU procurement order on the canonical shortage path", () => {
  const job = {
    subject: "Заказ КР-001",
    body: "Нужно 2000 кг КР-001.",
  };
  const result = normalizeV2AgentResult(
    v2ResolvedDraft(job, {
      targetLabel: "КР-001",
      commitment: "commercial_offer",
      estimates: [],
      product: { sku: "КР-001", requestedKg: 999 },
      zone: "red",
      decision: "escalate",
      route: "manager",
    }),
    demoData,
    job,
  );

  assert.equal(result.product.sku, "КР-001");
  assert.equal(result.product.requestedKg, 2000);
  assert.equal(result.product.stockKg, 300);
  assert.equal(result.product.requestedKg - result.product.stockKg, 1700);
  assert.equal(result.commitment, "commercial_offer");
  assert.equal(result.route, "manager");
  assert.equal(isCompleteAgentResult(result), true);
});

test("allows a candidate SKU only when the resolved target matches a catalog substrate", () => {
  const job = {
    subject: "Покраска металла",
    body: "Нужно 20 кг покрытия для металлической поверхности.",
  };
  const result = normalizeV2AgentResult(
    v2ResolvedDraft(job, {
      targetLabel: "металлическая поверхность",
      assumptions: [],
      commitment: "estimate",
      estimates: [
        {
          metric: "surface_area",
          range: { min: 8, max: 12, unit: "м²" },
          method: "Диапазон площади по заявке",
          evidenceIds: ["request"],
          assumptionIds: [],
          confidence: 0.8,
        },
        {
          metric: "paint_quantity",
          range: { min: 2, max: 4, unit: "кг" },
          method: "Диапазон расхода по каталогу",
          evidenceIds: ["request"],
          assumptionIds: [],
          confidence: 0.7,
          candidateSku: "КР-001",
        },
      ],
      product: null,
    }),
    demoData,
    job,
  );

  assert.equal(result.commitment, "estimate");
  assert.equal(result.estimates[1].candidateSku, "КР-001");
  assert.equal(result.product, null);
  assert.equal(isCompleteAgentResult(result), true);
});

function visionAmbiguousCase({ storedCandidates, primaryCandidates }) {
  const job = {
    visionObservation: {
      attachmentRef: "synthetic://vision-only",
      relevance: "relevant",
      summary: "На фото видны несколько возможных целей.",
      visibleFacts: ["На фото видны несколько возможных целей."],
      targetCandidates: storedCandidates,
      uncertainties: [],
    },
  };
  const draft = v2ResolvedDraft(job);
  const requestEvidence = draft.resolvedIntent.evidence[0];
  draft.resolvedIntent.target = {
    state: "ambiguous",
    candidates: primaryCandidates,
  };
  draft.resolvedIntent.evidence = [
    {
      id: "vision",
      claim: "На фото видны несколько возможных целей",
      confidence: 0.9,
      source: {
        kind: "vision",
        attachmentRef: "synthetic://vision-only",
        observation: "На фото видны несколько возможных целей",
      },
    },
    requestEvidence,
  ];
  draft.resolvedIntent.target.candidates.forEach(
    (candidate) => (candidate.evidenceIds = ["vision"]),
  );
  draft.resolvedIntent.blocker = {
    kind: "target_ambiguity",
    question: `Что красим: ${primaryCandidates.map(({ label }) => label).join(" или ")}?`,
    choices: primaryCandidates.map(({ label }) => label),
  };
  return { job, draft };
}

test("does not expand a model-declared ambiguous pair with vision distractors", () => {
  for (const seed of [17, 29]) {
    const labels = [`узел ${seed} слева`, `узел ${seed} справа`];
    const { job, draft } = visionAmbiguousCase({
      primaryCandidates: labels.map((label, index) => ({
        label,
        confidence: 0.8 - index / 10,
      })),
      storedCandidates: [
        ...labels.map((label, index) => ({
          label,
          confidence: 0.8 - index / 10,
          evidence: `Видимый признак ${label}`,
        })),
        ...Array.from({ length: 3 }, (_, index) => ({
          label: `посторонний объект ${seed}-${index}`,
          confidence: 0.5 - index / 10,
          evidence: `Отдельный видимый объект ${index}`,
        })),
      ],
    });

    const result = normalizeV2AgentResult(draft, demoData, job);

    assert.deepEqual(
      result.resolvedIntent.target.candidates.map(({ label }) => label),
      labels,
    );
    assert.ok(
      result.resolvedIntent.target.candidates.every(({ evidenceIds }) =>
        evidenceIds.includes("vision"),
      ),
    );
    assert.deepEqual(result.resolvedIntent.blocker.choices, labels);
    assert.equal(result.resolvedIntent.blocker.kind, "target_ambiguity");
    assert.equal(result.missing.length, 1);
    assert.equal((result.reply.body.match(/\?/gu) ?? []).length, 1);
    assert.equal(isCompleteAgentResult(result), true);
  }
});

test("refines one grounded human surface without admitting vision distractors", () => {
  for (const [seed, surface] of [[41, "волосы"], [53, "ладонь"]]) {
    const object = `узел ${seed}`;
    const storedCandidates = [
      { label: object, confidence: 0.8, evidence: `Виден ${object}` },
      { label: "человек", confidence: 0.6, evidence: "Виден человек" },
      { label: surface, confidence: 0.4, evidence: `Видна ${surface} человека` },
      { label: `посторонняя деталь ${seed}`, confidence: 0.2, evidence: "Видна отдельно" },
    ];
    const { job, draft } = visionAmbiguousCase({
      storedCandidates,
      primaryCandidates: [
        { label: object, confidence: 0.8 },
        { label: "человек", confidence: 0.6 },
      ],
    });
    job.visionObservation.visibleFacts = [
      `В кадре виден ${object}.`,
      `${surface} человека видна отдельно.`,
      `Посторонняя деталь ${seed} находится сбоку.`,
    ];

    const result = normalizeV2AgentResult(draft, demoData, job);

    assert.deepEqual(result.resolvedIntent.blocker.choices, [
      object,
      `${surface} человека`,
    ]);
    assert.ok(
      testVisionRoots(result.resolvedIntent.blocker.choices[1]).length >= 2,
    );
    assert.equal(result.missing.length, 1);
    assert.equal((result.reply.body.match(/\?/gu) ?? []).length, 1);
    assert.equal(isCompleteAgentResult(result), true);
  }

  for (const specificSurfaces of [[], ["волосы", "ладонь"]]) {
    const object = `нейтральный узел ${specificSurfaces.length}`;
    const storedCandidates = [
      { label: object, confidence: 0.8, evidence: `Виден ${object}` },
      { label: "человек", confidence: 0.6, evidence: "Виден человек" },
      ...specificSurfaces.map((label, index) => ({
        label,
        confidence: 0.4 - index / 10,
        evidence: `Видна ${label} человека`,
      })),
    ];
    const { job, draft } = visionAmbiguousCase({
      storedCandidates,
      primaryCandidates: [
        { label: object, confidence: 0.8 },
        { label: "человек", confidence: 0.6 },
      ],
    });
    job.visionObservation.visibleFacts = [
      `Виден ${object}.`,
      "Виден человек.",
      ...specificSurfaces.map((label) => `Видна ${label} человека.`),
    ];

    const result = normalizeV2AgentResult(draft, demoData, job);

    assert.deepEqual(result.resolvedIntent.blocker.choices, [object, "человек"]);
    assert.equal(isCompleteAgentResult(result), true);
  }
});

test("keeps an unknown SKU only as an unconfirmed customer fact", () => {
  for (const sku of ["ZX-41", "QY-52"]) {
    const job = {
      subject: `Повторный заказ ${sku}`,
      body: `Нужно 12 банок ${sku} для металлической панели.`,
      openedSourceUrls: ["https://example.com/audit"],
      openedSources: [
        openedWeb(
          "https://example.com/audit",
          "Открытая страница содержит общую справочную информацию.",
        ),
      ],
    };
    const draft = v2ResolvedDraft(job, {
      targetLabel: `${sku} для металлической панели`,
      commitment: "estimate",
      estimates: [
        {
          metric: "paint_quantity",
          range: { min: 120, max: 168, unit: "кг" },
          method: "Расчёт по заявленной фасовке неизвестного кода",
          evidenceIds: ["request"],
          assumptionIds: ["pack", "properties", "compatibility", "fit"],
          confidence: 0.8,
          candidateSku: sku,
        },
      ],
    });
    draft.product = { sku, requestedKg: 168 };
    draft.resolvedIntent.assumptions = [
      ["pack", `${sku} поставляется в банках по 14 кг`],
      ["properties", `${sku} обладает промышленными защитными свойствами`],
      ["compatibility", `${sku} совместим с металлической панелью`],
      ["fit", `${sku} пригоден для заявленной эксплуатации`],
    ].map(([id, claim]) => ({
      id,
      claim,
      basedOnEvidenceIds: ["request"],
      confidence: 0.8,
      confirmBefore: "commercial_offer",
    }));
    delete draft.review;

    const primary = normalizeV2AgentResult(draft, demoData, job);
    assert.equal(isCompleteAgentResult(primary), false);
    const result = applyReviewerResult(
      primary,
      {
        schemaVersion: 2,
        approved: true,
        verdict: "Граница неизвестного артикула проверена",
        notes: [],
        blockingIssues: [],
      },
      "test-reviewer",
      demoData,
      job,
    );

    assert.equal(result.product, null);
    assert.deepEqual(result.estimates, []);
    assert.deepEqual(result.resolvedIntent.assumptions, []);
    assert.equal(result.resolvedIntent.target.label, "металлической панели");
    assert.match(result.resolvedIntent.evidence[0].claim, /металлическ.+панел/iu);
    assert.ok(
      result.resolvedIntent.evidence.some(
        ({ source }) => source.kind === "message" && source.quote.includes(sku),
      ),
    );
    assert.ok(
      result.resolvedIntent.evidence.some(({ source }) => source.kind === "web"),
    );
    const clientCopy = [
      result.reply.subject,
      result.reply.body,
      ...result.options.flatMap((option) => [option.title, option.reply]),
    ].join(" ");
    assert.equal(clientCopy.includes(sku), false);
    assert.equal(isCompleteAgentResult(result), true);
  }

  const job = { subject: "Повторный заказ ZZ-63", body: "Повторить ZZ-63." };
  const draft = v2ResolvedDraft(job, {
    targetLabel: "ZZ-63 для волшебной капсулы",
  });
  draft.resolvedIntent.assumptions = [{
    id: "invented-fit",
    claim: "ZZ-63 подходит для волшебной капсулы",
    basedOnEvidenceIds: ["request"],
    confidence: 0.8,
    confirmBefore: "commercial_offer",
  }];

  const negative = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(
    negative.resolvedIntent.target.label,
    "неподтверждённый артикул из запроса клиента",
  );
  assert.deepEqual(negative.resolvedIntent.assumptions, []);
  assert.doesNotMatch(
    `${negative.reply.body} ${negative.resolvedIntent.evidence[0].claim}`,
    /ZZ-63|волшебн.+капсул/iu,
  );

  const englishJob = {
    subject: "Repeat order KLR-X9",
    body: "Need 12 tins KLR-X9 Midnight Satin for concrete office walls.",
    openedSourceUrls: ["https://example.com/catalog"],
    openedSources: [
      openedWeb(
        "https://example.com/catalog",
        "Поставщик публикует общий каталог покрытий для бетонных стен.",
      ),
    ],
  };
  const englishDraft = v2ResolvedDraft(englishJob, {
    targetLabel: "concrete office walls",
  });
  englishDraft.supplierLeads = [
    {
      supplier: "Публичный поставщик",
      url: "https://example.com/catalog",
      openedAt: "2026-08-03T00:00:00.000Z",
      observedClaims: [
        "Поставщик публикует общий каталог покрытий для бетонных стен.",
      ],
      confirmationNeeded: [
        "Наличие KLR-X9 Midnight Satin или совместимой краски для бетонных стен в объёме 12 банок",
      ],
    },
  ];

  const englishResult = normalizeV2AgentResult(
    englishDraft,
    demoData,
    englishJob,
  );

  assert.doesNotMatch(englishResult.reply.body, /«\s*»/u);
  assert.match(englishResult.reply.body, /понял.+указанн.+артикул/iu);
  assert.doesNotMatch(englishResult.reply.body, /KLR-X9|Midnight Satin/iu);
  assert.deepEqual(englishResult.supplierLeads, []);
});

function testVisionRoots(value) {
  return [
    ...new Set(
      (
        String(value ?? "")
          .normalize("NFKC")
          .toLocaleLowerCase("ru-RU")
          .replace(/ё/gu, "е")
          .match(/[\p{L}\p{N}]{3,}/gu) ?? []
      ).map((word) => word.slice(0, Math.min(4, word.length))),
    ),
  ];
}

function testVisionRootsOverlap(left, right) {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function uniqueAlignedVisibleFact(visibleFacts, primaryLabel, genericLabel) {
  const genericRoots = testVisionRoots(genericLabel);
  const concretePrimaryRoots = testVisionRoots(primaryLabel).filter(
    (root) => !genericRoots.some((genericRoot) => testVisionRootsOverlap(root, genericRoot)),
  );
  const scored = visibleFacts.map((fact) => ({
    fact,
    score: concretePrimaryRoots.filter((root) =>
      testVisionRoots(fact).some((factRoot) => testVisionRootsOverlap(root, factRoot)),
    ).length,
  }));
  const highestScore = Math.max(0, ...scored.map(({ score }) => score));
  const highest = scored.filter(({ score }) => score === highestScore);
  return highestScore > 0 && highest.length === 1 ? highest[0].fact : null;
}

test("allows a supported primary label to specialize exactly one stored candidate", () => {
  const storedCandidates = [
    { label: "Человек (вид сзади)", confidence: 0.71, evidence: "Задняя часть головы с тёмными волосами" },
    { label: "красная стена", confidence: 0.62, evidence: "Плоская красная поверхность" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: [
      { label: "Задняя часть головы с тёмными волосами", confidence: 0.99, evidenceIds: ["vision"] },
      { label: "красная стена", confidence: 0.98, evidenceIds: ["vision"] },
    ],
  });

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(
    result.resolvedIntent.target.candidates.map((candidate) => ({
      label: candidate.label,
      confidence: candidate.confidence,
      evidenceIds: candidate.evidenceIds,
    })),
    [
      { label: "Задняя часть головы с тёмными волосами", confidence: 0.71, evidenceIds: ["vision"] },
      { label: "красная стена", confidence: 0.62, evidenceIds: ["vision"] },
    ],
  );
  assert.deepEqual(result.resolvedIntent.blocker.choices, [
    "Задняя часть головы с тёмными волосами",
    "красная стена",
  ]);
  assert.deepEqual(
    result.visionObservation.targetCandidates,
    job.visionObservation.targetCandidates,
  );
  assert.deepEqual(result.visionObservation.visibleFacts, job.visionObservation.visibleFacts);
});

test("keeps structured human detail as context for a vague photo target", () => {
  const humanStoredCandidate = {
    label: "Человек",
    confidence: 0.15,
    evidence: "Видимая часть человека — голова и плечи, viewed from behind",
  };
  const humanPrimaryCandidate = {
    label: "Голова и плечи человека (вид со спины)",
    confidence: 0.15,
    evidenceIds: ["vision"],
  };
  const storedCandidates = [
    { label: "Стена", confidence: 0.85, evidence: "Основная видимая поверхность, типичный объект окраски" },
    { label: "Рамка на стене", confidence: 0.5, evidence: "Прямоугольный объект на стене, видимая часть интерьера" },
    humanStoredCandidate,
    { label: "Пол", confidence: 0.1, evidence: "Нижняя часть изображения, видимая поверхность" },
  ];
  const primaryCandidates = [
    { label: "Стена (светлая, с рамкой)", confidence: 0.85, evidenceIds: ["vision"] },
    { label: "Рамка на стене", confidence: 0.5, evidenceIds: ["vision"] },
    { label: "Пол", confidence: 0.1, evidenceIds: ["vision"] },
    humanPrimaryCandidate,
  ];
  const { job, draft } = visionAmbiguousCase({ storedCandidates, primaryCandidates });
  job.visionObservation = {
    attachmentRef: "synthetic://equal-targets",
    relevance: "relevant",
    summary: "На изображении видна светлая стена с прямоугольной рамкой и человек, смотрящий на стену спиной.",
    visibleFacts: [
      "Светлая стена занимает большую часть изображения",
      "Прямоугольная рамка без содержимого на стене",
      "Человек с тёмными волосами спиной к камере",
      "Человек в серой одежде",
    ],
    targetCandidates: storedCandidates,
    uncertainties: [],
  };
  job.subject = "Проверка по фотографии";
  job.body = "покрасить это";
  job.roundNo = 1;
  draft.resolvedIntent.evidence[0].source.attachmentRef =
    job.visionObservation.attachmentRef;

  const result = normalizeV2AgentResult(draft, demoData, job);
  const labels = result.resolvedIntent.target.candidates.map(({ label }) => label);

  assert.ok(labels.length >= 2);
  assert.ok(labels.every((label) => !/человек|голов|волос/iu.test(label)));
  assert.deepEqual(result.resolvedIntent.blocker.choices, labels);
  assert.equal(result.product, null);
  assert.deepEqual(result.estimates, []);
  assert.equal((result.reply.body.match(/\?/gu) ?? []).length, 1);
});

test("specializes a generic human candidate from its grounded vision support", () => {
  const storedCandidates = [
    {
      label: "Стена",
      confidence: 0.85,
      evidence: "Основной объект на фото, ровная матовая поверхность",
    },
    {
      label: "Человек",
      confidence: 0.3,
      evidence: "Видна задняя часть головы с тёмными волосами и плечи",
    },
    {
      label: "Плинтус",
      confidence: 0.4,
      evidence: "Белая горизонтальная планка внизу стены",
    },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: [
      { label: "Стена", confidence: 0.85, evidenceIds: ["vision"] },
      { label: "Человек", confidence: 0.3, evidenceIds: ["vision"] },
    ],
  });
  job.visionObservation.summary =
    "На фото видна стена и вид сзади на голову человека с тёмными волосами.";
  job.visionObservation.visibleFacts = [
    "Стена светлого бежевого цвета",
    "В правой части кадра видна задняя часть головы человека с тёмными волосами",
    "Внизу стены белый плинтус",
  ];

  const result = normalizeV2AgentResult(draft, demoData, job);
  const choices = result.resolvedIntent.blocker.choices;

  assert.equal(choices.length, 2);
  assert.equal(choices[0], "Стена");
  assert.match(choices[1], /волос/iu);
  assert.doesNotMatch(choices[1], /^человек$/iu);
  assert.equal((result.reply.body.match(/\?/gu) ?? []).length, 1);
});

test("specializes from one unique neutral visible feature instead of broad primary anatomy", () => {
  const humanStoredCandidate = {
    label: "Человек",
    confidence: 0.6,
    evidence: "Видимая часть человека в кадре",
  };
  const humanPrimaryCandidate = {
    label: "Человек (вид справа)",
    confidence: 0.6,
    evidenceIds: ["vision"],
  };
  const storedCandidates = [
    { label: "Секция", confidence: 0.4, evidence: "Плоская часть объекта" },
    humanStoredCandidate,
  ];
  const primaryCandidates = [
    { label: "Секция", confidence: 0.4, evidenceIds: ["vision"] },
    humanPrimaryCandidate,
  ];
  const { job, draft } = visionAmbiguousCase({ storedCandidates, primaryCandidates });
  job.visionObservation.summary = "На фото видны секция и человек с нейтральными признаками.";
  job.visionObservation.visibleFacts = [
    "Секция с бирюзовой отметкой",
    "Человек с янтарной меткой справа",
    "Человек в синем плаще",
  ];

  const result = normalizeV2AgentResult(draft, demoData, job);
  const alignedFact = uniqueAlignedVisibleFact(
    job.visionObservation.visibleFacts,
    humanPrimaryCandidate.label,
    humanStoredCandidate.label,
  );
  const labels = result.resolvedIntent.target.candidates.map(({ label }) => label);

  assert.ok(alignedFact);
  assert.ok(labels.includes(alignedFact));
  assert.equal(labels.includes(humanPrimaryCandidate.label), false);
  assert.deepEqual(result.resolvedIntent.blocker.choices, labels);
});

test("keeps a generic human label when the best visible-feature score ties", () => {
  const storedCandidates = [
    { label: "Секция", confidence: 0.4, evidence: "Плоская часть объекта" },
    { label: "Человек", confidence: 0.6, evidence: "Видимая часть человека в кадре" },
  ];
  const primaryCandidates = [
    { label: "Секция", confidence: 0.4, evidenceIds: ["vision"] },
    { label: "Человек (вид справа)", confidence: 0.6, evidenceIds: ["vision"] },
  ];
  const { job, draft } = visionAmbiguousCase({ storedCandidates, primaryCandidates });
  job.visionObservation.visibleFacts = [
    "Человек с янтарной меткой справа",
    "Человек с бирюзовой меткой справа",
  ];

  const result = normalizeV2AgentResult(draft, demoData, job);
  const labels = result.resolvedIntent.target.candidates.map(({ label }) => label);

  assert.ok(labels.includes("Человек"));
  assert.equal(labels.includes("Человек (вид справа)"), false);
  assert.equal(labels.some((label) => label.includes("меткой")), false);
});

test("does not specialize a generic human candidate without one concrete supported sense", () => {
  const storedCandidates = [
    { label: "Человек", confidence: 0.7, evidence: "Видимая часть человека в кадре" },
    { label: "Стена", confidence: 0.3, evidence: "Плоская поверхность" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: [
      { label: "Человек", confidence: 0.7, evidenceIds: ["vision"] },
      { label: "Стена", confidence: 0.3, evidenceIds: ["vision"] },
    ],
  });

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(result.resolvedIntent.blocker.choices, ["Человек", "Стена"]);
});

test("does not guess between conflicting concrete human senses", () => {
  const storedCandidates = [
    { label: "Человек", confidence: 0.7, evidence: "Видимая часть человека — голова и плечи" },
    { label: "Стена", confidence: 0.3, evidence: "Плоская поверхность" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: [
      { label: "Голова и плечи человека", confidence: 0.7, evidenceIds: ["vision"] },
      { label: "Руки и пальцы человека", confidence: 0.6, evidenceIds: ["vision"] },
      { label: "Стена", confidence: 0.3, evidenceIds: ["vision"] },
    ],
  });
  job.visionObservation.visibleFacts = [
    "Человек виден в кадре",
    "Видимая часть человека — голова и плечи",
    "Руки и пальцы человека видны в кадре",
  ];

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(result.resolvedIntent.blocker.choices, ["Человек", "Стена"]);
});

test("keeps neutral inanimate labels unchanged while specializing only the human branch", () => {
  const storedCandidates = [
    { label: "Секция", confidence: 0.7, evidence: "Основная видимая часть объекта" },
    { label: "Человек", confidence: 0.6, evidence: "Видимая часть человека — голова и плечи" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: [
      { label: "Секция", confidence: 0.7, evidenceIds: ["vision"] },
      { label: "Голова и плечи человека", confidence: 0.6, evidenceIds: ["vision"] },
    ],
  });
  job.visionObservation.summary = "На фото видны секция и человек, видны голова и плечи.";
  job.visionObservation.visibleFacts = [
    "Секция",
    "Человек, видны голова и плечи",
  ];

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(result.resolvedIntent.blocker.choices, [
    "Секция",
    job.visionObservation.visibleFacts[1],
  ]);
});

test("does not promote personal or demographic facts into a human target label", () => {
  const storedCandidates = [
    { label: "Человек", confidence: 0.7, evidence: "Видимая часть человека в кадре" },
    { label: "Секция", confidence: 0.2, evidence: "Видимая часть объекта" },
    { label: "Панель", confidence: 0.1, evidence: "Плоская видимая поверхность" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: [
      { label: "Человек", confidence: 0.7, evidenceIds: ["vision"] },
      { label: "Женщина", confidence: 0.7, evidenceIds: ["vision"] },
      { label: "Секция", confidence: 0.2, evidenceIds: ["vision"] },
      { label: "Панель", confidence: 0.1, evidenceIds: ["vision"] },
    ],
  });
  job.visionObservation.visibleFacts = [
    "Женщина в кадре",
    "Секция и панель видны рядом",
  ];

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.blocker, null);
  assert.equal(result.product, null);
  assert.doesNotMatch(JSON.stringify(result), /женщин|мужчин|лет/iu);
});

test("keeps a defect-form stored target grounded by bounded own evidence without duplicating a primary paraphrase", () => {
  const storedCandidates = [
    { label: "элемент", confidence: 0.71, evidence: "Узкая синяя полоска и ровный край" },
    { label: "плоская основа", confidence: 0.62, evidence: "Ровная светлая поверхность" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: [
      { label: "элемент", confidence: 0.51, evidenceIds: ["vision"] },
      { label: "элемент с обратной стороны справа", confidence: 0.5, evidenceIds: ["vision"] },
    ],
  });
  job.visionObservation.visibleFacts = ["Элемент с обратной стороны справа виден в кадре."];

  const result = normalizeV2AgentResult(draft, demoData, job);
  const choices = result.resolvedIntent.blocker.choices;

  assert.equal(choices.length, 2);
  assert.match(choices[0], /^элемент \(Узкая синяя полоска и ровный край\)$/u);
  assert.match(choices[0], /полоск/u);
  assert.equal(choices[1], "плоская основа");
  assert.equal(new Set(choices).size, choices.length);
});

test("keeps an exact compact one-word stored target exact without own-evidence expansion", () => {
  const storedCandidates = [
    { label: "стена", confidence: 0.71, evidence: "Стена занимает заметную часть фона" },
    { label: "человек", confidence: 0.62, evidence: "Волосы человека видны в кадре" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: [
      { label: "стена", confidence: 0.51, evidenceIds: ["vision"] },
      { label: "человек", confidence: 0.5, evidenceIds: ["vision"] },
    ],
  });

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(result.resolvedIntent.blocker.choices, ["стена", "человек"]);
});

test("does not replace a stored label with unsupported primary anatomy", () => {
  const { job, draft } = visionAmbiguousCase({
    storedCandidates: [
      { label: "Человек (вид сзади)", confidence: 0.71, evidence: "Задняя часть головы с тёмными волосами" },
      { label: "красная стена", confidence: 0.62, evidence: "Плоская красная поверхность" },
    ],
    primaryCandidates: [
      { label: "Затылок", confidence: 0.99, evidenceIds: ["vision"] },
      { label: "красная стена", confidence: 0.98, evidenceIds: ["vision"] },
    ],
  });

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(
    result.resolvedIntent.target.candidates.map(({ label }) => label),
    ["Человек (вид сзади)", "красная стена"],
  );
});

test("does not specialize when a primary label matches two stored candidates", () => {
  const { job, draft } = visionAmbiguousCase({
    storedCandidates: [
      { label: "левая деталь", confidence: 0.71, evidence: "красная металлическая ручка" },
      { label: "правая деталь", confidence: 0.62, evidence: "красная металлическая ручка" },
    ],
    primaryCandidates: [
      { label: "красная металлическая ручка", confidence: 0.99, evidenceIds: ["vision"] },
      { label: "общая зона", confidence: 0.98, evidenceIds: ["vision"] },
    ],
  });

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(
    result.resolvedIntent.target.candidates.map(({ label }) => label),
    ["левая деталь", "правая деталь"],
  );
});

function visionPrimaryAppendCase({ storedCandidates, visibleFacts, primaryCandidates }) {
  const job = {
    subject: "Покрасить фрагменты",
    body: "Покрасить это на фото.",
    visionObservation: {
      attachmentRef: "synthetic://bounded-primary-append",
      relevance: "relevant",
      summary: "На фото видны четыре сохранённых фрагмента и тёмный фрагмент с серой полосой.",
      visibleFacts,
      targetCandidates: storedCandidates,
      uncertainties: [],
    },
  };
  const draft = v2ResolvedDraft(job);
  draft.resolvedIntent.target = { state: "ambiguous", candidates: primaryCandidates };
  draft.resolvedIntent.evidence = [{
    id: "vision",
    claim: "На фото видны несколько возможных целей.",
    confidence: 0.9,
    source: {
      kind: "vision",
      attachmentRef: "synthetic://bounded-primary-append",
      observation: "На фото видны несколько возможных целей.",
    },
  }];
  draft.resolvedIntent.target.candidates.forEach(
    (candidate) => (candidate.evidenceIds = ["vision"]),
  );
  draft.resolvedIntent.blocker = {
    kind: "target_ambiguity",
    question: `Что красим: ${primaryCandidates.map(({ label }) => label).join(" или ")}?`,
    choices: primaryCandidates.map(({ label }) => label),
  };
  return { job, draft };
}

test("appends one fully supported unmatched primary candidate without changing stored vision", () => {
  const storedCandidates = [
    { label: "светлый фрагмент", confidence: 0.9, evidence: "ровная структура" },
    { label: "квадратный фрагмент", confidence: 0.8, evidence: "угловая форма" },
    { label: "нижний фрагмент", confidence: 0.7, evidence: "нижняя граница" },
    { label: "плоский фрагмент", confidence: 0.6, evidence: "плоская поверхность" },
  ];
  const visibleFacts = [
    "Светлый фрагмент с ровной структурой",
    "Квадратный фрагмент с угловой формой",
    "Нижний фрагмент с нижней границей",
    "Плоский фрагмент с плоской поверхностью",
    "Тёмный фрагмент с серой полосой",
  ];
  const primaryCandidates = [
    ...storedCandidates.map(({ label }, index) => ({
      label,
      confidence: 0.9 - index / 10,
      evidenceIds: ["vision"],
    })),
    { label: "тёмный фрагмент с серой полосой", confidence: 0.3, evidenceIds: ["vision"] },
  ];
  const { job, draft } = visionPrimaryAppendCase({ storedCandidates, visibleFacts, primaryCandidates });
  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(result.resolvedIntent.blocker.choices, [
    ...storedCandidates.map(({ label }) => label),
    "тёмный фрагмент с серой полосой",
  ]);
  assert.equal((result.reply.body.match(/\?/gu) ?? []).length, 1);
  assert.equal(result.product, null);
  assert.deepEqual(result.estimates, []);
  assert.deepEqual(result.visionObservation.targetCandidates, storedCandidates);
});

test("does not append a primary candidate whose roots are split across visible facts", () => {
  const storedCandidates = [
    { label: "светлый фрагмент", confidence: 0.9, evidence: "ровная структура" },
    { label: "квадратный фрагмент", confidence: 0.8, evidence: "угловая форма" },
  ];
  const { job, draft } = visionPrimaryAppendCase({
    storedCandidates,
    visibleFacts: ["Тёмный фрагмент", "Серая полоса"],
    primaryCandidates: [
      ...storedCandidates.map(({ label }, index) => ({
        label,
        confidence: 0.9 - index / 10,
        evidenceIds: ["vision"],
      })),
      { label: "тёмный фрагмент с серой полосой", confidence: 0.3, evidenceIds: ["vision"] },
    ],
  });
  job.visionObservation.summary = "На фото видны сохранённые фрагменты.";
  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(result.resolvedIntent.blocker.choices, ["светлый фрагмент", "квадратный фрагмент"]);
});

test("does not build a composite own-evidence label from roots split across vision items", () => {
  const storedCandidates = [
    { label: "деталь", confidence: 0.9, evidence: "Нейтральный видимый признак" },
    { label: "второй объект", confidence: 0.8, evidence: "Другой нейтральный признак" },
  ];
  const { job, draft } = visionPrimaryAppendCase({
    storedCandidates,
    visibleFacts: ["На фото видна деталь с синим кольцом"],
    primaryCandidates: [
      { label: "деталь с янтарной рамкой и синим кольцом", confidence: 0.9, evidenceIds: ["vision"] },
      { label: "второй объект", confidence: 0.8, evidenceIds: ["vision"] },
    ],
  });
  job.visionObservation.summary = "На фото видна деталь с янтарной рамкой.";

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(result.resolvedIntent.blocker.choices, ["деталь", "второй объект"]);
  assert.deepEqual(
    result.resolvedIntent.target.candidates.map(({ label }) => label),
    ["деталь", "второй объект"],
  );
  assert.deepEqual(
    result.visionObservation.targetCandidates.map(({ label }) => label),
    ["деталь", "второй объект"],
  );
});

test("does not append an unsupported primary candidate", () => {
  const storedCandidates = [
    { label: "светлый фрагмент", confidence: 0.9, evidence: "ровная структура" },
    { label: "квадратный фрагмент", confidence: 0.8, evidence: "угловая форма" },
  ];
  const { job, draft } = visionPrimaryAppendCase({
    storedCandidates,
    visibleFacts: ["Светлый фрагмент", "Квадратный фрагмент"],
    primaryCandidates: [
      ...storedCandidates.map(({ label }, index) => ({
        label,
        confidence: 0.9 - index / 10,
        evidenceIds: ["vision"],
      })),
      { label: "неподдержанный фрагмент", confidence: 0.3, evidenceIds: ["vision"] },
    ],
  });
  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(result.resolvedIntent.blocker.choices, ["светлый фрагмент", "квадратный фрагмент"]);
});

test("does not append an invented human candidate without immutable human support", () => {
  const storedCandidates = [
    { label: "Стена", confidence: 0.7, evidence: "Плоская светлая поверхность" },
    { label: "Панель", confidence: 0.6, evidence: "Прямоугольный элемент на стене" },
  ];
  const { job, draft } = visionPrimaryAppendCase({
    storedCandidates,
    visibleFacts: ["Светлая стена", "Прямоугольная панель на стене"],
    primaryCandidates: [
      ...storedCandidates.map(({ label }, index) => ({
        label,
        confidence: 0.8 - index / 10,
        evidenceIds: ["vision"],
      })),
      { label: "Человек с крыльями", confidence: 0.4, evidenceIds: ["vision"] },
    ],
  });
  job.visionObservation.summary = "На фото видны только стена и панель.";
  job.visionObservation.scaleEvidence = ["Размер панели служит ориентиром."];
  job.visionObservation.uncertainties = ["Точная площадь стены неизвестна."];

  const result = normalizeV2AgentResult(draft, demoData, job);
  const labels = result.resolvedIntent.target.candidates.map(({ label }) => label);

  assert.deepEqual(labels, storedCandidates.map(({ label }) => label));
  assert.doesNotMatch(labels.join(" "), /человек/iu);
});

test("keeps a supported concrete human feature as context for a vague target", () => {
  const storedCandidates = [
    { label: "Стена", confidence: 0.7, evidence: "Плоская светлая поверхность" },
    { label: "Панель", confidence: 0.6, evidence: "Прямоугольный элемент на стене" },
  ];
  const humanLabel = "Голова человека с тёмными волосами";
  const { job, draft } = visionPrimaryAppendCase({
    storedCandidates,
    visibleFacts: [
      "Светлая стена",
      "Голова человека с тёмными волосами видна со спины",
    ],
    primaryCandidates: [
      { label: "Стена", confidence: 0.7, evidenceIds: ["vision"] },
      { label: humanLabel, confidence: 0.4, evidenceIds: ["vision"] },
    ],
  });
  job.visionObservation.summary = "На фото видны стена и человек со спины.";
  job.visionObservation.scaleEvidence = ["Размер головы человека служит ориентиром."];
  job.visionObservation.uncertainties = ["Точная граница волос частично скрыта."];

  const result = normalizeV2AgentResult(draft, demoData, job);
  const labels = result.resolvedIntent.target.candidates.map(({ label }) => label);

  assert.deepEqual(labels, storedCandidates.map(({ label }) => label));
  assert.equal(labels.includes(humanLabel), false);
  assert.doesNotMatch(JSON.stringify(result), /женщин|мужчин|лет|отношен|личност|идентич/iu);
});

test("fresh explicit wall target suppresses the human alternative", () => {
  const storedCandidates = [
    { label: "Стена", confidence: 0.7, evidence: "Плоская светлая поверхность" },
    { label: "Панель", confidence: 0.6, evidence: "Прямоугольный элемент на стене" },
  ];
  const { job, draft } = visionPrimaryAppendCase({
    storedCandidates,
    visibleFacts: ["Светлая стена", "Голова человека видна справа"],
    primaryCandidates: [
      { label: "Стена", confidence: 0.7, evidenceIds: ["vision"] },
      { label: "Человек", confidence: 0.4, evidenceIds: ["vision"] },
    ],
  });
  job.subject = "Выбор объекта";
  job.body = "Покрасьте стену.";
  draft.resolvedIntent.target = {
    state: "resolved",
    label: "Стена",
    evidenceIds: ["vision"],
  };
  draft.resolvedIntent.blocker = null;

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "resolved");
  assert.equal(result.resolvedIntent.target.label, "Стена");
  assert.equal(result.resolvedIntent.blocker, null);
});

test("does not append when one primary candidate is supported by two stored candidates", () => {
  const storedCandidates = [
    { label: "левый фрагмент", confidence: 0.9, evidence: "тёмная полоса" },
    { label: "правый фрагмент", confidence: 0.8, evidence: "тёмная полоса" },
  ];
  const { job, draft } = visionPrimaryAppendCase({
    storedCandidates,
    visibleFacts: ["Тёмная полоса на левом и правом фрагменте"],
    primaryCandidates: [
      ...storedCandidates.map(({ label }, index) => ({
        label,
        confidence: 0.9 - index / 10,
        evidenceIds: ["vision"],
      })),
      { label: "тёмная полоса", confidence: 0.3, evidenceIds: ["vision"] },
    ],
  });
  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.deepEqual(result.resolvedIntent.blocker.choices, ["левый фрагмент", "правый фрагмент"]);
});

test("caps seven target candidates at six through the normalized vision observation", () => {
  const candidates = Array.from({ length: 7 }, (_, index) => ({
    label: `фрагмент ${index + 1}`,
    confidence: 0.9,
    evidence: `признак ${index + 1}`,
  }));
  const job = {
    subject: "Покрасить фрагменты",
    body: "Покрасить это на фото.",
    visionObservation: {
      attachmentRef: "synthetic://cap-seven",
      relevance: "relevant",
      summary: "Семь фрагментов.",
      visibleFacts: ["Семь фрагментов."],
      targetCandidates: candidates,
      uncertainties: [],
    },
  };
  const draft = v2ResolvedDraft(job);
  draft.resolvedIntent.target = {
    state: "ambiguous",
    candidates: candidates.map(({ label }, index) => ({
      label,
      confidence: 0.9 - index / 100,
      evidenceIds: ["vision"],
    })),
  };
  draft.resolvedIntent.evidence = [{
    id: "vision",
    claim: "Семь фрагментов.",
    confidence: 0.9,
    source: { kind: "vision", attachmentRef: "synthetic://cap-seven", observation: "Семь фрагментов." },
  }];
  draft.resolvedIntent.blocker = {
    kind: "target_ambiguity",
    question: "Что красим?",
    choices: candidates.map(({ label }) => label),
  };
  draft.visionObservation = job.visionObservation;
  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.visionObservation.targetCandidates.length, 6);
  assert.equal(result.resolvedIntent.target.candidates.length, 6);
  assert.equal(result.resolvedIntent.blocker.choices.length, 6);
});

test("keeps wall/frame and flat/round stored candidates distinct during projection", () => {
  for (const [storedCandidates, primaryCandidates] of [
    [
      [
        { label: "стена с плоской рамкой", confidence: 0.71, evidence: "Плоская рамка на стене" },
        { label: "стена с круглой рамкой", confidence: 0.62, evidence: "Круглая рамка на стене" },
      ],
      [
        { label: "плоская рамка на стене", confidence: 0.99, evidenceIds: ["vision"] },
        { label: "круглая рамка на стене", confidence: 0.98, evidenceIds: ["vision"] },
      ],
    ],
    [
      [
        { label: "деталь на плоской поверхности", confidence: 0.71, evidence: "Плоская поверхность" },
        { label: "деталь на круглой поверхности", confidence: 0.62, evidence: "Круглая поверхность" },
      ],
      [
        { label: "деталь плоская", confidence: 0.99, evidenceIds: ["vision"] },
        { label: "деталь круглая", confidence: 0.98, evidenceIds: ["vision"] },
      ],
    ],
  ]) {
    const { job, draft } = visionAmbiguousCase({ storedCandidates, primaryCandidates });
    const result = normalizeV2AgentResult(draft, demoData, job);

    assert.deepEqual(
      result.resolvedIntent.target.candidates.map(({ label }) => label),
      storedCandidates.map(({ label }) => label),
    );
  }
});

function boundedVisionMergeCase() {
  const visionObservation = {
    summary:
      "На фото видна стена светлого оттенка с прямоугольным вставным элементом, плинтусом у пола и человек спиной в правой части кадра.",
    relevance: "relevant",
    targetCandidates: [
      {
        label: "Стена",
        confidence: 0.85,
        evidence:
          "Основная видимая поверхность светлого оттенка, занимает большую часть кадра",
      },
      {
        label: "Прямоугольная панель на стене",
        confidence: 0.6,
        evidence:
          "Отдельный прямоугольный элемент с рамкой, отличающийся по тону от основной стены",
      },
      {
        label: "Плинтус",
        confidence: 0.4,
        evidence: "Горизонтальный молдинг внизу стены у стыка с полом",
      },
    ],
    visibleFacts: [
      "Стена светлого (бежевого/кремового) оттенка",
      "На стене прямоугольный вставной элемент с рамкой",
      "Внизу стены виден плинтус/молдинг",
      "Слева видна часть напольного покрытия серого оттенка",
    ],
    scaleEvidence: [
      "Соотношение размера головы человека (~20 см) к стене позволяет оценить пропорции",
      "Высота плинтуса (~10–15 см) как ориентир",
    ],
    areaEstimate: {
      min: 3,
      max: 7,
      unit: "м²",
      method:
        "Оценка по соотношению видимой части стены к размеру головы человека; видна примерно 2/3 стены, остальная часть закрыта человеком",
      confidence: 0.4,
    },
    uncertainties: [
      "Человек в правой части кадра закрывает часть стены, полная ширина неизвестна",
      "Неизвестна высота потолка и полная высота стены",
      "Материал стены определить невозможно, виден только цвет",
    ],
    attachmentRef: "synthetic://bounded-vision-merge",
  };
  const job = {
    subject: "Проверка по фотографии",
    body: "Ну давай, умный агент, покрась это красиво. Фото приложил.",
    roundNo: 1,
    visionObservation,
  };
  const draft = v2ResolvedDraft(job);
  draft.resolvedIntent = {
    goal:
      "Покрасить объект на фото; текст «покрась это» не называет конкретную цель, на кадре есть и стена, и человек",
    target: {
      state: "ambiguous",
      candidates: [
        {
          label: "Стена (светлая, с вставной панелью и плинтусом)",
          confidence: 0.85,
          evidenceIds: ["ev-vision-1", "ev-message-1"],
        },
        {
          label: "Человек (виден со спины в правой части кадра)",
          confidence: 0.4,
          evidenceIds: ["ev-vision-1"],
        },
      ],
    },
    evidence: [
      {
        id: "ev-message-1",
        claim: "Клиент просит покрасить «это» по фото, конкретная цель не названа",
        confidence: 0.9,
        source: {
          kind: "message",
          roundNo: 1,
          quote: job.body,
        },
      },
      {
        id: "ev-vision-1",
        claim:
          "На фото светлая стена с прямоугольным вставным элементом и плинтусом, в правой части кадра человек со спины; видимая часть стены оценивается в 3–7 м²",
        confidence: 0.8,
        source: {
          kind: "vision",
          attachmentRef: visionObservation.attachmentRef,
          observation:
            "Стена светлого оттенка с прямоугольной вставной панелью и плинтусом, человек спиной в правой части кадра, слева часть серого напольного покрытия",
        },
      },
    ],
    assumptions: [],
    blocker: {
      kind: "target_ambiguity",
      question: "Что именно красим: стену или человека в кадре?",
      choices: ["Стену", "Человека (виден со спины)"],
    },
  };
  draft.visionObservation = visionObservation;
  draft.commitment = "none";
  draft.product = null;
  draft.estimates = [];
  return { job, draft };
}

test("vague photo prefers the inanimate Koler target over a human candidate or resolution", () => {
  const storedCandidates = [
    { label: "Стена", confidence: 0.9, evidence: "Большая плоская поверхность" },
    { label: "Человек", confidence: 0.5, evidence: "Человек стоит перед стеной" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
      label,
      confidence,
      evidenceIds: ["vision"],
    })),
  });
  job.subject = "Фото стены";
  job.body = "Покрасить это.";
  job.visionObservation.summary = "На фото видны стена и человек перед ней.";
  job.visionObservation.scaleEvidence = [
    "Человек даёт грубый ориентир масштаба стены.",
  ];

  const resolvedHumanDraft = structuredClone(draft);
  resolvedHumanDraft.resolvedIntent.target = {
    state: "resolved",
    label: "Человек",
    evidenceIds: ["vision"],
  };
  resolvedHumanDraft.resolvedIntent.blocker = null;

  for (const result of [
    normalizeV2AgentResult(draft, demoData, job),
    normalizeV2AgentResult(resolvedHumanDraft, demoData, job),
  ]) {
    assert.equal(result.resolvedIntent.target.state, "resolved");
    assert.equal(result.resolvedIntent.target.label, "Стена");
    assert.equal(result.resolvedIntent.blocker, null);
    assert.doesNotMatch(result.reply.body, /что\s+красим[^?]*человек/iu);
  }
});

test("bounded vision merge resolves the inanimate side of a vague photo", () => {
  const { job, draft } = boundedVisionMergeCase();
  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "resolved");
  assert.equal(result.resolvedIntent.target.label, "Стена");
  assert.equal(result.resolvedIntent.blocker, null);
  assert.equal(result.product, null);
  assert.deepEqual(result.estimates, []);
});

function exactV25ReplayCase() {
  const job = {
    company: "Синтетический участник вебинара",
    subject: "Проверка по фотографии",
    body: "Ну давай, умный агент, покрась это красиво. Фото приложил.",
    roundNo: 1,
    attachment: {
      name: "wall-hair-equal-v2.png",
      src: "synthetic://wow-wall-hair-equal-v2",
    },
    visionObservation: {
      summary:
        "На фото видна стена с горизонтальными линиями панелей, прямоугольная рамка или картина на стене, вид сзади на голову человека с короткими чёрными волосами в серой одежде, а также плинтус внизу стены.",
      relevance: "relevant",
      targetCandidates: [
        {
          label: "Стена",
          confidence: 0.9,
          evidence:
            "Основная видимая поверхность с горизонтальными линиями панелей, занимает большую часть кадра",
        },
        {
          label: "Прямоугольная рамка/картина на стене",
          confidence: 0.6,
          evidence:
            "Отдельный прямоугольный объект на стене, возможно рамка или декоративный элемент",
        },
        {
          label: "Плинтус",
          confidence: 0.5,
          evidence:
            "Горизонтальная полоса внизу стены, отделяющая стену от пола",
        },
        {
          label: "Человек (вид сзади, голова и плечи)",
          confidence: 0.4,
          evidence:
            "Видна задняя часть головы с короткими чёрными волосами и верхняя часть плеч в серой одежде",
        },
      ],
      visibleFacts: [
        "Стена светлого бежевого/серого цвета с горизонтальными линиями панелей",
        "Прямоугольная рамка или картина светлого цвета на стене",
        "Задняя часть головы человека с короткими чёрными волосами",
        "Плинтус внизу стены",
      ],
      scaleEvidence: [
        "Голова человека как ориентир (типичная ширина ~15-20 см)",
        "Рамка/картина предположительно типичных размеров",
      ],
      areaEstimate: {
        min: 4,
        max: 12,
        unit: "м²",
        method:
          "Оценка на основе типичных размеров интерьера и пропорций видимой части стены относительно головы человека; диапазон широкий из-за отсутствия точных ориентиров",
        confidence: 0.3,
      },
      uncertainties: [
        "Неизвестны точные размеры комнаты и расстояние до стены",
        "Неизвестно, является ли рамка картиным полотном или декоративной панелью",
        "Неизвестно, полностью ли стена видна в кадре или это её часть",
      ],
      attachmentRef: "synthetic://wow-wall-hair-equal-v2",
      mode: "public-mimo-observation",
      provenance: "live-mimo-observation",
    },
  };
  const draft = v2ResolvedDraft(job);
  draft.confidence = 0.4;
  draft.resolvedIntent = {
    goal: "Покрасить объект на приложенном фото, клиент конкретную цель не назвал",
    target: {
      state: "ambiguous",
      candidates: [
        {
          label: "Стена: светлое бежево-серое покрытие с горизонтальными линиями панелей",
          confidence: 0.9,
          evidenceIds: ["ev-vision"],
        },
        {
          label: "Прямоугольная рамка или картина светлого цвета на стене",
          confidence: 0.6,
          evidenceIds: ["ev-vision"],
        },
        {
          label: "Плинтус внизу стены",
          confidence: 0.5,
          evidenceIds: ["ev-vision"],
        },
        {
          label: "Задняя часть головы человека с короткими чёрными волосами (вид сзади)",
          confidence: 0.4,
          evidenceIds: ["ev-vision"],
        },
      ],
    },
    evidence: [
      {
        id: "ev-message",
        claim:
          "Клиент просит покрасить объект на приложенном фото («покрась это красиво»), но конкретную цель словами не называет",
        confidence: 0.95,
        source: {
          kind: "message",
          roundNo: 1,
          quote: job.body,
        },
      },
      {
        id: "ev-vision",
        claim:
          "На фото несколько разных целей: стена с панельными линиями, рамка/картина, плинтус и задняя часть головы человека с короткими чёрными волосами",
        confidence: 0.8,
        source: {
          kind: "vision",
          attachmentRef: job.visionObservation.attachmentRef,
          observation:
            "Светлая бежево-серая стена с горизонтальными линиями панелей, прямоугольная рамка или картина на стене, плинтус внизу, вид сзади на голову человека с короткими чёрными волосами в серой одежде",
        },
      },
    ],
    assumptions: [],
    blocker: {
      kind: "target_ambiguity",
      question: "Что именно покрасить?",
      choices: [
        "Стену (бежево-серые панели)",
        "Рамку или картину на стене",
        "Плинтус внизу",
        "Заднюю часть головы (вид сзади, короткие чёрные волосы)",
      ],
    },
  };
  draft.commitment = "none";
  draft.product = null;
  draft.estimates = [];
  return { job, draft };
}

test("replays the V25 equal-target shape as an unresolved target", () => {
  const { job, draft } = exactV25ReplayCase();
  const result = normalizeV2AgentResult(draft, demoData, job);
  const target = result.resolvedIntent.target;

  assert.equal(target.state, "ambiguous");
  assert.ok(target.candidates.length >= 2);
  assert.equal(result.resolvedIntent.blocker.kind, "target_ambiguity");
  assert.ok(result.resolvedIntent.blocker.choices.length >= 2);
  assert.equal(result.zone, "yellow");
  assert.equal(result.route, "needs_info");
  assert.equal(result.commitment, "none");
  assert.equal(result.product, null);
  assert.deepEqual(result.estimates, []);
  assert.equal((result.resolvedIntent.blocker.question.match(/\?/gu) ?? []).length, 1);
  assert.equal((result.reply.body.match(/\?/gu) ?? []).length, 1);
});

function resolvedUnlistedHumanReplayCase() {
  const { job, draft } = exactV25ReplayCase();
  job.visionObservation.targetCandidates = [
    job.visionObservation.targetCandidates[0],
    job.visionObservation.targetCandidates[2],
  ];
  draft.resolvedIntent.target = {
    state: "resolved",
    label: "Стена",
    evidenceIds: ["ev-message", "ev-vision"],
  };
  draft.resolvedIntent.blocker = null;
  draft.commitment = "estimate";
  draft.estimates = [{
    metric: "paint_quantity",
    range: { min: 1, max: 2, unit: "кг" },
    method: "Предварительная оценка по фото",
    evidenceIds: ["ev-vision"],
    assumptionIds: [],
    confidence: 0.4,
    candidateSku: "КР-004",
  }];
  draft.product = { sku: "КР-004", requestedKg: 14 };
  return { job, draft };
}

test("keeps a frozen inanimate target resolved beside an unlisted visible person", () => {
  const { job, draft } = resolvedUnlistedHumanReplayCase();
  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "resolved");
  assert.equal(result.resolvedIntent.target.label, "Стена");
  assert.equal(result.resolvedIntent.blocker, null);
  assert.equal(result.route, "ready");
  assert.equal(result.commitment, "estimate");
  assert.equal(result.product, null);
  assert.equal(result.estimates.length, 1);
});

test("keeps an explicitly named target resolved beside an unlisted human surface", () => {
  const { job, draft } = resolvedUnlistedHumanReplayCase();
  job.body = "Покрасьте стену на фото.";
  draft.resolvedIntent.evidence[0].source.quote = job.body;

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "resolved");
  assert.equal(result.resolvedIntent.target.label, "Стена");
  assert.equal(result.resolvedIntent.blocker, null);
});

test("keeps a target resolved when a deictic photo has only an incidental person", () => {
  const { job, draft } = resolvedUnlistedHumanReplayCase();
  job.visionObservation.visibleFacts[2] =
    "В правом нижнем углу виден человек со спины";

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "resolved");
  assert.equal(result.resolvedIntent.target.label, "Стена");
  assert.equal(result.resolvedIntent.blocker, null);
});

test("keeps construction payload closed for English and mixed human targets", () => {
  for (const [targetLabel, body] of [
    ["hair", "Paint this hair. Need 10 kg for the job."],
    ["skin", "Paint this skin. Need 10 kg for the job."],
    ["hand", "Paint this hand. Need 10 kg for the job."],
    ["skin", "Покрась this skin. Need 10 kg for the job."],
  ]) {
    const job = {
      subject: "Target selection",
      body,
      roundNo: 1,
    };
    const draft = v2ResolvedDraft(job, {
      targetLabel,
      commitment: "estimate",
      estimates: [{
        metric: "paint_quantity",
        range: { min: 1, max: 2, unit: "kg" },
        method: "Диапазон по заявке",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.7,
      }],
    });

    const result = normalizeV2AgentResult(draft, demoData, job);

    assert.equal(result.resolvedIntent.target.state, "resolved", targetLabel);
    assert.equal(result.resolvedIntent.target.label, targetLabel, targetLabel);
    assert.equal(result.zone, "red", targetLabel);
    assert.equal(result.route, "manager", targetLabel);
    assert.equal(result.commitment, "none", targetLabel);
    assert.equal(result.product, null, targetLabel);
    assert.deepEqual(result.estimates, [], targetLabel);
  }
});

test("explicit hair target always uses the safe catalog boundary", () => {
  const job = {
    subject: "Фото человека",
    body: "Покрасьте волосы человека строительной краской.",
    roundNo: 1,
  };
  const draft = v2ResolvedDraft(job, {
    targetLabel: "волосы человека",
    commitment: "none",
    reply: {
      subject: "Покраска волос",
      body: "Используйте строительную краску на волосах.",
    },
  });

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.label, "волосы человека");
  assert.equal(result.route, "manager");
  assert.equal(result.commitment, "none");
  assert.equal(result.product, null);
  assert.deepEqual(result.estimates, []);
  assert.match(result.reply.body, /строительн\p{L}*.*нельзя\s+использовать/iu);
  assert.doesNotMatch(result.reply.body, /используйте\s+строительн/iu);
  assert.deepEqual(
    result.options.map(({ id }) => id),
    ["prepare-professional-reference", "keep-construction-catalog-boundary"],
  );
});

test("explicit hair request overrides a mixed model target that starts inanimate", () => {
  const job = {
    subject: "Фото человека",
    body: "Покрасьте волосы человека строительной краской.",
    roundNo: 1,
  };
  const draft = v2ResolvedDraft(job, {
    targetLabel: "стена и волосы человека",
    commitment: "estimate",
    estimates: [{
      metric: "paint_quantity",
      range: { min: 1, max: 2, unit: "кг" },
      method: "Диапазон по заявке",
      evidenceIds: ["request"],
      assumptionIds: [],
      confidence: 0.7,
    }],
    reply: {
      subject: "Покраска волос",
      body: "Используйте строительную краску на волосах.",
    },
  });

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.label, draft.resolvedIntent.target.label);
  assert.equal(result.route, "manager");
  assert.equal(result.commitment, "none");
  assert.equal(result.product, null);
  assert.deepEqual(result.estimates, []);
  assert.match(result.reply.body, /строительн\p{L}*.*нельзя\s+использовать/iu);
  assert.doesNotMatch(result.reply.body, /используйте\s+строительн/iu);
});

test("inanimate target keeps estimates when a person appears only as context", () => {
  const job = {
    subject: "Стена на фото",
    body: "Покрасьте стену на фото.",
    roundNo: 1,
  };
  const draft = v2ResolvedDraft(job, {
    targetLabel: "Стена на фото (бежевый фон за силуэтом человека)",
    commitment: "estimate",
    estimates: [
      {
        metric: "surface_area",
        range: { min: 6, max: 10, unit: "м²" },
        method: "Широкая оценка стены по фото",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.6,
      },
      {
        metric: "paint_quantity",
        range: { min: 1.8, max: 3, unit: "кг" },
        method: "Диапазон по площади стены",
        evidenceIds: ["request"],
        assumptionIds: [],
        confidence: 0.5,
      },
    ],
  });

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.label, draft.resolvedIntent.target.label);
  assert.equal(result.route, "ready");
  assert.equal(result.commitment, "estimate");
  assert.deepEqual(
    result.estimates.map(({ metric }) => metric),
    ["surface_area", "paint_quantity"],
  );
});

test("preserves raw ambiguity for action and property lexical collisions", () => {
  for (const { body, labels } of [
    { body: "Покрась это.", labels: ["покрась", "стена"] },
    { body: "Покрась это синим.", labels: ["синий", "стена"] },
    { body: "Paint this blue.", labels: ["Blue", "Wall"] },
    { body: "Покрась this blue.", labels: ["Blue", "Wall"] },
  ]) {
    const storedCandidates = labels.map((label, index) => ({
      label,
      confidence: 0.7 - index / 10,
      evidence: `Видимый кандидат ${label}`,
    }));
    const { job, draft } = visionAmbiguousCase({
      storedCandidates,
      primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
        label,
        confidence,
        evidenceIds: ["vision"],
      })),
    });
    job.subject = "Target selection";
    job.body = body;

    const result = normalizeV2AgentResult(draft, demoData, job);

    assert.equal(result.resolvedIntent.target.state, "ambiguous", body);
    assert.equal(result.resolvedIntent.blocker.kind, "target_ambiguity", body);
    assert.equal((result.resolvedIntent.blocker.question.match(/\?/gu) ?? []).length, 1, body);
    assert.equal(result.product, null, body);
    assert.deepEqual(result.estimates, [], body);
    assert.equal(result.commitment, "none", body);
  }
});

test("preserves raw ambiguity for text-only action and property collisions", () => {
  for (const { body, labels } of [
    { body: "Покрасить синим.", labels: ["синий", "стена"] },
    { body: "Paint blue.", labels: ["Blue", "Wall"] },
    { body: "Покрасить.", labels: ["покрасить", "стена"] },
  ]) {
    const job = {
      subject: "Target selection",
      body,
      roundNo: 1,
    };
    const draft = v2ResolvedDraft(job);
    draft.resolvedIntent.target = {
      state: "ambiguous",
      candidates: labels.map((label, index) => ({
        label,
        confidence: 0.7 - index / 10,
        evidenceIds: ["request"],
      })),
    };
    draft.resolvedIntent.blocker = {
      kind: "target_ambiguity",
      question: `Что красим: ${labels.join(" или ")}?`,
      choices: labels,
    };

    const result = normalizeV2AgentResult(draft, demoData, job);

    assert.equal(result.resolvedIntent.target.state, "ambiguous", body);
    assert.equal(result.resolvedIntent.blocker.kind, "target_ambiguity", body);
    assert.equal((result.resolvedIntent.blocker.question.match(/\?/gu) ?? []).length, 1, body);
    assert.equal(result.product, null, body);
    assert.deepEqual(result.estimates, [], body);
    assert.equal(result.commitment, "none", body);
  }
});

test("invalidates a resolved target negated by the latest customer correction", () => {
  for (const {
    initialBody,
    correction,
    targetLabel,
    storedCandidates,
  } of [
    {
      initialBody: "Покрасьте стену. Нужно 10 кг.",
      correction: "Нет, не стену.",
      targetLabel: "стена",
      storedCandidates: [
        { label: "Стена", confidence: 0.7, evidence: "Плоская поверхность" },
        { label: "Панель", confidence: 0.6, evidence: "Прямоугольный элемент" },
      ],
    },
    {
      initialBody: "Paint the wall. Need 10 kg.",
      correction: "No, not the wall.",
      targetLabel: "Wall",
      storedCandidates: [
        { label: "Wall", confidence: 0.7, evidence: "Flat surface" },
        { label: "Panel", confidence: 0.6, evidence: "Rectangular element" },
      ],
    },
  ]) {
    const { job, draft } = visionAmbiguousCase({
      storedCandidates,
      primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
        label,
        confidence,
        evidenceIds: ["vision"],
      })),
    });
    job.subject = "Target selection";
    job.body = initialBody;
    job.conversation = [{ role: "customer", body: correction }];
    draft.resolvedIntent.target = {
      state: "resolved",
      label: targetLabel,
      evidenceIds: ["vision"],
    };
    draft.resolvedIntent.blocker = null;
    draft.commitment = "estimate";
    draft.estimates = [{
      metric: "paint_quantity",
      range: { min: 1, max: 2, unit: "kg" },
      method: "Диапазон по заявке",
      evidenceIds: ["vision"],
      assumptionIds: [],
      confidence: 0.7,
    }];

    const result = normalizeV2AgentResult(draft, demoData, job);

    assert.equal(result.resolvedIntent.target.state, "ambiguous", correction);
    assert.equal(result.resolvedIntent.blocker.kind, "target_ambiguity", correction);
    assert.equal(result.resolvedIntent.blocker.choices.length, 2, correction);
    assert.equal(result.product, null, correction);
    assert.deepEqual(result.estimates, [], correction);
    assert.equal(result.commitment, "none", correction);
  }
});

test("fails closed after a latest negation without grounded alternatives", () => {
  const job = {
    subject: "Target selection",
    body: "Покрасьте стену. Нужно 10 кг.",
    roundNo: 1,
    conversation: [{ role: "customer", body: "Нет, не стену." }],
  };
  const draft = v2ResolvedDraft(job, {
    targetLabel: "стена",
    commitment: "estimate",
    estimates: [{
      metric: "paint_quantity",
      range: { min: 1, max: 2, unit: "kg" },
      method: "Диапазон по заявке",
      evidenceIds: ["request"],
      assumptionIds: [],
      confidence: 0.7,
    }],
  });

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.zone, "red");
  assert.equal(result.route, "manager");
  assert.equal(result.commitment, "none");
  assert.equal(result.product, null);
  assert.deepEqual(result.estimates, []);
});

test("does not resolve a bare demonstrative from an action or property root", () => {
  const storedCandidates = [
    {
      label: "Покрасочный слой",
      confidence: 0.7,
      evidence: "Видимый слой на поверхности",
    },
    {
      label: "Нейтральная деталь",
      confidence: 0.6,
      evidence: "Отдельная видимая деталь",
    },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
      label,
      confidence,
      evidenceIds: ["vision"],
    })),
  });
  job.subject = "Свободная задача по фото";
  job.body = "Покрась это красиво.";

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "ambiguous");
  assert.ok(result.resolvedIntent.blocker.choices.length >= 2);
  assert.equal(result.resolvedIntent.blocker.choices.includes("Покрасочный слой"), true);
});

test("preserves a raw resolved inanimate target under a demonstrative", () => {
  const storedCandidates = [
    { label: "Секция", confidence: 0.7, evidence: "Видимая секция" },
    { label: "Рамка", confidence: 0.6, evidence: "Видимая рамка" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
      label,
      confidence,
      evidenceIds: ["vision"],
    })),
  });
  job.subject = "Выбор цели";
  job.body = "Покрасьте эту секцию.";
  draft.resolvedIntent.target = {
    state: "resolved",
    label: "Секция",
    evidenceIds: ["vision"],
  };
  draft.resolvedIntent.blocker = null;

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "resolved");
  assert.equal(result.resolvedIntent.target.label, "Секция");
  assert.equal(result.resolvedIntent.blocker, null);
});

test("preserves a raw resolved human-visible target without product or estimates", () => {
  const storedCandidates = [
    { label: "Человек", confidence: 0.7, evidence: "Видимый человек" },
    { label: "Секция", confidence: 0.6, evidence: "Видимая секция" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
      label,
      confidence,
      evidenceIds: ["vision"],
    })),
  });
  job.subject = "Выбор цели";
  job.body = "Покрасьте человека.";
  draft.commitment = "estimate";
  draft.estimates = [{
    metric: "paint_quantity",
    range: { min: 1, max: 2, unit: "кг" },
    method: "Оценка по заявке",
    evidenceIds: ["vision"],
    assumptionIds: [],
    confidence: 0.7,
    candidateSku: "КР-001",
  }];
  draft.product = { sku: "КР-001", requestedKg: 1 };
  draft.resolvedIntent.target = {
    state: "resolved",
    label: "Человек",
    evidenceIds: ["vision"],
  };
  draft.resolvedIntent.blocker = null;

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "resolved");
  assert.equal(result.resolvedIntent.target.label, "Человек");
  assert.equal(result.product, null);
  assert.deepEqual(result.estimates, []);
});

test("preserves a fresh positive raw resolved customer correction", () => {
  const storedCandidates = [
    { label: "Секция", confidence: 0.7, evidence: "Видимая секция" },
    { label: "Рамка", confidence: 0.6, evidence: "Видимая рамка" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
      label,
      confidence,
      evidenceIds: ["vision"],
    })),
  });
  job.subject = "Старая цель";
  job.body = "Покрасьте секцию.";
  job.conversation = [{
    role: "customer",
    body: "Нет, покрасьте рамку.",
  }];
  draft.resolvedIntent.target = {
    state: "resolved",
    label: "Рамка",
    evidenceIds: ["vision"],
  };
  draft.resolvedIntent.blocker = null;

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "resolved");
  assert.equal(result.resolvedIntent.target.label, "Рамка");
  assert.equal(result.resolvedIntent.blocker, null);
});

test("ambiguous target output keeps one question and no commercial payload", () => {
  const storedCandidates = [
    { label: "Нейтральный модуль", confidence: 0.7, evidence: "Видимый модуль" },
    { label: "Отдельная деталь", confidence: 0.6, evidence: "Видимая деталь" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
      label,
      confidence,
      evidenceIds: ["vision"],
    })),
  });
  job.subject = "Свободная задача";
  job.body = "Покрасьте это.";
  draft.commitment = "commercial_offer";
  draft.estimates = [{
    metric: "paint_quantity",
    range: { min: 1, max: 2, unit: "кг" },
    method: "Оценка по заявке",
    evidenceIds: ["vision"],
    assumptionIds: [],
    confidence: 0.7,
    candidateSku: "КР-001",
  }];
  draft.product = { sku: "КР-001", requestedKg: 1 };

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "ambiguous");
  assert.equal(result.resolvedIntent.blocker.kind, "target_ambiguity");
  assert.ok(result.resolvedIntent.target.candidates.length >= 2);
  assert.equal((result.resolvedIntent.blocker.question.match(/\?/gu) ?? []).length, 1);
  assert.equal((result.reply.body.match(/\?/gu) ?? []).length, 1);
  assert.equal(result.product, null);
  assert.deepEqual(result.estimates, []);
  assert.equal(result.commitment, "none");
});

test("does not resolve the V25 property mutant from one descriptive root", () => {
  const storedCandidates = [
    { label: "Белый модуль", confidence: 0.7, evidence: "Белый модуль в кадре" },
    { label: "Нейтральная рамка", confidence: 0.6, evidence: "Нейтральная рамка в кадре" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
      label,
      confidence,
      evidenceIds: ["vision"],
    })),
  });
  job.subject = "Выбор цвета";
  job.body = "Покрась это белым.";

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "ambiguous");
  assert.equal(result.resolvedIntent.blocker.kind, "target_ambiguity");
  assert.equal(result.product, null);
  assert.deepEqual(result.estimates, []);
  assert.equal(result.commitment, "none");
});

test("keeps the property-root guard fail-safe for a mixed-English request", () => {
  const storedCandidates = [
    { label: "Azure widget", confidence: 0.7, evidence: "Azure widget in frame" },
    { label: "Neutral frame", confidence: 0.6, evidence: "Neutral frame in frame" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
      label,
      confidence,
      evidenceIds: ["vision"],
    })),
  });
  job.subject = "Metamorphic target check";
  job.body = "Покрась this azure.";

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "ambiguous");
  assert.ok(result.resolvedIntent.target.candidates.length >= 2);
});

test("English property-only deictic request remains ambiguous", () => {
  const storedCandidates = [
    { label: "Azure widget", confidence: 0.7, evidence: "Azure widget in frame" },
    { label: "Neutral frame", confidence: 0.6, evidence: "Neutral frame in frame" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
      label,
      confidence,
      evidenceIds: ["vision"],
    })),
  });
  job.subject = "Color selection";
  job.body = "Paint this azure.";

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "ambiguous");
  assert.equal(result.resolvedIntent.blocker.kind, "target_ambiguity");
  assert.deepEqual(result.resolvedIntent.blocker.choices, ["Azure widget", "Neutral frame"]);
  assert.equal(result.zone, "yellow");
  assert.equal(result.route, "needs_info");
  assert.equal(result.product, null);
  assert.deepEqual(result.estimates, []);
  assert.equal(result.commitment, "none");
});

test("preserves a raw resolved multiword target under a demonstrative", () => {
  const storedCandidates = [
    { label: "Белый модуль", confidence: 0.7, evidence: "Белый модуль в кадре" },
    { label: "Нейтральная рамка", confidence: 0.6, evidence: "Нейтральная рамка в кадре" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
      label,
      confidence,
      evidenceIds: ["vision"],
    })),
  });
  job.subject = "Выбор цели";
  job.body = "Покрасьте этот белый модуль.";
  draft.resolvedIntent.target = {
    state: "resolved",
    label: "Белый модуль",
    evidenceIds: ["vision"],
  };
  draft.resolvedIntent.blocker = null;

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "resolved");
  assert.equal(result.resolvedIntent.target.label, "Белый модуль");
  assert.equal(result.resolvedIntent.blocker, null);
});

test("preserves a raw resolved English single-token target under a demonstrative", () => {
  const storedCandidates = [
    { label: "Widget", confidence: 0.7, evidence: "Widget in frame" },
    { label: "Frame", confidence: 0.6, evidence: "Frame in frame" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
      label,
      confidence,
      evidenceIds: ["vision"],
    })),
  });
  job.subject = "Target selection";
  job.body = "Paint this widget.";
  draft.resolvedIntent.target = {
    state: "resolved",
    label: "Widget",
    evidenceIds: ["vision"],
  };
  draft.resolvedIntent.blocker = null;

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "resolved");
  assert.equal(result.resolvedIntent.target.label, "Widget");
  assert.equal(result.resolvedIntent.blocker, null);
});

test("preserves a raw resolved English multiword target under a demonstrative", () => {
  const storedCandidates = [
    { label: "Azure widget", confidence: 0.7, evidence: "Azure widget in frame" },
    { label: "Neutral frame", confidence: 0.6, evidence: "Neutral frame in frame" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
      label,
      confidence,
      evidenceIds: ["vision"],
    })),
  });
  job.subject = "Target selection";
  job.body = "Paint this azure widget.";
  draft.resolvedIntent.target = {
    state: "resolved",
    label: "Azure widget",
    evidenceIds: ["vision"],
  };
  draft.resolvedIntent.blocker = null;

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "resolved");
  assert.equal(result.resolvedIntent.target.label, "Azure widget");
  assert.equal(result.resolvedIntent.blocker, null);
});

test("does not override a raw resolved primary target with the deictic guard", () => {
  const storedCandidates = [
    { label: "Azure widget", confidence: 0.7, evidence: "Azure widget in frame" },
    { label: "Neutral frame", confidence: 0.6, evidence: "Neutral frame in frame" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
      label,
      confidence,
      evidenceIds: ["vision"],
    })),
  });
  job.subject = "Target selection";
  job.body = "Paint this azure.";
  draft.resolvedIntent.target = {
    state: "resolved",
    label: "Azure widget",
    evidenceIds: ["vision"],
  };
  draft.resolvedIntent.blocker = null;

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "resolved");
  assert.equal(result.resolvedIntent.target.label, "Azure widget");
  assert.equal(result.resolvedIntent.blocker, null);
});

test("preserves a raw resolved single-token target under a demonstrative", () => {
  const storedCandidates = [
    { label: "Модуль", confidence: 0.7, evidence: "Видимый модуль" },
    { label: "Рамка", confidence: 0.6, evidence: "Видимая рамка" },
  ];
  const { job, draft } = visionAmbiguousCase({
    storedCandidates,
    primaryCandidates: storedCandidates.map(({ label, confidence }) => ({
      label,
      confidence,
      evidenceIds: ["vision"],
    })),
  });
  job.subject = "Выбор цели";
  job.body = "Покрасьте этот модуль.";
  draft.resolvedIntent.target = {
    state: "resolved",
    label: "Модуль",
    evidenceIds: ["vision"],
  };
  draft.resolvedIntent.blocker = null;

  const result = normalizeV2AgentResult(draft, demoData, job);

  assert.equal(result.resolvedIntent.target.state, "resolved");
  assert.equal(result.resolvedIntent.target.label, "Модуль");
  assert.equal(result.resolvedIntent.blocker, null);
});
