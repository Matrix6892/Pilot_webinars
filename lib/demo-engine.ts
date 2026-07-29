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
  businessResult?: string;
};

export type DecisionBasis = {
  fact: string;
  source: string;
  checkedAt: string;
  stockVersion?: string;
};

export type FenceCalculation = {
  kind: "fence-area" | "wall-area" | "floor-area";
  surface: "забор" | "стена" | "пол";
  material:
    | "дерево"
    | "металл"
    | "бетон"
    | "штукатурка"
    | "гипсокартон";
  source: "письмо клиента" | "распознанное фото";
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

type SurfaceFacts = {
  kind: "fence" | "wall" | "floor";
  surface: "забор" | "стена" | "пол";
  material:
    | "дерево"
    | "металл"
    | "бетон"
    | "штукатурка"
    | "гипсокартон"
    | "неясно";
  lengthM: number | null;
  heightM: number | null;
  areaPerSideM2: number | null;
  sides: number | null;
  paintAreaM2: number | null;
  source: "письмо клиента" | "распознанное фото";
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
  material: SurfaceFacts["material"],
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

function decimalFromText(value: string | undefined) {
  const parsed = Number(String(value ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function areaFromText(value: string) {
  const match = value.match(
    /(\d+(?:[.,]\d+)?)\s*(?:м\s*[²2]|кв(?:адратн\p{L}*)?\.?\s*м(?:етр\p{L}*)?|квадратн\p{L}*\s+метр\p{L}*)/iu,
  );
  return decimalFromText(match?.[1]);
}

function dimensionsFromText(value: string) {
  const match = value.match(
    /(\d+(?:[.,]\d+)?)\s*(?:м(?:етр\p{L}*)?\s*)?[×xх]\s*(\d+(?:[.,]\d+)?)\s*м(?:етр\p{L}*)?/iu,
  );
  return {
    lengthM: decimalFromText(match?.[1]),
    heightM: decimalFromText(match?.[2]),
  };
}

function materialForSurface(
  kind: "wall" | "floor",
  value: string,
): SurfaceFacts["material"] {
  if (/гипсокартон|(?:^|[^\p{L}])гкл(?:[^\p{L}]|$)/iu.test(value)) {
    return "гипсокартон";
  }
  if (/штукатур/iu.test(value)) return "штукатурка";
  if (/бетон|стяжк|цемент/iu.test(value)) return "бетон";
  if (kind === "floor" && /дерев|доск|паркет/iu.test(value)) return "дерево";
  return "неясно";
}

function surfaceFactsFromEvidence(
  fullText: string,
  visualText: string,
  fence: FenceFacts | null,
): SurfaceFacts | null {
  if (fence) {
    return {
      kind: "fence",
      surface: "забор",
      material: fence.material,
      lengthM: fence.lengthM,
      heightM: fence.heightM,
      areaPerSideM2: fence.areaPerSideM2,
      sides: fence.sides,
      paintAreaM2: fence.paintAreaM2,
      source:
        !areaFromText(fullText) && areaFromText(visualText)
          ? "распознанное фото"
          : "письмо клиента",
    };
  }

  const evidenceText = `${fullText}\n${visualText}`;
  const hasWall = /(?:^|[^\p{L}])стен\p{L}*(?:[^\p{L}]|$)/iu.test(
    evidenceText,
  );
  const hasFloor =
    /(?:^|[^\p{L}])пол(?:а|у|ом|ы|ов|е)?(?:[^\p{L}]|$)/iu.test(evidenceText);
  if (hasWall === hasFloor) return null;

  const kind = hasWall ? "wall" : "floor";
  const surface = hasWall ? "стена" : "пол";
  const textArea = areaFromText(fullText);
  const visualArea = areaFromText(visualText);
  const paintAreaM2 = textArea ?? visualArea;
  const dimensions = dimensionsFromText(
    textArea ? fullText : visualArea ? visualText : evidenceText,
  );

  return {
    kind,
    surface,
    material: materialForSurface(kind, evidenceText),
    lengthM: dimensions.lengthM,
    heightM: dimensions.heightM,
    areaPerSideM2: paintAreaM2,
    sides: paintAreaM2 ? 1 : null,
    paintAreaM2,
    source: textArea ? "письмо клиента" : "распознанное фото",
  };
}

function productForSurface(
  surface: SurfaceFacts | null,
  products: DemoProduct[],
) {
  if (!surface || surface.material === "неясно") return null;
  if (surface.kind === "fence") {
    return productForFence(surface.material, products);
  }
  if (surface.kind === "wall") {
    return (
      products.find(
        (product) =>
          product.sku === "КР-004" &&
          product.substrates.includes(surface.material),
      ) ?? null
    );
  }
  return surface.material === "бетон"
    ? products.find(
        (product) =>
          product.sku === "КР-003" &&
          product.substrates.includes(surface.material),
      ) ?? null
    : null;
}

function surfaceCalculation(
  surface: SurfaceFacts,
  product: DemoProduct | null,
  reservePercent: number,
): FenceCalculation | undefined {
  if (
    !product ||
    surface.material === "неясно" ||
    !surface.areaPerSideM2 ||
    !surface.paintAreaM2 ||
    !surface.sides
  ) {
    return undefined;
  }

  const coats = product.recommendedCoats;
  const estimatedKg =
    surface.paintAreaM2 *
    product.coverageKgPerM2PerCoat *
    coats *
    (1 + reservePercent / 100);
  const packages = Math.ceil(estimatedKg / product.packKg);
  const roundedKg = packages * product.packKg;

  return {
    kind:
      surface.kind === "fence"
        ? "fence-area"
        : surface.kind === "wall"
          ? "wall-area"
          : "floor-area",
    surface: surface.surface,
    material: surface.material,
    source: surface.source,
    lengthM: surface.lengthM,
    heightM: surface.heightM,
    areaPerSideM2: surface.areaPerSideM2,
    sides: surface.sides,
    paintAreaM2: surface.paintAreaM2,
    coverageKgPerM2PerCoat: product.coverageKgPerM2PerCoat,
    coats,
    reservePercent,
    estimatedKg: Number(estimatedKg.toFixed(2)),
    packageKg: product.packKg,
    packages,
    roundedKg,
    explanation: `${decimal.format(surface.paintAreaM2)} м² × ${coats} слоя × ${decimal.format(
      product.coverageKgPerM2PerCoat,
    )} кг/м² + ${reservePercent}% запаса = ${decimal.format(
      estimatedKg,
    )} кг. Берём ${packages} ${packages === 1 ? "упаковку" : packages < 5 ? "упаковки" : "упаковок"} по ${decimal.format(
      product.packKg,
    )} кг: ${decimal.format(roundedKg)} кг. Площадь и материал получены из ${
      surface.source === "распознанное фото" ? "описания фото" : "письма"
    }.`,
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
      )} ₽/кг взята из карточки товара. Завод зарабатывает при цене от ${money.format(
        product.minPricePerKg,
      )} ₽/кг; разница составляет ${money.format(priceRoom)} ₽/кг.`,
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
    position = `Наша цена выше большинства показанных предложений: ${money.format(
      product.pricePerKg,
    )} ₽/кг. Весь объём и срок поставки подтверждены.`;
  }

  const priceRoom = marketMax - product.pricePerKg;
  const profitOpportunity =
    priceRoom > 0
      ? `В следующем предложении можно попробовать цену до ${money.format(
          marketMax,
        )} ₽/кг: другие поставщики уже предлагают такую цену. Журнал покажет, как изменится результат.`
      : "Заработать больше поможет крупный заказ или удобный график поставки.";

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

function commercialEstimateFor(
  profile: DemoCompanyProfile | null,
  requestedKg: number,
) {
  const estimate = profile?.commercialEstimate;
  if (!estimate) return null;

  const possibleMainKg =
    estimate.productionUnits * estimate.paintKgPerUnit;
  const possibleMainTons = possibleMainKg / 1000;
  const trialUnits =
    requestedKg > 0 ? requestedKg / estimate.paintKgPerUnit : 0;
  const trialScale =
    trialUnits > 0
      ? `Партия ${money.format(
          requestedKg,
        )} кг равна рабочему ориентиру для ${decimal.format(
          trialUnits,
        )} ${trialUnits === 1 ? "машины" : "машин"}.`
      : "";

  return {
    possibleMainKg,
    text: `Проверенный ориентир выпуска: ${money.format(
      estimate.productionUnits,
    )} машин за ${estimate.productionYear} год. ${estimate.paintBasis} Расчёт масштаба возможной основной закупки: ${money.format(
      estimate.productionUnits,
    )} × ${money.format(estimate.paintKgPerUnit)} кг = ${money.format(
      possibleMainKg,
    )} кг, или ${decimal.format(
      possibleMainTons,
    )} т в год при таком выпуске и расходе. ${trialScale} Текущий план выпуска и фактический расход подтвердит клиент. Следующий ход: ${estimate.nextMove}`,
    basis: `${money.format(
      estimate.productionUnits,
    )} машин × ${money.format(estimate.paintKgPerUnit)} кг на одну машину = ${money.format(
      possibleMainKg,
    )} кг возможной годовой потребности. Выпуск относится к ${estimate.productionYear} году, расход служит рабочим ориентиром. Оба значения агент предложит проверить у клиента.`,
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
    "материал стены":
      "Из чего сделана стена: штукатурка, бетон или гипсокартон?",
    "площадь стен": "Напишите площадь стен в квадратных метрах.",
    "материал пола":
      "Из чего сделан пол? Для этого расчёта нужен бетон или цементная стяжка.",
    "площадь пола": "Напишите площадь пола в квадратных метрах.",
    "объём заказа": "Сколько килограммов краски нужно?",
    "условия эксплуатации": "Где будете красить: на улице или в помещении?",
    "цвет или номер RAL":
      "Какой цвет нужен? Можно описать его словами или указать номер из каталога цветов RAL.",
    "приложите фотографию":
      "Приложите фотографию, которую упомянули в письме.",
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
  surface: SurfaceFacts | null,
  mentionsPhoto: boolean,
  product: DemoProduct | null,
  calculation?: FenceCalculation,
) {
  const intro = surface
    ? mentionsPhoto
      ? `Фото приложено к заявке. Подберём краску для поверхности «${surface.surface}» и рассчитаем количество.`
      : `Задачу поняли: нужно подобрать краску для поверхности «${surface.surface}».`
    : "Запрос принят. Соберём точный подбор и расчёт.";
  const questions = missing
    .map((item) => `— ${clarificationQuestion(item)}`)
    .join("\n");
  const closing = calculation
    ? `Количество уже рассчитано: ${decimal.format(
        calculation.roundedKg,
      )} кг, или ${calculation.packages} ${calculation.packages === 1 ? "упаковка" : calculation.packages < 5 ? "упаковки" : "упаковок"}. После ответа подтвердим подбор и наличие.`
    : "По ответу рассчитаем расход, округлим до целых упаковок и проверим наличие.";
  return {
    subject: product
      ? `Короткое уточнение по заказу: ${product.name}`
      : surface
        ? `Уточнение для расчёта краски: ${surface.surface}`
        : "Короткое уточнение по заказу краски",
    body: `Добрый день!\n\n${intro}\n\n${questions}\n\n${closing}`,
  };
}

export function buildDemoResult(
  input: OrderInput,
  snapshot?: DemoCatalogSnapshot | null,
): AgentResult {
  const catalog = resolveCatalog(snapshot);
  const fullText = `${input.subject}\n${input.body}`;
  const hasAttachedPhoto = Boolean(input.attachment?.src);
  const visualText = hasAttachedPhoto
    ? `${input.attachment?.name ?? ""}\n${input.attachment?.alt ?? ""}`
    : "";
  const evidenceText = `${fullText}\n${visualText}`;
  const businessText = `${evidenceText}\n${input.company ?? ""}`;
  const facts = orderFactsFromText(evidenceText);
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
  const surface = surfaceFactsFromEvidence(fullText, visualText, fence);
  const explicitRequestedKg = quantityFromText(fullText);
  const matchedProduct = matchProduct(evidenceText, catalog.products);
  const product =
    matchedProduct ??
    productForSurface(surface, catalog.products);
  const calculation = surface
    ? surfaceCalculation(
        surface,
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
    if (!hasColor(evidenceText)) missing.push("цвет забора");
  } else if (surface?.kind === "wall" && !explicitRequestedKg) {
    if (surface.material === "неясно") missing.push("материал стены");
    if (!surface.paintAreaM2) missing.push("площадь стен");
    if (!hasUsableEnvironment(evidenceText)) {
      missing.push("условия эксплуатации");
    }
    if (!hasColor(evidenceText)) {
      missing.push("цвет или номер RAL");
    }
  } else if (surface?.kind === "floor" && !explicitRequestedKg) {
    if (surface.material === "неясно") missing.push("материал пола");
    if (!surface.paintAreaM2) missing.push("площадь пола");
    if (!hasUsableEnvironment(evidenceText)) {
      missing.push("условия эксплуатации");
    }
    if (!hasColor(evidenceText)) {
      missing.push("цвет или номер RAL");
    }
  } else {
    if (unknownSku) {
      missing.push("товар из каталога");
    } else if (!product) {
      missing.push("назначение краски");
    }
    if (!requestedKg) missing.push("объём заказа");
    if (!hasUsableEnvironment(evidenceText)) {
      missing.push("условия эксплуатации");
    }
    if (!hasColor(evidenceText)) {
      missing.push("цвет или номер RAL");
    }
  }
  if (asksCompatibility(evidenceText)) {
    missing.push("совместимость покрытия");
  }
  const mentionedAttachment =
    /(?:вот|(?:прилаг|приклад|прилож|прикреп)\p{L}*)\s+(?:к\s+письму\s+)?(?:фото|фотограф\p{L}*|снимок)|(?:фото|фотограф\p{L}*|снимок)\s+(?:(?:прилаг|приклад|прилож|прикреп)\p{L}*|во\s+вложени\p{L}*|вложен\p{L}*)/iu.test(
      fullText,
    );
  if (mentionedAttachment && !hasAttachedPhoto) {
    missing.push("приложите фотографию");
  }

  const hardRed =
    Boolean(product) &&
    requestedKg > 0 &&
    (requestedKg > (product?.stockKg ?? 0) ||
      hasSpecialTerms(fullText) ||
      quotedUnitPrices(fullText).some(
        (price) => price < (product?.minPricePerKg ?? 0),
      ));
  const surfaceNeedsDetails = Boolean(
    surface &&
      (surface.kind === "fence" || !explicitRequestedKg) &&
      (surface.material === "неясно" ||
        !surface.paintAreaM2 ||
        !surface.sides),
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
        )} ₽/кг. ${
          profile?.commercialEstimate
            ? `Партия ${money.format(
                requestedKg,
              )} кг равна рабочему ориентиру для ${decimal.format(
                requestedKg / profile.commercialEstimate.paintKgPerUnit,
              )} ${requestedKg === profile.commercialEstimate.paintKgPerUnit ? "машины" : "машин"}. `
            : ""
        }Сразу предлагаем измерить фактический расход и запросить план выпуска.`
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
  const commercialEstimate = commercialEstimateFor(profile, requestedKg);
  const industry = industryFor(businessText, catalog.industries);
  const understood = [
    input.company ? `Компания: ${input.company}` : "Компания: уточним при заказе",
    ...(facts.inn ? [`ИНН: ${facts.inn}`] : []),
    surface
      ? surface.kind === "fence"
        ? "Задача: покрасить забор"
        : `Задача: покрасить поверхность «${surface.surface}»`
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
    surfaceNeedsDetails ||
    (missing.length > 0 && !hardRed)
  ) {
    const decisionBasis: DecisionBasis[] = [
      {
        fact: surface
          ? `Клиент хочет покрасить поверхность «${surface.surface}» и просит помочь с подбором и количеством.`
          : "Агент сохранил задачу клиента и все уже известные детали.",
        source: "Письмо клиента",
        checkedAt: today,
      },
      {
        fact:
          "Ответ клиента сохранится в этой карточке вместе с письмом, вопросами и новым расчётом.",
        source: "Карточка и история переписки",
        checkedAt: today,
      },
      ...(product && requestedKg
        ? [stockBasis(product, requestedKg, catalog)]
        : []),
    ];
    if (calculation) {
      decisionBasis.unshift({
        fact: calculation.explanation,
        source:
          calculation.source === "распознанное фото"
            ? "Распознанные сведения о фото и расчёт расхода"
            : "Расчёт расхода и упаковок",
        checkedAt: today,
      });
    }
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
      businessContext: surface
        ? calculation
          ? `Агент получил площадь и материал из ${
              calculation.source === "распознанное фото"
                ? "описания фото"
                : "письма"
            }, сам подобрал краску и рассчитал ${money.format(
              calculation.roundedKg,
            )} кг. Клиенту осталось ответить только на вопросы, которые меняют предложение.`
          : surface.kind === "fence"
            ? "Фото дополняет заявку и помогает обсудить состояние поверхности. Материал, размеры и стороны покраски подтверждает клиент; эти данные определяют краску и количество упаковок."
            : "Фото и описание задачи помогают определить поверхность. Материал, площадь и условия подтверждает клиент; эти данные определяют краску и количество упаковок."
        : product
          ? `Краска «${product.name}» найдена в каталоге. Короткий ответ клиента завершит расчёт.`
          : "Агент сохранил известные факты и подготовил самый короткий путь к точному предложению.",
      zoneReason: surface
        ? hasAttachedPhoto
          ? calculation
            ? "Фото содержит материал и площадь. Агент уже рассчитал расход и спрашивает только недостающие условия."
            : "Фото приложено к заявке. Клиент подтвердит недостающие сведения, затем агент рассчитает расход и упаковки."
          : calculation
            ? "Клиент назвал поверхность, материал и площадь. Агент уже рассчитал расход и спрашивает только недостающие условия."
            : "Клиент описал задачу своими словами. После короткого ответа агент рассчитает расход и упаковки."
        : unknownSku
          ? "Код краски нужно сверить с каталогом. Описание поверхности поможет сразу найти подходящую краску."
          : "Агент понял основную потребность и спрашивает только данные, которые меняют подбор или расчёт.",
      managerNote:
        "Ответ клиента продолжит ту же карточку: агент дополнит факты, пересчитает заказ и снова проверит склад.",
      options: [],
      reply: replyWithQuestions(
        missing,
        surface,
        hasAttachedPhoto,
        product,
        calculation,
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
  const standardBusinessContext = calculation
    ? `Клиент назвал поверхность, материал и площадь. Агент сам подобрал краску и перевёл ${decimal.format(
        calculation.paintAreaM2,
      )} м² в ${decimal.format(
        calculation.roundedKg,
      )} кг с округлением до целых упаковок. Клиенту достаточно описать задачу обычными словами.`
    : industry
      ? `Клиенту важно: ${industry.risk}. Что предлагает агент: ${industry.play}.`
      : `Подбор опирается на свойства краски: ${product.features.join(", ")}.`;
  const businessContext = profile
    ? likelyTrialOrder
      ? `${profile.summary} Агент предполагает: заказ на ${money.format(
          requestedKg,
        )} кг служит пробной партией. ${
          commercialEstimate?.text ??
          "Агент предложит измерить фактический расход и уточнить объём следующей закупки."
        }`
      : `${profile.summary} Заказ на ${money.format(
          requestedKg,
        )} кг равен ${money.format(
          Math.ceil(requestedKg / product.packKg),
        )} упаковкам. Агент уточнит график следующих закупок, чтобы заранее согласовать выпуск и доставку.`
    : standardBusinessContext;
  const stockDecisionBasis = stockBasis(product, requestedKg, catalog);
  const decisionBasis: DecisionBasis[] = [
    stockDecisionBasis,
    {
      fact: `Цена ${money.format(
        product.pricePerKg,
      )} ₽/кг. Завод зарабатывает при цене от ${money.format(
        product.minPricePerKg,
      )} ₽/кг.`,
      source: "Карточка товара и второе правило о цене",
      checkedAt: today,
    },
    {
      fact:
        "Письмо предлагает объём, подтверждённый складом. Особые условия передаются руководителю вместе с готовыми вариантами.",
      source: "Три правила продаж",
      checkedAt: today,
    },
  ];
  const comparableBasis = marketBasis(view);
  if (comparableBasis) decisionBasis.push(comparableBasis);
  if (calculation) {
    decisionBasis.unshift({
      fact: calculation.explanation,
      source:
        calculation.source === "распознанное фото"
          ? "Распознанные сведения о фото и расчёт расхода"
          : "Расчёт расхода и упаковок",
      checkedAt: today,
    });
  }
  if (commercialEstimate) {
    decisionBasis.push({
      fact: commercialEstimate.basis,
      source: "Расчёт возможной основной закупки",
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
      ? "После выбора варианта отложим доступную партию для вас."
      : "Назовите точный цвет, и мы отложим доступную партию для вас.";
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
            businessResult:
              "Завод продаёт доступную партию сейчас и сохраняет заказ на оставшийся объём.",
            tradeoff: "Вторую партию доставим отдельно.",
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
                  businessResult:
                    "Завод получает оплату за первую партию до отгрузки и отдельно согласует оплату оставшегося объёма.",
                  tradeoff:
                    "Договор зафиксирует сумму и срок оплаты для каждой партии.",
                  reply: `Добрый день!\n\nПредлагаем поставить заказ двумя партиями и закрепить оплату отдельно для каждой. Первые ${money.format(
                    product.stockKg,
                  )} кг готовы отгрузить со склада, оставшиеся ${money.format(
                    remainder,
                  )} кг — через ${
                    product.replenishmentDays
                  } дней. Для второй партии рассмотрим оплату после поставки и закрепим срок в договоре.`,
                },
              ]
            : []),
          ...(compatibleAlternative
            ? [
                {
                  id: "замена-краски",
                  title: `Поставить весь объём краской «${compatibleAlternative.name}»`,
                  rationale: `${money.format(
                    requestedKg,
                  )} кг есть на складе. Специалист подтвердит, что краска подходит; затем склад отложит нужный объём.`,
                  businessResult:
                    "Завод выполняет весь заказ товаром со склада и получает оплату за весь заказ сразу.",
                  tradeoff: `Цена составит ${money.format(
                    compatibleAlternative.pricePerKg,
                  )} ₽/кг.`,
                  reply: `Добрый день!\n\nМожем поставить весь объём краской «${compatibleAlternative.name}» по цене ${money.format(
                    compatibleAlternative.pricePerKg,
                  )} ₽/кг. Весь объём есть на складе. Специалист подтвердит, что краска подходит; затем склад отложит нужный объём.`,
                },
              ]
            : []),
          {
            id: "приоритет-производства",
            title: "Добавить краску в ближайший выпуск",
            rationale:
              "Отложить доступную партию для клиента и добавить недостающий объём в ближайший выпуск.",
            businessResult:
              "Завод сохраняет полный заказ и заранее планирует ближайший выпуск.",
            tradeoff: "Производство подтвердит дату второй отгрузки.",
            reply: `Добрый день!\n\nОтложим для вас ${money.format(
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
            businessResult:
              "Завод получает реалистичный график заказа и планирует производство под срок клиента.",
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
              businessResult:
                "Завод получает оплату до отгрузки и зарабатывает на заказе.",
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
              businessResult:
                "Завод получает план закупок и заранее готовит нужный объём.",
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
              businessResult:
                "Завод получает часть оплаты до отгрузки и фиксирует срок оставшегося платежа.",
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
            businessResult:
              "Завод продаёт по текущей цене, зарабатывает на заказе и быстро переходит к отгрузке.",
            tradeoff:
              "Вариант сохраняет текущую цену и обычную оплату до отгрузки.",
            reply: firstReply,
          },
          {
            id: "условие-за-объём",
            title: "Дать лучшую цену за план закупок",
            rationale:
              "Клиент заранее согласует объём на квартал и вносит предоплату.",
            businessResult:
              "Завод получает предсказуемый объём следующих заказов и планирует выпуск заранее.",
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
            businessResult:
              "Завод узнаёт главный приоритет клиента и собирает условия, при которых зарабатывает на заказе.",
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
        ? [
            `Склад подтверждает ${money.format(
              product.stockKg,
            )} кг сейчас и ${money.format(remainder)} кг после пополнения.`,
            paymentAfterDelivery
              ? "Клиент просит оплату после поставки."
              : "",
            belowMinimum
              ? `Цена клиента — ${money.format(
                  customerPrice ?? 0,
                )} ₽/кг. Завод зарабатывает при цене от ${money.format(
                  product.minPricePerKg,
                )} ₽/кг.`
              : "",
            `Руководитель выбирает способ поставить оставшиеся ${money.format(
              remainder,
            )} кг${paymentAfterDelivery ? " и график оплаты" : ""}.`,
          ]
            .filter(Boolean)
            .join(" ")
        : belowMinimum
          ? `Цена клиента — ${money.format(
              customerPrice ?? 0,
            )} ₽/кг. Завод зарабатывает при цене от ${money.format(
              product.minPricePerKg,
            )} ₽/кг. Агент подготовил варианты для руководителя.`
          : "Агент подготовил три выполнимых варианта по особым условиям клиента.",
      managerNote: profile
        ? likelyTrialOrder
          ? profile.suggestedMove
          : "Уточнить график следующих закупок и заранее согласовать выпуск и доставку."
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
          : "Цена сверена с карточкой товара и правилом заработка",
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
      ? `Склад подтверждает весь объём. Заказ выглядит пробной партией. ${
          commercialEstimate
            ? `Рабочий расчёт даёт ориентир ${money.format(
                commercialEstimate.possibleMainKg,
              )} кг возможной годовой потребности при историческом выпуске и выбранном ориентире расхода. `
            : ""
        }Агент предложит измерить фактический расход и уточнить текущий план выпуска.`
      : "Весь объём подтверждён складом. По этой цене завод зарабатывает на заказе. Письмо готово.",
    managerNote: profile
      ? likelyTrialOrder
        ? profile.suggestedMove
        : "Уточнить график следующих закупок и заранее согласовать выпуск и доставку."
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
      )} ₽ без доставки.\n\nВесь объём есть на складе. После подтверждения заказа отложим партию для вас и направим график отгрузки.${
        calculation
          ? `\n\nРасчёт количества: ${calculation.explanation}`
          : ""
      }${
        likelyTrialOrder
          ? "\n\nПодскажите, какие свойства краски проверяете на первой партии. Предлагаем записать фактический расход на одну машину и сверить его с текущим планом выпуска. По этим данным рассчитаем возможный объём и график следующей закупки."
          : ""
      }`,
    },
    checks: [
      "По этой цене завод зарабатывает на заказе",
      "Весь объём подтверждён складом",
      "Письмо собрано по правилам завода",
      view.items.length
        ? "Сравнение цен содержит дату"
        : "Цена сверена с карточкой товара и правилом заработка",
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
