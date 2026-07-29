import demoData from "@/data/paint-demo.json";
import {
  asksCompatibility,
  asksPaymentAfterDelivery,
  explicitSkuFromText,
  hasColor,
  hasSpecialTerms,
  hasUsableEnvironment,
  matchProduct,
  orderFactsFromText,
  quantityFromText,
  quotedUnitPrices,
} from "@/lib/order-facts.mjs";

export type OrderInput = {
  subject: string;
  body: string;
  company?: string;
  website?: string;
  attachment?: {
    name: string;
    src: string;
    alt: string;
  } | null;
};

type BaseProduct = (typeof demoData.products)[number];
type DemoProduct = BaseProduct & {
  stockRevision?: number;
  stockUpdatedAt?: string;
};
type DemoMarketItem = (typeof demoData.market)[number];
type DemoCompanyProfile = (typeof demoData.companyProfiles)[number];
type DemoIndustry = (typeof demoData.industries)[number];
type DemoRules = typeof demoData.rules;
type FenceFacts = Omit<
  NonNullable<ReturnType<typeof orderFactsFromText>["fence"]>,
  "material"
> & {
  material: "дерево" | "металл" | "неясно";
};

export type DemoCatalogSnapshot = {
  products?: DemoProduct[];
  market?: DemoMarketItem[];
  companyProfiles?: DemoCompanyProfile[];
  industries?: DemoIndustry[];
  rules?: Partial<DemoRules>;
  version?: number | string;
  stockRevision?: number | string;
  capturedAt?: string;
};

export type AgentOption = {
  id: string;
  title: string;
  rationale: string;
  tradeoff: string;
  reply: string;
};

export type DecisionBasis = {
  fact: string;
  source: string;
  checkedAt: string;
  stockVersion?: string;
};

export type FenceCalculation = {
  kind: "fence-area";
  material: "дерево" | "металл";
  lengthM: number | null;
  heightM: number | null;
  areaPerSideM2: number;
  sides: number;
  paintAreaM2: number;
  coverageKgPerM2PerCoat: number;
  coats: number;
  reservePercent: number;
  estimatedKg: number;
  packageKg: number;
  packages: number;
  roundedKg: number;
  explanation: string;
};

export type AgentResult = {
  zone: "green" | "yellow" | "red";
  decision: "quote" | "clarify" | "escalate";
  route: "ready" | "needs_info" | "manager";
  confidence: number;
  understood: string[];
  missing: string[];
  product: {
    sku: string;
    name: string;
    stockKg: number;
    requestedKg: number;
    pricePerKg: number;
    total: number;
    replenishmentDays: number;
  } | null;
  calculation?: FenceCalculation;
  market: {
    checked: boolean;
    summary: string;
    position: string;
    profitOpportunity: string;
    items: Array<{
      competitor: string;
      pricePerKg: number;
      deliveryDays: number;
      checkedAt: string;
    }>;
  };
  research?: {
    checked: boolean;
    summary: string;
    sources: Array<{
      title: string;
      url: string;
      checkedAt: string;
      fact: string;
    }>;
  };
  businessContext: string;
  zoneReason: string;
  managerNote: string;
  options: AgentOption[];
  reply: {
    subject: string;
    body: string;
  };
  checks: string[];
  sources: string[];
  decisionBasis: DecisionBasis[];
  review: {
    model: string;
    verdict: string;
    notes: string[];
  };
};

type ResolvedCatalog = {
  products: DemoProduct[];
  market: DemoMarketItem[];
  companyProfiles: DemoCompanyProfile[];
  industries: DemoIndustry[];
  rules: DemoRules;
  version?: number | string;
  stockRevision?: number | string;
  capturedAt?: string;
};

const money = new Intl.NumberFormat("ru-RU");
const decimal = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 2,
});
const today = new Intl.DateTimeFormat("ru-RU").format(new Date());

function validNumber(value: unknown, fallback: number, allowZero = true) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    (allowZero ? value >= 0 : value > 0)
    ? value
    : fallback;
}

function resolveCatalog(
  snapshot?: DemoCatalogSnapshot | null,
): ResolvedCatalog {
  const suppliedProducts = Array.isArray(snapshot?.products)
    ? snapshot.products
    : [];
  const suppliedBySku = new Map(
    suppliedProducts
      .filter((product) => product && typeof product.sku === "string")
      .map((product) => [product.sku, product]),
  );
  const products = demoData.products.map((base) => {
    const supplied = suppliedBySku.get(base.sku);
    if (!supplied) return { ...base };

    return {
      ...base,
      ...supplied,
      stockKg: validNumber(supplied.stockKg, base.stockKg),
      pricePerKg: validNumber(supplied.pricePerKg, base.pricePerKg, false),
      minPricePerKg: validNumber(
        supplied.minPricePerKg,
        base.minPricePerKg,
        false,
      ),
      packKg: validNumber(supplied.packKg, base.packKg, false),
      coverageKgPerM2PerCoat: validNumber(
        supplied.coverageKgPerM2PerCoat,
        base.coverageKgPerM2PerCoat,
        false,
      ),
      recommendedCoats: validNumber(
        supplied.recommendedCoats,
        base.recommendedCoats,
        false,
      ),
      replenishmentDays: validNumber(
        supplied.replenishmentDays,
        base.replenishmentDays,
      ),
      stockRevision:
        typeof supplied.stockRevision === "number"
          ? supplied.stockRevision
          : undefined,
      stockUpdatedAt:
        typeof supplied.stockUpdatedAt === "string"
          ? supplied.stockUpdatedAt
          : undefined,
    };
  });
  const suppliedRules = snapshot?.rules;

  return {
    products,
    market: Array.isArray(snapshot?.market)
      ? snapshot.market
      : demoData.market,
    companyProfiles: Array.isArray(snapshot?.companyProfiles)
      ? snapshot.companyProfiles
      : demoData.companyProfiles,
    industries: Array.isArray(snapshot?.industries)
      ? snapshot.industries
      : demoData.industries,
    rules: {
      ...demoData.rules,
      ...(suppliedRules ?? {}),
      targetMarginPercent: validNumber(
        suppliedRules?.targetMarginPercent,
        demoData.rules.targetMarginPercent,
      ),
      maxDiscountWithoutApprovalPercent: validNumber(
        suppliedRules?.maxDiscountWithoutApprovalPercent,
        demoData.rules.maxDiscountWithoutApprovalPercent,
      ),
      marketReviewPercent: validNumber(
        suppliedRules?.marketReviewPercent,
        demoData.rules.marketReviewPercent,
      ),
      calculationReservePercent: validNumber(
        suppliedRules?.calculationReservePercent,
        demoData.rules.calculationReservePercent,
      ),
      maxAgentSteps: validNumber(
        suppliedRules?.maxAgentSteps,
        demoData.rules.maxAgentSteps,
        false,
      ),
      zones: {
        ...demoData.rules.zones,
        ...(suppliedRules?.zones ?? {}),
      },
      plainPolicy: Array.isArray(suppliedRules?.plainPolicy)
        ? suppliedRules.plainPolicy
        : demoData.rules.plainPolicy,
    },
    version: snapshot?.version,
    stockRevision: snapshot?.stockRevision,
    capturedAt: snapshot?.capturedAt,
  };
}

function humanDate(value?: string) {
  if (!value) return today;
  if (/^\d{1,2}\.\d{1,2}\.\d{4}/.test(value)) return value;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(parsed);
}

function industryFor(text: string, industries: DemoIndustry[]) {
  const lowered = text.toLowerCase();
  if (/(машиностро|волгамаш|завод|машин|оборудован)/.test(lowered)) {
    return industries[1] ?? null;
  }
  if (/(строит|строй|объект|подряд|девелоп|ремонт|офис)/.test(lowered)) {
    return industries[2] ?? null;
  }
  if (/(склад|логистическ|терминал|покрыти[ея]\s+пола)/.test(lowered)) {
    return industries[3] ?? null;
  }
  if (/(металлоконструк|антикорроз|корроз)/.test(lowered)) {
    return industries[0] ?? null;
  }
  return null;
}

function productForFence(
  material: "дерево" | "металл" | "неясно",
  products: DemoProduct[],
) {
  if (material === "дерево") {
    return (
      products.find((product) => product.substrates.includes("дерево")) ?? null
    );
  }
  if (material === "металл") {
    return (
      products.find(
        (product) =>
          product.sku === "КР-001" && product.substrates.includes("металл"),
      ) ??
      products.find((product) => product.substrates.includes("металл")) ??
      null
    );
  }
  return null;
}

function fenceCalculation(
  fence: FenceFacts,
  product: DemoProduct | null,
  reservePercent: number,
): FenceCalculation | undefined {
  if (
    !product ||
    fence.material === "неясно" ||
    !fence.areaPerSideM2 ||
    !fence.paintAreaM2 ||
    !fence.sides
  ) {
    return undefined;
  }

  const coats = product.recommendedCoats;
  const estimatedKg =
    fence.paintAreaM2 *
    product.coverageKgPerM2PerCoat *
    coats *
    (1 + reservePercent / 100);
  const packages = Math.ceil(estimatedKg / product.packKg);
  const roundedKg = packages * product.packKg;

  return {
    kind: "fence-area",
    material: fence.material,
    lengthM: fence.lengthM,
    heightM: fence.heightM,
    areaPerSideM2: fence.areaPerSideM2,
    sides: fence.sides,
    paintAreaM2: fence.paintAreaM2,
    coverageKgPerM2PerCoat: product.coverageKgPerM2PerCoat,
    coats,
    reservePercent,
    estimatedKg: Number(estimatedKg.toFixed(2)),
    packageKg: product.packKg,
    packages,
    roundedKg,
    explanation: `${decimal.format(fence.paintAreaM2)} м² × ${coats} слоя × ${decimal.format(
      product.coverageKgPerM2PerCoat,
    )} кг/м² + ${reservePercent}% запаса = ${decimal.format(
      estimatedKg,
    )} кг. Берём ${packages} ${packages === 1 ? "упаковку" : packages < 5 ? "упаковки" : "упаковок"} по ${decimal.format(
      product.packKg,
    )} кг: ${decimal.format(roundedKg)} кг.`,
  };
}

function marketView(product: DemoProduct | null, items: DemoMarketItem[]) {
  if (!product) {
    return {
      checked: false,
      summary: "Сравнение цен начнётся после подбора краски.",
      position: "Краска пока подбирается.",
      profitOpportunity:
        "После подбора агент сравнит нашу цену с ценами других поставщиков.",
      items: [] as DemoMarketItem[],
    };
  }

  const comparable = items.filter(
    (item) => item.category === product.category,
  );
  if (!comparable.length) {
    const priceRoom = product.pricePerKg - product.minPricePerKg;
    return {
      checked: true,
      summary: `Цена ${money.format(
        product.pricePerKg,
      )} ₽/кг взята из карточки товара. Минимальная цена с прибылью — ${money.format(
        product.minPricePerKg,
      )} ₽/кг. Разница ${money.format(priceRoom)} ₽/кг сохраняет прибыль завода.`,
      position: `Цена ${money.format(
        product.pricePerKg,
      )} ₽/кг подтверждена карточкой товара.`,
      profitOpportunity:
        "После обновления цен других поставщиков агент проверит, можно ли заработать на заказе больше.",
      items: comparable,
    };
  }

  const prices = comparable.map((item) => item.pricePerKg);
  const marketMax = Math.max(...prices);
  const marketAverage =
    prices.reduce((sum, price) => sum + price, 0) / prices.length;
  const difference = product.pricePerKg - marketAverage;
  const closeToAverage =
    Math.abs(difference) <= Math.max(5, marketAverage * 0.02);

  let position: string;
  if (closeToAverage) {
    const roundedDifference = Math.round(Math.abs(difference));
    position =
      roundedDifference === 0
        ? `Цена совпадает со средней: ${money.format(
            product.pricePerKg,
          )} ₽/кг.`
        : `Цена близка к рынку: ${money.format(product.pricePerKg)} ₽/кг, на ${money.format(
            roundedDifference,
          )} ₽ ${difference > 0 ? "выше" : "ниже"} средней цены других поставщиков. Товар уже на складе, срок подтверждён.`;
  } else if (difference < 0) {
    position = `Наша цена ${money.format(
      product.pricePerKg,
    )} ₽/кг на ${money.format(
      Math.round(Math.abs(difference)),
    )} ₽ ниже средней цены других поставщиков.`;
  } else {
    position = `Наша цена ${money.format(
      product.pricePerKg,
    )} ₽/кг на ${money.format(
      Math.round(difference),
    )} ₽ выше средней цены других поставщиков. Весь объём есть на складе, срок подтверждён.`;
  }

  const priceRoom = marketMax - product.pricePerKg;
  const profitOpportunity =
    priceRoom > 0
      ? `В следующем предложении можно попробовать цену до ${money.format(
          marketMax,
        )} ₽/кг: другие поставщики уже предлагают такую цену. Журнал покажет, как изменится результат.`
      : "Наша цена одна из самых высоких среди показанных. Дополнительную прибыль могут дать крупный заказ или удобные условия поставки.";

  return {
    checked: true,
    summary: `${position} ${profitOpportunity}`,
    position,
    profitOpportunity,
    items: comparable,
  };
}

function stockBasis(
  product: DemoProduct,
  requestedKg: number,
  catalog: ResolvedCatalog,
): DecisionBasis {
  const revision =
    product.stockRevision ?? catalog.stockRevision ?? catalog.version;
  return {
    fact:
      requestedKg <= product.stockKg
        ? `Склад подтверждает весь объём: ${money.format(
            requestedKg,
          )} из ${money.format(product.stockKg)} кг.`
        : `Склад подтверждает ${money.format(
            product.stockKg,
          )} из запрошенных ${money.format(requestedKg)} кг.`,
    source: "Живой склад",
    checkedAt: humanDate(product.stockUpdatedAt ?? catalog.capturedAt),
    stockVersion:
      revision === undefined
        ? "Исходное обновление склада"
        : `Обновление склада №${revision}`,
  };
}

function marketBasis(view: ReturnType<typeof marketView>): DecisionBasis | null {
  if (!view.items.length) return null;
  const latest = view.items.at(-1);
  const comparedPrices = view.items
    .map(
      (item) =>
        `${item.competitor} — ${money.format(item.pricePerKg)} ₽/кг`,
    )
    .join("; ");
  return {
    fact: `${view.position} Для сравнения: ${comparedPrices}.`,
    source: "Учебная таблица цен других поставщиков",
    checkedAt: latest?.checkedAt ?? today,
  };
}

function profileFor(
  inn: string,
  companyProfiles: DemoCompanyProfile[],
): DemoCompanyProfile | null {
  return inn
    ? companyProfiles.find((profile) => profile.inn === inn) ?? null
    : null;
}

function researchFor(profile: DemoCompanyProfile | null) {
  if (!profile) {
    return {
      checked: false,
      summary:
        "Агент изучит компанию, когда её масштаб поможет выбрать предложение.",
      sources: [],
    };
  }
  return {
    checked: true,
    summary: `${profile.summary} Агент сохранил ссылки и даты проверки каждого факта.`,
    sources: profile.sources,
  };
}

function productResult(
  product: DemoProduct | null,
  requestedKg: number,
) {
  return product
    ? {
        sku: product.sku,
        name: product.name,
        stockKg: product.stockKg,
        requestedKg,
        pricePerKg: product.pricePerKg,
        total: requestedKg * product.pricePerKg,
        replenishmentDays: product.replenishmentDays,
      }
    : null;
}

function clarificationQuestion(item: string) {
  const questions: Record<string, string> = {
    "материал забора":
      "Из чего сделан забор: из дерева, металла или другого материала?",
    "размер забора":
      "Напишите длину и среднюю высоту забора. Можно указать готовую площадь.",
    "стороны покраски": "Красим одну сторону забора или обе?",
    "цвет забора": "Какой цвет хотите получить?",
    "объём заказа": "Сколько килограммов краски нужно?",
    "условия эксплуатации": "Где будете красить: на улице или в помещении?",
    "цвет или номер RAL":
      "Какой цвет нужен? Если знаете номер по каталогу RAL, добавьте его.",
    "назначение краски": "Что и из какого материала будете красить?",
    "совместимость покрытия":
      "Что будет попадать на окрашенную поверхность: масло, вода или моющие средства? Будет ли по ней ездить техника?",
    "товар из каталога":
      "Напишите код с упаковки или опишите, что будете красить.",
  };
  return questions[item] ?? `Уточните, пожалуйста: ${item}.`;
}

function replyWithQuestions(
  missing: string[],
  isFence: boolean,
  mentionsPhoto: boolean,
  product: DemoProduct | null,
) {
  const intro = isFence
    ? mentionsPhoto
      ? "Фото приложено к заявке. Подберём краску для забора и рассчитаем количество."
      : "Задачу поняли: нужно подобрать краску для забора."
    : "Запрос принят. Соберём точный подбор и расчёт.";
  const questions = missing
    .map((item) => `— ${clarificationQuestion(item)}`)
    .join("\n");
  return {
    subject: product
      ? `Короткое уточнение по заказу: ${product.name}`
      : isFence
        ? "Уточнение для расчёта краски на забор"
        : "Короткое уточнение по заказу краски",
    body: `Добрый день!\n\n${intro}\n\n${questions}\n\nПо ответу рассчитаем расход, округлим до целых упаковок и проверим наличие.`,
  };
}

export function buildDemoResult(
  input: OrderInput,
  snapshot?: DemoCatalogSnapshot | null,
): AgentResult {
  const catalog = resolveCatalog(snapshot);
  const fullText = `${input.subject}\n${input.body}`;
  const businessText = `${fullText}\n${input.company ?? ""}`;
  const hasAttachedPhoto = Boolean(input.attachment?.src);
  const facts = orderFactsFromText(fullText);
  const fence: FenceFacts | null = facts.fence
    ? {
        ...facts.fence,
        material:
          facts.fence.material === "дерево" ||
          facts.fence.material === "металл"
            ? facts.fence.material
            : "неясно",
      }
    : null;
  const explicitRequestedKg = quantityFromText(fullText);
  const matchedProduct = matchProduct(fullText, catalog.products);
  const product =
    matchedProduct ??
    (fence ? productForFence(fence.material, catalog.products) : null);
  const calculation = fence
    ? fenceCalculation(
        fence,
        product,
        catalog.rules.calculationReservePercent,
      )
    : undefined;
  const requestedKg = explicitRequestedKg || calculation?.roundedKg || 0;
  const missing: string[] = [];
  const unknownSku = Boolean(explicitSkuFromText(fullText)) && !product;

  if (fence) {
    if (fence.material === "неясно") missing.push("материал забора");
    if (!fence.areaPerSideM2) missing.push("размер забора");
    if (!fence.sides) missing.push("стороны покраски");
    if (!hasColor(fullText)) missing.push("цвет забора");
  } else {
    if (unknownSku) {
      missing.push("товар из каталога");
    } else if (!product) {
      missing.push("назначение краски");
    }
    if (!requestedKg) missing.push("объём заказа");
    if (!hasUsableEnvironment(fullText)) {
      missing.push("условия эксплуатации");
    }
    if (!hasColor(fullText)) {
      missing.push("цвет или номер RAL");
    }
  }
  if (asksCompatibility(fullText)) {
    missing.push("совместимость покрытия");
  }

  const hardRed =
    Boolean(product) &&
    requestedKg > 0 &&
    (requestedKg > (product?.stockKg ?? 0) ||
      hasSpecialTerms(fullText) ||
      quotedUnitPrices(fullText).some(
        (price) => price < (product?.minPricePerKg ?? 0),
      ));
  const fenceNeedsDetails = Boolean(
    fence &&
      (fence.material === "неясно" ||
        !fence.areaPerSideM2 ||
        !fence.sides),
  );
  const profile = profileFor(facts.inn, catalog.companyProfiles);
  const baseMarketView = marketView(product, catalog.market);
  const likelyTrialOrder = Boolean(
    profile &&
      product &&
      requestedKg > 0 &&
      requestedKg <= product.packKg * 2,
  );
  const trialProfitOpportunity =
    likelyTrialOrder && product
      ? `Для первой небольшой партии сохраняем цену ${money.format(
          product.pricePerKg,
        )} ₽/кг. Сразу спрашиваем, что клиент проверяет и какой объём понадобится после успешной пробы.`
      : "";
  const view =
    trialProfitOpportunity
      ? {
          ...baseMarketView,
          summary: `${baseMarketView.position} ${trialProfitOpportunity}`,
          profitOpportunity: trialProfitOpportunity,
        }
      : baseMarketView;
  const research = researchFor(profile);
  const industry = industryFor(businessText, catalog.industries);
  const understood = [
    input.company ? `Компания: ${input.company}` : "Компания: уточним при заказе",
    ...(facts.inn ? [`ИНН: ${facts.inn}`] : []),
    fence
      ? "Задача: покрасить забор"
      : product
        ? `Краска: ${product.name}`
        : "Задача: подобрать краску",
    ...(hasAttachedPhoto ? ["Фотография из заявки получена"] : []),
    ...(calculation
      ? [
          `Площадь покраски: ${decimal.format(calculation.paintAreaM2)} м²`,
          `Расчёт: ${calculation.packages} ${calculation.packages === 1 ? "упаковка" : calculation.packages < 5 ? "упаковки" : "упаковок"}, ${decimal.format(
            calculation.roundedKg,
          )} кг`,
        ]
      : requestedKg
        ? [`Объём: ${money.format(requestedKg)} кг`]
        : []),
  ];

  if (
    !product ||
    fenceNeedsDetails ||
    (missing.length > 0 && !hardRed)
  ) {
    const decisionBasis: DecisionBasis[] = [
      {
        fact: fence
          ? "Клиент хочет покрасить забор и просит помочь с подбором и количеством."
          : "Агент сохранил задачу клиента и все уже известные детали.",
        source: "Письмо клиента",
        checkedAt: today,
      },
      ...(product && requestedKg
        ? [stockBasis(product, requestedKg, catalog)]
        : []),
    ];
    const visibleMarketBasis = marketBasis(view);
    if (visibleMarketBasis && product) decisionBasis.push(visibleMarketBasis);

    return {
      zone: "yellow",
      decision: "clarify",
      route: "needs_info",
      confidence: hasAttachedPhoto ? 0.88 : 0.8,
      understood,
      missing,
      product: productResult(product, requestedKg),
      ...(calculation ? { calculation } : {}),
      market: view,
      research,
      businessContext: fence
        ? "Фото дополняет заявку и помогает обсудить состояние поверхности. Материал, размеры и стороны покраски подтверждает клиент; эти данные определяют краску и количество упаковок."
        : product
          ? `Краска «${product.name}» найдена в каталоге. Короткий ответ клиента завершит расчёт.`
          : "Агент сохранил известные факты и подготовил самый короткий путь к точному предложению.",
      zoneReason: fence
        ? hasAttachedPhoto
          ? "Фото приложено к заявке. Клиент подтвердит материал и размеры, затем агент рассчитает расход и упаковки."
          : "Клиент описал задачу своими словами. После короткого ответа о материале и размерах агент рассчитает расход и упаковки."
        : unknownSku
          ? "Код краски нужно сверить с каталогом. Описание поверхности поможет сразу найти подходящую краску."
          : "Агент понял основную потребность и спрашивает только данные, которые меняют подбор или расчёт.",
      managerNote:
        "Ответ клиента продолжит ту же карточку: агент дополнит факты, пересчитает заказ и снова проверит склад.",
      options: [],
      reply: replyWithQuestions(
        missing,
        Boolean(fence),
        hasAttachedPhoto,
        product,
      ),
      checks: [
        "Потребность клиента сохранена в карточке",
        "Вопросы влияют на подбор или расчёт",
        "Письмо собрано по правилам завода",
      ],
      sources: [
        "Письмо клиента",
        ...(product ? ["Каталог товаров", "Живой склад"] : []),
        "Правила продаж",
      ],
      decisionBasis,
      review: {
        model: "Правила стенда",
        verdict: "Собраны вопросы для точного расчёта",
        notes: [
          "Известные факты сохранены",
          "Следующий шаг готов",
          "Клиенту легко ответить",
        ],
      },
    };
  }

  const total = requestedKg * product.pricePerKg;
  const shortage = requestedKg > product.stockKg;
  const specialTerms = hasSpecialTerms(fullText);
  const paymentAfterDelivery = asksPaymentAfterDelivery(fullText);
  const customerPrices = quotedUnitPrices(fullText);
  const belowMinimum = customerPrices.some(
    (price) => price < product.minPricePerKg,
  );
  const customerPrice = customerPrices.find(
    (price) => price < product.minPricePerKg,
  );
  const standardBusinessContext = industry
    ? `Клиенту важно: ${industry.risk}. Что предлагает агент: ${industry.play}.`
    : `Подбор опирается на свойства краски: ${product.features.join(", ")}.`;
  const businessContext = profile
    ? likelyTrialOrder
      ? `${profile.summary} Агент предполагает: пробная партия на ${money.format(
          requestedKg,
        )} кг нужна клиенту для проверки краски перед основной закупкой. Агент спросит, какие свойства проверяют и какой объём понадобится дальше.`
      : `${profile.summary} Заказ на ${money.format(
          requestedKg,
        )} кг равен ${money.format(
          Math.ceil(requestedKg / product.packKg),
        )} упаковкам. Агент уточнит график следующих закупок, чтобы заранее зарезервировать производство и поставку.`
    : standardBusinessContext;
  const stockDecisionBasis = stockBasis(product, requestedKg, catalog);
  const decisionBasis: DecisionBasis[] = [
    stockDecisionBasis,
    {
      fact: `Цена ${money.format(
        product.pricePerKg,
      )} ₽/кг; минимальная цена, при которой завод зарабатывает, — ${money.format(
        product.minPricePerKg,
      )} ₽/кг. По этой цене завод зарабатывает на заказе.`,
      source: "Карточка товара и второе правило о цене",
      checkedAt: today,
    },
    {
      fact:
        "Письмо предлагает только подтверждённый складом объём. Особые условия передаются руководителю вместе с готовыми вариантами.",
      source: "Три правила продаж",
      checkedAt: today,
    },
  ];
  const comparableBasis = marketBasis(view);
  if (comparableBasis) decisionBasis.push(comparableBasis);
  if (calculation) {
    decisionBasis.unshift({
      fact: calculation.explanation,
      source: "Расчёт расхода и упаковок",
      checkedAt: today,
    });
  }
  if (profile) {
    decisionBasis.push(
      ...profile.sources.map((source) => ({
        fact: source.fact,
        source: source.title,
        checkedAt: source.checkedAt,
      })),
    );
  }

  if (shortage || specialTerms || belowMinimum) {
    const remainder = Math.max(0, requestedKg - product.stockKg);
    const compatibleAlternative = catalog.products.find(
      (candidate) =>
        product.analogues.includes(candidate.sku) &&
        candidate.stockKg >= requestedKg,
    );
    const colorRequest = hasColor(fullText)
      ? "После выбора варианта зарезервируем доступную партию."
      : "Назовите точный цвет, и мы зарезервируем доступную партию.";
    const firstReply = shortage
      ? `Добрый день!\n\nПодобрали «${product.name}». Готовы отгрузить ${money.format(
          product.stockKg,
        )} кг сейчас и ${money.format(remainder)} кг через ${
          product.replenishmentDays
        } дней. Цена — ${money.format(product.pricePerKg)} ₽/кг. ${
          paymentAfterDelivery
            ? "Порядок оплаты закрепим в выбранном варианте. "
            : ""
        }${colorRequest}`
      : `Добрый день!\n\nНа складе есть ${money.format(
          requestedKg,
        )} кг краски «${product.name}» по цене ${money.format(
          product.pricePerKg,
        )} ₽/кг. Руководитель выбирает подходящую цену и порядок оплаты.`;
    const options: AgentOption[] = shortage
      ? [
          {
            id: "две-поставки",
            title: "Начать работу с первой партией",
            rationale: `${money.format(
              product.stockKg,
            )} кг отправим сейчас, ${money.format(remainder)} кг — через ${
              product.replenishmentDays
            } дней. Клиент начинает работу раньше.`,
            tradeoff: "Вторая партия потребует отдельной доставки.",
            reply: firstReply,
          },
          ...(paymentAfterDelivery
            ? [
                {
                  id: "оплата-по-партиям",
                  title: "Разделить оплату по партиям",
                  rationale: `${money.format(
                    product.stockKg,
                  )} кг клиент оплачивает перед первой отгрузкой. Для оставшихся ${money.format(
                    remainder,
                  )} кг руководитель согласует оплату после поставки.`,
                  tradeoff:
                    "Договор зафиксирует сумму и срок оплаты для каждой партии.",
                  reply: `Добрый день!\n\nПредлагаем поставить заказ двумя партиями и закрепить оплату отдельно для каждой. Первые ${money.format(
                    product.stockKg,
                  )} кг готовы отгрузить со склада, оставшиеся ${money.format(
                    remainder,
                  )} кг — через ${
                    product.replenishmentDays
                  } дней. Для второй партии рассмотрим оплату через 90 дней после поставки.`,
                },
              ]
            : []),
          ...(compatibleAlternative
            ? [
                {
                  id: "замена-краски",
                  title: `Закрыть объём краской «${compatibleAlternative.name}»`,
                  rationale: `${money.format(
                    requestedKg,
                  )} кг есть на складе. Технолог подтвердит применение перед резервом.`,
                  tradeoff: `Цена составит ${money.format(
                    compatibleAlternative.pricePerKg,
                  )} ₽/кг.`,
                  reply: `Добрый день!\n\nМожем закрыть весь объём краской «${compatibleAlternative.name}» по цене ${money.format(
                    compatibleAlternative.pricePerKg,
                  )} ₽/кг. Весь объём есть на складе. Перед резервом технолог подтвердит применение для вашей поверхности.`,
                },
              ]
            : []),
          {
            id: "приоритет-производства",
            title: "Добавить краску в ближайший выпуск",
            rationale:
              "Зарезервировать доступную партию и добавить недостающий объём в ближайший выпуск.",
            tradeoff: "Производство подтвердит дату второй отгрузки.",
            reply: `Добрый день!\n\nЗарезервируем ${money.format(
              product.stockKg,
            )} кг на складе и поставим оставшиеся ${money.format(
              remainder,
            )} кг в ближайший выпуск. После подтверждения заказа направим дату второй отгрузки.`,
          },
          {
            id: "график-клиента",
            title: "Собрать удобный график",
            rationale:
              "Узнать объём для старта работ и нужную дату второй партии.",
            tradeoff: "Клиент ответит на два коротких вопроса.",
            reply:
              "Добрый день!\n\nНапишите, какой объём нужен для начала работ и к какой дате потребуется остальная краска. По ответу закрепим удобный график поставки.",
          },
        ].slice(0, 3)
      : paymentAfterDelivery
        ? [
            {
              id: "оплата-до-отгрузки",
              title: "Сохранить цену при оплате до отгрузки",
              rationale:
                "Клиент получает весь подтверждённый объём и твёрдую дату отгрузки.",
              tradeoff:
                "Клиент меняет желаемый порядок оплаты.",
              reply: `Добрый день!\n\nНа складе есть ${money.format(
                requestedKg,
              )} кг краски «${product.name}». Сохраним цену ${money.format(
                product.pricePerKg,
              )} ₽/кг при оплате до отгрузки и сразу закрепим дату поставки.`,
            },
            {
              id: "оплата-за-план",
              title: "Разрешить оплату после поставки за план закупок",
              rationale:
                "Клиент получает желаемый порядок оплаты и заранее закрепляет объём следующих поставок.",
              tradeoff:
                "Потребуется согласовать объём на квартал и условия договора.",
              reply: `Добрый день!\n\nГотовы рассмотреть оплату после поставки, если заранее согласуем объём закупок на квартал. Цена текущей партии — ${money.format(
                product.pricePerKg,
              )} ₽/кг. Направьте ожидаемый график, и мы подготовим условия.`,
            },
            {
              id: "оплата-поэтапно",
              title: "Разделить оплату на два этапа",
              rationale:
                "Клиент оплачивает часть до отгрузки, остаток — после получения товара.",
              tradeoff:
                "Руководитель закрепит доли и срок второй оплаты в договоре.",
              reply: `Добрый день!\n\nПредлагаем разделить оплату на два этапа: часть до отгрузки, остаток после получения товара. Весь объём ${money.format(
                requestedKg,
              )} кг есть на складе. После согласования долей закрепим дату поставки.`,
            },
          ]
        : [
          {
            id: "обычные-условия",
            title: "Предложить обычные условия",
            rationale:
              "Подтвердить наличие, цену и обычный порядок оплаты и поставки.",
            tradeoff: "Клиент оценит предложение по действующим условиям.",
            reply: firstReply,
          },
          {
            id: "условие-за-объём",
            title: "Дать лучшую цену за план закупок",
            rationale:
              "Клиент заранее согласует объём на квартал и вносит предоплату.",
            tradeoff: "Клиент заранее согласует объём закупок.",
            reply: `Добрый день!\n\nГотовы обсудить лучшую цену, если согласуем закупки на квартал и предоплату. Обычная цена текущей партии — ${money.format(
              product.pricePerKg,
            )} ₽/кг.`,
          },
          {
            id: "приоритет-клиента",
            title: "Спросить, что важнее клиенту",
            rationale:
              "Выяснить, что важнее: срок, цена или порядок оплаты, и собрать выполнимое предложение.",
            tradeoff: "Понадобится один короткий ответ клиента.",
            reply:
              "Добрый день!\n\nЧто для вас важнее в этой поставке: срок, цена или порядок оплаты? По ответу подготовим подходящий вариант.",
          },
          ];

    return {
      zone: "red",
      decision: "escalate",
      route: "manager",
      confidence: 0.94,
      understood,
      missing: missing.slice(0, 1),
      product: productResult(product, requestedKg),
      ...(calculation ? { calculation } : {}),
      market: view,
      research,
      businessContext,
      zoneReason: shortage
        ? paymentAfterDelivery
          ? `Склад подтверждает ${money.format(
              product.stockKg,
            )} кг сейчас и ${money.format(
              remainder,
            )} кг после пополнения. Клиент просит оплату через 90 дней после поставки. Руководитель выбирает график поставки и оплаты.`
          : `Склад подтверждает ${money.format(
              product.stockKg,
            )} кг сейчас. Руководитель выбирает способ закрыть оставшиеся ${money.format(
              remainder,
            )} кг.`
        : belowMinimum
          ? `Клиент предложил ${money.format(
              customerPrice ?? 0,
            )} ₽/кг. Руководитель выбирает условия, при которых завод заработает на заказе, а клиент получит подходящую поставку.`
          : "Агент подготовил три выполнимых варианта по особым условиям клиента.",
      managerNote: profile
        ? likelyTrialOrder
          ? profile.suggestedMove
          : "Уточнить график следующих закупок и заранее согласовать резерв производства и поставки."
        : industry
          ? `Что предлагает агент: ${industry.play}. По этой цене завод зарабатывает на заказе.`
          : "Выберите вариант, который сохраняет срок клиента и заработок завода.",
      options,
      reply: {
        subject: `Предложение по заказу: ${product.name}`,
        body:
          "Агент подготовил варианты и тексты писем. После выбора руководителя карточка станет готова к отправке.",
      },
      checks: [
        "По этой цене завод зарабатывает на заказе",
        shortage
          ? "Склад подтвердил доступную первую партию"
          : "Весь объём подтверждён складом",
        "Письмо собрано по правилам завода",
        view.items.length
          ? "Сравнение цен содержит дату"
          : "Цена сверена с карточкой товара и минимальной ценой с прибылью",
      ],
      sources: [
        "Письмо клиента",
        "Каталог товаров",
        "Живой склад",
        "Правила продаж",
        ...(view.items.length ? ["Цены других поставщиков"] : []),
        ...(profile ? ["Проверенные открытые источники"] : []),
      ],
      decisionBasis,
      review: {
        model: "Правила стенда",
        verdict: "Руководитель получил готовые варианты",
        notes: [
          "Цифры сверены со складом",
          "Каждый вариант можно выполнить",
          "Готовый текст приложен",
        ],
      },
    };
  }

  return {
    zone: "green",
    decision: "quote",
    route: "ready",
    confidence: 0.97,
    understood,
    missing: [],
    product: productResult(product, requestedKg),
    ...(calculation ? { calculation } : {}),
    market: view,
    research,
    businessContext: profile
      ? businessContext
      : `Весь объём доступен. ${standardBusinessContext}`,
    zoneReason: likelyTrialOrder
      ? "Склад подтверждает весь объём. Заказ выглядит пробной партией. Агент спросит, какие свойства краски клиент проверяет и какой объём понадобится после успешной пробы."
      : "Весь объём подтверждён складом. По этой цене завод зарабатывает на заказе. Письмо готово.",
    managerNote: profile
      ? likelyTrialOrder
        ? profile.suggestedMove
        : "Уточнить график следующих закупок и заранее согласовать резерв производства и поставки."
      : view.profitOpportunity,
    options: [],
    reply: {
      subject: `Коммерческое предложение: ${product.name}`,
      body: `Добрый день!\n\nПодтверждаем поставку ${money.format(
        requestedKg,
      )} кг краски «${product.name}» по цене ${money.format(
        product.pricePerKg,
      )} ₽/кг. Стоимость партии — ${money.format(
        total,
      )} ₽ без доставки.\n\nВесь объём есть на складе. После подтверждения заказа зарезервируем партию и направим график отгрузки.${
        calculation
          ? `\n\nРасчёт количества: ${calculation.explanation}`
          : ""
      }${
        likelyTrialOrder
          ? "\n\nПодскажите, какие свойства краски проверяете на первой партии и какой объём планируете после успешной пробы. Подготовим следующую поставку заранее."
          : ""
      }`,
    },
    checks: [
      "По этой цене завод зарабатывает на заказе",
      "Весь объём подтверждён складом",
      "Письмо собрано по правилам завода",
      view.items.length
        ? "Сравнение цен содержит дату"
        : "Цена сверена с карточкой товара и минимальной ценой с прибылью",
    ],
    sources: [
      "Письмо клиента",
      "Каталог товаров",
      "Живой склад",
      "Правила продаж",
      ...(view.items.length ? ["Цены других поставщиков"] : []),
      ...(profile ? ["Проверенные открытые источники"] : []),
    ],
    decisionBasis,
    review: {
      model: "Правила стенда",
      verdict: "Ответ готов к отправке",
      notes: [
        "Цена и объём подтверждены",
        "Сохранено обновление склада",
        "Письмо собрано по правилам",
      ],
    },
  };
}
