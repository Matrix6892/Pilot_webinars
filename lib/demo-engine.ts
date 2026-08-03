import demoData from "@/data/paint-demo.json";
import {
  asksCompatibility,
  asksPaymentAfterDelivery,
  colorLabelFromText,
  deliveryPlanFromText,
  explicitSkuFromText,
  floorUseFactsFromText,
  hasColor,
  hasSpecialTerms,
  hasUsableEnvironment,
  matchProduct,
  orderFactsFromText,
  quotedUnitPrices,
} from "@/lib/order-facts.mjs";
import { buildSupplierPlan } from "@/lib/supplier-plan.mjs";

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
export type DemoProduct = BaseProduct & {
  stockRevision?: number;
  stockUpdatedAt?: string;
};
export type DemoMarketItem = (typeof demoData.market)[number];
export type SupplierPlan = NonNullable<
  ReturnType<typeof buildSupplierPlan>
> & {
  confirmedAt?: string;
};
type DemoCompanyProfile = (typeof demoData.companyProfiles)[number] & {
  website?: string;
  applicationGuidance?: {
    kind: string;
    hypothesis: string;
    recommendation: string;
    question: string;
    documentRequest: string;
  };
};
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

export type EvidenceSource =
  | { kind: "message"; roundNo: number; quote: string }
  | { kind: "vision"; attachmentRef: string; observation: string }
  | {
      kind: "web";
      url: string;
      title: string;
      openedAt: string;
      excerpt?: string;
      sha256?: string;
    }
  | {
      kind: "snapshot";
      dataset: "catalog" | "inventory" | "supplier";
      key: string;
      version: string;
      checkedAt: string;
    };

export type OrderEvidence = {
  id: string;
  claim: string;
  confidence: number;
  source: EvidenceSource;
};

export type AgentAssumption = {
  id: string;
  claim: string;
  basedOnEvidenceIds: string[];
  confidence: number;
  range?: { min: number; max: number; unit: string };
  confirmBefore: "never" | "commercial_offer" | "reserve" | "production";
};

export type TargetCandidate = {
  label: string;
  confidence: number;
  evidenceIds: string[];
};

export type ResolvedIntent = {
  goal: string;
  target:
    | { state: "resolved"; label: string; evidenceIds: string[] }
    | {
        state: "ambiguous";
        candidates: [TargetCandidate, TargetCandidate, ...TargetCandidate[]];
      };
  evidence: OrderEvidence[];
  assumptions: AgentAssumption[];
  blocker: null | {
    kind: "target_ambiguity";
    question: string;
    choices: [string, string, ...string[]];
  };
};

export type Commitment = "none" | "estimate" | "commercial_offer";

export type RangeEstimate = {
  metric: "surface_area" | "paint_quantity" | "budget";
  range: { min: number; max: number; unit: string };
  method: string;
  evidenceIds: string[];
  assumptionIds: string[];
  confidence: number;
  candidateSku?: string;
};

export type SupplierLead = {
  supplier: string;
  url: string;
  openedAt: string;
  observedClaims: string[];
  confirmationNeeded: string[];
};

export type VisionObservation = {
  attachmentRef?: string;
  summary: string;
  relevance: "relevant" | "irrelevant" | "uncertain";
  targetCandidates: Array<{
    label: string;
    confidence: number;
    evidence: string;
  }>;
  visibleFacts: string[];
  scaleEvidence: string[];
  areaEstimate?: {
    min: number;
    max: number;
    unit: string;
    method: string;
    confidence: number;
  };
  uncertainties: string[];
};

export type AgentOption = {
  id: string;
  title: string;
  rationale: string;
  tradeoff: string;
  reply: string;
  businessResult?: string;
  followUpActor: "customer" | "supplier" | "internal" | "none";
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
  schemaVersion: 2;
  zone: "green" | "yellow" | "red";
  decision: "quote" | "clarify" | "escalate";
  route: "ready" | "needs_info" | "manager";
  confidence: number;
  resolvedIntent: ResolvedIntent;
  visionObservation: VisionObservation | null;
  commitment: Commitment;
  estimates: RangeEstimate[];
  supplierLeads: SupplierLead[];
  understood: string[];
  missing: string[];
  product: {
    sku: string;
    name: string;
    stockKg: number;
    requestedKg: number;
    firstDeliveryKg?: number;
    color?: string;
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
      stockKg?: number;
      stockCheckedAt?: string;
    }>;
  };
  supplierPlan?: SupplierPlan;
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

function countedNoun(
  value: number,
  one: string,
  few: string,
  many: string,
) {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  const last = value % 10;
  if (last === 1) return one;
  return last >= 2 && last <= 4 ? few : many;
}
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
    )} кг. Берём ${packages} ${countedNoun(
      packages,
      "упаковку",
      "упаковки",
      "упаковок",
    )} по ${decimal.format(
      product.packKg,
    )} кг: ${decimal.format(roundedKg)} кг. Площадь и материал получены из ${
      surface.source === "распознанное фото" ? "описания фото" : "письма"
    }.`,
  };
}

export function marketView(
  product: DemoProduct | null,
  items: DemoMarketItem[],
  requestedKg: number,
) {
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
      )} ₽/кг взята из описания краски в каталоге. Завод зарабатывает при цене от ${money.format(
        product.minPricePerKg,
      )} ₽/кг; разница составляет ${money.format(priceRoom)} ₽/кг.`,
      position: `Цена ${money.format(
        product.pricePerKg,
      )} ₽/кг взята из описания краски в каталоге.`,
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
  const marketReference =
    comparable.length === 1
      ? "цены другого поставщика"
      : "средней цены других поставщиков";
  const equalMarketReference =
    comparable.length === 1
      ? "с ценой другого поставщика"
      : "со средней ценой других поставщиков";
  const closeToAverage =
    Math.abs(difference) <= Math.max(5, marketAverage * 0.02);
  const availability =
    requestedKg <= 0
      ? "Количество уточняем перед предложением."
      : requestedKg <= product.stockKg
        ? "Весь объём подтверждён складом."
        : `Склад подтверждает ${money.format(
            product.stockKg,
          )} из ${money.format(
            requestedKg,
          )} кг. Поставку оставшейся части согласует руководитель.`;

  let position: string;
  if (closeToAverage) {
    const roundedDifference = Math.round(Math.abs(difference));
    position =
      roundedDifference === 0
        ? `Наша цена ${money.format(
            product.pricePerKg,
          )} ₽/кг совпадает ${equalMarketReference}. ${availability}`
        : `Наша цена ${money.format(product.pricePerKg)} ₽/кг, на ${money.format(
            roundedDifference,
          )} ₽ ${difference > 0 ? "выше" : "ниже"} ${marketReference}. ${
            difference > 0
              ? "Цена близка к рынку."
              : "Цена выглядит привлекательно."
          } ${availability}`;
  } else if (difference < 0) {
    position = `Наша цена ${money.format(
      product.pricePerKg,
    )} ₽/кг на ${money.format(
      Math.round(Math.abs(difference)),
    )} ₽ ниже ${marketReference}.`;
  } else {
    position = `Наша цена ${money.format(
      product.pricePerKg,
    )} ₽/кг, на ${money.format(
      Math.round(difference),
    )} ₽ выше ${marketReference}. Агент покажет клиенту наличие, срок и свойства краски. ${availability}`;
  }

  const priceRoom = marketMax - product.pricePerKg;
  const profitOpportunity =
    priceRoom > 0
      ? `На следующем похожем заказе можно проверить цену до ${money.format(
          marketMax,
        )} ₽/кг при сопоставимых свойствах, объёме и сроке. Журнал покажет результат.`
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
    source: "Остаток на момент расчёта",
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
        `${item.competitor} — ${money.format(item.pricePerKg)} ₽/кг${
          typeof item.stockKg === "number"
            ? `, в таблице указано ${money.format(item.stockKg)} кг`
            : ""
        }`,
    )
    .join("; ");
  return {
    fact: `${view.position} Для сравнения: ${comparedPrices}.`,
    source: "Таблица цен и наличия поставщиков",
    checkedAt: latest?.stockCheckedAt ?? latest?.checkedAt ?? today,
  };
}

function comparableHost(value: string | undefined) {
  const source = String(value ?? "").trim();
  if (!source) return "";
  try {
    return new URL(source.includes("://") ? source : `https://${source}`)
      .hostname.toLocaleLowerCase("ru-RU")
      .replace(/^www\./u, "");
  } catch {
    return source
      .toLocaleLowerCase("ru-RU")
      .replace(/^www\./u, "")
      .replace(/\/.*$/u, "");
  }
}

function comparableCompany(value: string | undefined) {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/\b(?:ао|ооо|пао|зао|гк)\b/giu, "")
    .replace(/[«»"'“”„().,\s-]+/gu, "");
}

function profileFor(
  identity: { inn?: string; company?: string; website?: string },
  companyProfiles: DemoCompanyProfile[],
): DemoCompanyProfile | null {
  const inn = String(identity.inn ?? "").trim();
  if (inn) {
    const exactInn = companyProfiles.find((profile) => profile.inn === inn);
    if (exactInn) return exactInn;
  }

  const host = comparableHost(identity.website);
  if (host) {
    const exactWebsite = companyProfiles.find(
      (profile) => comparableHost(profile.website) === host,
    );
    if (exactWebsite) return exactWebsite;
    return null;
  }

  const company = comparableCompany(identity.company);
  return company
    ? companyProfiles.find(
        (profile) => comparableCompany(profile.name) === company,
      ) ?? null
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

function floorGuidanceFor(
  profile: DemoCompanyProfile | null,
  surface: SurfaceFacts | null,
) {
  return surface?.kind === "floor" &&
    profile?.applicationGuidance?.kind === "floor-profile"
    ? profile.applicationGuidance
    : null;
}

function guidedFloorGaps(
  surface: SurfaceFacts,
  floorUse: ReturnType<typeof floorUseFactsFromText>,
) {
  return [
    ...(surface.material === "неясно" ? ["материал пола"] : []),
    ...(!surface.paintAreaM2 ? ["площадь пола"] : []),
    ...(!floorUse.purpose ? ["назначение помещения"] : []),
    ...(!floorUse.cleaning ? ["способ уборки"] : []),
    ...(!floorUse.load ? ["нагрузка на пол"] : []),
  ];
}

function guidedFloorContext(
  profile: DemoCompanyProfile,
  product: DemoProduct | null,
) {
  const guidance = profile.applicationGuidance;
  if (!guidance) return profile.summary;
  const productFacts = product
    ? `Каталог подтверждает для «${product.name}»: ${product.features.join(
        ", ",
      )}.`
    : "Каталог подключится к подбору после ответа клиента.";
  return `${profile.summary} ${guidance.hypothesis} ${guidance.recommendation} ${productFacts} ${guidance.documentRequest}`;
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
  firstDeliveryKg = 0,
  color = "",
) {
  return product
    ? {
        sku: product.sku,
        name: product.name,
        stockKg: product.stockKg,
        requestedKg,
        ...(firstDeliveryKg ? { firstDeliveryKg } : {}),
        ...(color ? { color } : {}),
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
      ? surface.surface === "забор"
        ? "Получили фото забора. Уточним материал, размеры, стороны покраски и цвет, затем подберём краску и рассчитаем количество."
        : `Получили фотографию поверхности «${surface.surface}». Уточним материал и размеры, затем подберём краску и рассчитаем количество.`
      : `Задачу поняли: нужно подобрать краску для поверхности «${surface.surface}».`
    : "Запрос принят. Соберём точный подбор и расчёт.";
  const questions = missing
    .map((item) => `— ${clarificationQuestion(item)}`)
    .join("\n");
  const closing = calculation
    ? `Количество уже рассчитано: ${decimal.format(
        calculation.roundedKg,
      )} кг, или ${calculation.packages} ${countedNoun(
        calculation.packages,
        "упаковка",
        "упаковки",
        "упаковок",
      )}. После ответа подтвердим подбор и наличие.`
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

function replyWithFloorGuidance(
  profile: DemoCompanyProfile,
  product: DemoProduct | null,
  surface: SurfaceFacts,
  requestText: string,
) {
  const guidance = profile.applicationGuidance;
  if (!guidance) {
    return replyWithQuestions(
      ["назначение помещения, материал пола и нагрузка"],
      null,
      false,
      product,
    );
  }
  const productLine = product
    ? `Если помещение используют как медицинский склад, пол бетонный, его моют нейтральным средством и по нему ездят тележки, первым вариантом станет краска «${product.name}». Описание краски в каталоге подтверждает такую уборку, нагрузку от техники и паспорт качества на партию.`
    : "После уточнения назначения и материала пола подберём краску из каталога.";
  const question = [
    "Как используют помещение?",
    `Чтобы подобрать покрытие${
      surface.paintAreaM2
        ? ` для ${decimal.format(surface.paintAreaM2)} м²`
        : ""
    }, выберите ближайший вариант:`,
    "— медицинский склад: материал пола, средство для ежедневной уборки, техника на полу и нужные документы;",
    "— обычный склад: материал пола, уборка и техника;",
    "— другое помещение: назначение, материал пола, уборка и нагрузка.",
  ].join("\n");
  const requestedColor = colorLabelFromText(requestText);
  const colorLine =
    product && requestedColor && productHasRequestedColor(product, requestText)
      ? `Запрошенный цвет «${requestedColor}» есть в каталоге.`
      : requestedColor
        ? `Учли запрошенный цвет «${requestedColor}».`
        : "";
  const documentRequest =
    /ГОСТ|GMP|ISO|СанПиН|дезинф|дезсредств|химическ\p{L}*\s+стойк/iu.test(
      requestText,
    )
      ? guidance.documentRequest
      : "";
  return {
    subject: "Один вопрос для точного подбора краски",
    body: [
      "Добрый день!",
      question,
      "На сайте группы описаны фармацевтические и медицинские направления и складской комплекс. Похоже, помещение может быть складом.",
      productLine,
      colorLine,
      documentRequest,
      "Если помещение используют иначе, подберём покрытие по назначению, нагрузке и условиям уборки.",
      surface.paintAreaM2
        ? `После ответа рассчитаем заказ на ${decimal.format(
            surface.paintAreaM2,
          )} м², проверим цвет и свежий остаток на складе.`
        : "После ответа рассчитаем количество краски и проверим остаток на складе.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

function productCoversRequestedUse(
  product: DemoProduct | null,
  requestText: string,
) {
  if (!product) return false;
  const features = product.features.join(" ");
  if (/масл/iu.test(requestText)) return /масл/iu.test(features);
  if (/дезинф|дезсредств/iu.test(requestText)) {
    return /дезинф|дезсредств/iu.test(features);
  }
  if (/(?:ГОСТ|GMP|ISO|СанПиН)/u.test(requestText)) {
    const requested = requestText.match(
      /(?:ГОСТ|GMP|ISO|СанПиН)[\s№:.-]*[\dА-ЯA-Z-]*/u,
    )?.[0];
    return Boolean(requested && features.includes(requested));
  }
  if (/нейтральн\p{L}*\s+(?:моющ\p{L}*\s+)?средств/iu.test(requestText)) {
    return /ежедневн\p{L}*[^.]{0,80}нейтральн\p{L}*\s+(?:моющ\p{L}*\s+)?средств/iu.test(
      features,
    );
  }
  if (/влажн\p{L}*\s+уборк/iu.test(requestText)) {
    return /влажн\p{L}*\s+уборк/iu.test(features);
  }
  return false;
}

function technicalReviewText(requestText: string) {
  if (/масл/iu.test(requestText)) {
    return "Клиент сообщил о регулярном контакте пола с моторным маслом. Агент собрал условия, расчёт и описание краски из каталога; технолог проверит стойкость на образце и закрепит подходящее покрытие.";
  }
  if (/дезинф|дезсредств/iu.test(requestText)) {
    return "Клиент использует дезинфицирующее средство. Агент передаст технологу название средства, режим уборки, расчёт и описание краски из каталога для точного подтверждения.";
  }
  if (/(?:ГОСТ|GMP|ISO|СанПиН)/u.test(requestText)) {
    return "Клиент указал обязательный документ. Агент передаст технологу точное требование, описание краски из каталога и готовый расчёт для проверки комплекта поставки.";
  }
  return "Условия эксплуатации требуют проверки технолога. Агент уже собрал контекст, описание краски из каталога и расчёт.";
}

export function productHasRequestedColor(
  product: DemoProduct,
  requestText: string,
) {
  const requested = colorLabelFromText(requestText);
  if (!requested) return false;

  const available = product.colors.join(" ").toLocaleLowerCase("ru-RU");
  const ral = requested.match(/\bRAL\s*\d{4}\b/iu)?.[0].toUpperCase();
  if (ral) return available.includes(ral.toLocaleLowerCase("ru-RU"));

  const color = requested.split(",")[0].toLocaleLowerCase("ru-RU");
  const knownRal: Record<string, string[]> = {
    "тёмно-серый": ["ral 7024"],
    "светло-серый": ["ral 7035"],
    серый: ["ral 7024", "ral 7035"],
    чёрный: ["ral 9005"],
    белый: ["ral 9016"],
  };
  const stem = color.replace(/(?:ый|ая|ое|ые)$/u, "");
  return (
    available.includes(stem) ||
    (knownRal[color] ?? []).some((item) => available.includes(item))
  );
}

function orderLogisticsLine(value: string) {
  const sentence = value
    .split(/[.!?\n]+/u)
    .map((item) => item.trim())
    .find((item) => /достав|поставк|отгруз|забер|самовывоз/iu.test(item));
  if (!sentence) return "";

  const normalized = sentence
    .replace(/\s+/g, " ")
    .replace(/^забер[её]м\b/iu, "вы заберёте")
    .replace(/^готовы\s+забрать\b/iu, "вы готовы забрать");
  return `${normalized.charAt(0).toLocaleLowerCase("ru-RU")}${normalized.slice(1)}`;
}

type DemoOptionDraft = Omit<AgentOption, "followUpActor"> & {
  followUpActor?: AgentOption["followUpActor"];
};
type AgentResultDraft = Omit<
  AgentResult,
  | "schemaVersion"
  | "resolvedIntent"
  | "visionObservation"
  | "commitment"
  | "estimates"
  | "supplierLeads"
  | "options"
> & {
  options: DemoOptionDraft[];
};

function withV2Result(
  result: AgentResultDraft,
  input: OrderInput,
): AgentResult {
  const quote = `${input.subject}\n${input.body}`.trim().slice(0, 420);
  const claims = result.understood.length
    ? result.understood.slice(0, 8)
    : ["Задача клиента сохранена"];
  const evidence: OrderEvidence[] = claims.map((claim, index) => ({
    id: `message-${index + 1}`,
    claim,
    confidence: 1,
    source: { kind: "message", roundNo: 1, quote },
  }));
  const targetClaim =
    claims.find((claim) => /^(?:Задача|Краска):/u.test(claim)) ?? claims[0];
  const targetEvidence = evidence.find((item) => item.claim === targetClaim);
  const calculationEvidenceId = targetEvidence?.id ?? evidence[0].id;
  const estimates: RangeEstimate[] = result.calculation
    ? [
        {
          metric: "surface_area",
          range: {
            min: result.calculation.paintAreaM2,
            max: result.calculation.paintAreaM2,
            unit: "м²",
          },
          method: result.calculation.explanation,
          evidenceIds: [calculationEvidenceId],
          assumptionIds: [],
          confidence: 1,
          ...(result.product?.sku
            ? { candidateSku: result.product.sku }
            : {}),
        },
        {
          metric: "paint_quantity",
          range: {
            min: result.calculation.roundedKg,
            max: result.calculation.roundedKg,
            unit: "кг",
          },
          method: result.calculation.explanation,
          evidenceIds: [calculationEvidenceId],
          assumptionIds: [],
          confidence: 1,
          ...(result.product?.sku
            ? { candidateSku: result.product.sku }
            : {}),
        },
      ]
    : [];
  // ponytail: one explicit recorded asset has a checked fixture; all free uploads stay on the live vision path.
  const recordedFencePhoto = input.attachment?.src === "/fence-demo.jpg";
  const recordedVision: VisionObservation | null = recordedFencePhoto
    ? {
        attachmentRef: input.attachment?.src,
        summary:
          "На снимке виден деревянный штакетник со старым отслаивающимся покрытием.",
        relevance: "relevant",
        targetCandidates: [
          {
            label: "забор",
            confidence: 0.99,
            evidence: "Забор занимает основную часть кадра и назван в письме.",
          },
        ],
        visibleFacts: [
          "В кадре деревянные вертикальные доски.",
          "Старое покрытие заметно отслаивается.",
          "Видна одна сторона фрагмента забора.",
        ],
        scaleEvidence: [
          "Повторяющаяся ширина досок даёт только грубый ориентир масштаба.",
        ],
        areaEstimate: {
          min: 15,
          max: 60,
          unit: "м²",
          method:
            "Широкий диапазон по видимому фрагменту и повторяющемуся размеру досок; полная длина и вторая сторона не видны.",
          confidence: 0.35,
        },
        uncertainties: [
          "Полная длина забора и число окрашиваемых сторон не видны.",
          "Точный цвет и состояние древесины проверяются перед коммерческим предложением.",
        ],
      }
    : null;
  if (recordedVision) {
    evidence.push({
      id: "vision-recorded-1",
      claim: recordedVision.summary,
      confidence: 0.9,
      source: {
        kind: "vision",
        attachmentRef: recordedVision.attachmentRef ?? "recorded-photo",
        observation: recordedVision.summary,
      },
    });
  }
  const gapAssumptions: AgentAssumption[] = result.missing.map(
    (gap, index) => ({
      id: `recorded-gap-${index + 1}`,
      claim: `Для точного обязательства потребуется подтвердить: ${gap}`,
      basedOnEvidenceIds: [calculationEvidenceId],
      confidence: 0.35,
      confirmBefore: "commercial_offer",
    }),
  );
  if (recordedVision?.areaEstimate && estimates.length === 0) {
    const assumptionIds = gapAssumptions.map((assumption) => assumption.id);
    estimates.push(
      {
        metric: "surface_area",
        range: {
          min: recordedVision.areaEstimate.min,
          max: recordedVision.areaEstimate.max,
          unit: recordedVision.areaEstimate.unit,
        },
        method: recordedVision.areaEstimate.method,
        evidenceIds: ["vision-recorded-1"],
        assumptionIds,
        confidence: recordedVision.areaEstimate.confidence,
        candidateSku: "КР-005",
      },
      {
        metric: "paint_quantity",
        range: { min: 10, max: 20, unit: "кг" },
        method:
          "Диапазон площади × 0,14 кг/м² × 2 слоя + 10% запаса, округлено до упаковок по 10 кг.",
        evidenceIds: ["vision-recorded-1"],
        assumptionIds,
        confidence: 0.3,
        candidateSku: "КР-005",
      },
    );
  }
  const legacyClarification = result.route === "needs_info";
  const recordedEstimate = legacyClarification && estimates.length > 0;
  const normalizedResult: AgentResultDraft = legacyClarification
    ? recordedEstimate
      ? {
          ...result,
          zone: "yellow",
          decision: "clarify",
          route: "ready",
          missing: [],
          product: null,
          businessContext:
            "Цель понятна по письму и фото. Записанное vision-наблюдение даёт широкий предварительный диапазон; точные обязательства появятся только после живой проверки.",
          zoneReason:
            "Предварительная диапазонная оценка готова без запроса уже выводимых данных.",
          managerNote:
            "Перед коммерческим предложением подтвердить геометрию, число сторон и выбранный оттенок.",
          options: [],
          reply: {
            subject: "Предварительная оценка по заявке",
            body:
              "Добрый день! По фотографии цель понятна: деревянный забор со старым покрытием. Предварительно площадь составляет 15–60 м², ориентир по краске КР-005 — 10–20 кг. Это диапазонная оценка; точный объём и оттенок подтвердим перед коммерческим предложением.",
          },
          checks: [
            "Цель определена по письму и фото",
            "Площадь и расход указаны диапазоном",
            "Точный оффер не обещан",
          ],
          sources: [
            "Письмо клиента",
            "Записанное наблюдение по синтетическому фото",
            "Каталог товаров",
          ],
          decisionBasis: [
            {
              fact: recordedVision?.summary ?? "Фото приложено к заявке.",
              source: "Записанное vision-наблюдение",
              checkedAt: today,
            },
            {
              fact:
                "Площадь оценена диапазоном 15–60 м², расход — 10–20 кг.",
              source: "Диапазонный расчёт",
              checkedAt: today,
            },
          ],
        }
      : {
          ...result,
          zone: "red",
          decision: "escalate",
          route: "manager",
          missing: [],
          product: null,
          options: [
            {
              id: "запустить-живой-разбор",
              title: "Запустить живого агента",
              rationale:
                "Живая модель проверит вложение, допущения и открытые источники.",
              tradeoff: "Результат появится после завершения живого прогона.",
              reply:
                "Внутренний шаг: передать сохранённую заявку живому агенту.",
            },
            {
              id: "проверить-вручную",
              title: "Передать специалисту",
              rationale:
                "Специалист увидит исходное письмо и подготовит безопасный следующий шаг.",
              tradeoff: "Потребуется ручная проверка.",
              reply:
                "Внутренний шаг: открыть сохранённую заявку специалисту.",
            },
          ],
          businessContext: `${result.businessContext} Записанный прогон сохранил задачу, но не подменяет живое понимание свободного запроса.`,
          zoneReason:
            "Записанный прогон не подменяет свободный разбор недостающими вопросами.",
          managerNote:
            "Запустите живого агента: он проверит фото, допущения и открытые источники.",
          reply: {
            subject: "Нужен живой разбор заявки",
            body:
              "Клиентское предложение не создано: записанный прогон не делает неподтверждённых выводов.",
          },
          checks: [
            "Исходное письмо сохранено",
            "Неподтверждённое предложение не создано",
            "Следующий шаг назначен внутренней команде",
          ],
          sources: ["Письмо клиента", "Каталог товаров"],
          decisionBasis: [
            ...result.decisionBasis,
            {
              fact:
                "Записанный прогон не получил достаточного основания для диапазонной оценки.",
              source: "Проверка записанного сценария",
              checkedAt: today,
            },
          ],
        }
    : { ...result, missing: [] };
  const commitment: Commitment =
    normalizedResult.route === "ready" && recordedEstimate
      ? "estimate"
      : normalizedResult.route === "ready" ||
          (normalizedResult.route === "manager" && normalizedResult.product)
      ? "commercial_offer"
      : "none";

  return {
    ...normalizedResult,
    schemaVersion: 2,
    resolvedIntent: {
      goal: targetClaim.replace(/^[^:]+:\s*/u, "") || targetClaim,
      target: {
        state: "resolved",
        label: targetClaim.replace(/^[^:]+:\s*/u, "") || "задача клиента",
        evidenceIds: [targetEvidence?.id ?? evidence[0].id],
      },
      evidence,
      assumptions: gapAssumptions,
      blocker: null,
    },
    visionObservation: recordedVision,
    commitment,
    estimates,
    supplierLeads: [],
    options: normalizedResult.options.map((option) => ({
      ...option,
      followUpActor: option.followUpActor ?? "internal",
    })),
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
  const deliveryPlan = deliveryPlanFromText(fullText);
  const requestedColor = colorLabelFromText(fullText);
  const facts = orderFactsFromText(evidenceText);
  const floorUse = floorUseFactsFromText(evidenceText);
  const profile = profileFor(
    {
      inn: facts.inn,
      company: input.company,
      website: input.website,
    },
    catalog.companyProfiles,
  );
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
  const explicitRequestedKg = deliveryPlan.totalKg;
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
  const firstDeliveryKg =
    product &&
    deliveryPlan.firstDeliveryKg > 0
      ? Math.min(deliveryPlan.firstDeliveryKg, requestedKg)
      : 0;
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
  const compatibilityRequested = asksCompatibility(evidenceText);
  const compatibilityCovered = productCoversRequestedUse(
    product,
    evidenceText,
  );
  if (compatibilityRequested && !compatibilityCovered) {
    missing.push("условие для проверки технологом");
  }
  const mentionedAttachment =
    /(?:вот|(?:прилаг|приклад|прилож|прикреп)\p{L}*)\s+(?:к\s+письму\s+)?(?:фото|фотограф\p{L}*|снимок)|(?:фото|фотограф\p{L}*|снимок)\s+(?:(?:прилаг|приклад|прилож|прикреп)\p{L}*|во\s+вложени\p{L}*|вложен\p{L}*)/iu.test(
      fullText,
    );
  if (mentionedAttachment && !hasAttachedPhoto) {
    missing.push("приложите фотографию");
  }
  const floorGuidance = floorGuidanceFor(profile, surface);
  if (floorGuidance && surface) {
    const floorGaps = guidedFloorGaps(surface, floorUse);
    const attachmentGap = missing.includes("приложите фотографию")
      ? ["приложите фотографию"]
      : [];
    const technicalGap =
      floorGaps.length === 0 &&
      missing.includes("условие для проверки технологом")
      ? ["условие для проверки технологом"]
      : [];
    missing.splice(
      0,
      missing.length,
      ...(floorGaps.length ? [floorGaps.join(", ")] : []),
      ...technicalGap,
      ...attachmentGap,
    );
  }

  const technicalReview = Boolean(
    product &&
      requestedKg > 0 &&
      compatibilityRequested &&
      !compatibilityCovered,
  );
  const hardRed =
    Boolean(product) &&
    requestedKg > 0 &&
    (requestedKg > (product?.stockKg ?? 0) ||
      hasSpecialTerms(fullText) ||
      technicalReview ||
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
  const baseMarketView = marketView(product, catalog.market, requestedKg);
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
    ...(requestedColor ? [`Цвет: ${requestedColor}`] : []),
    surface
      ? surface.kind === "fence"
        ? "Задача: покрасить забор"
        : `Задача: покрасить поверхность «${surface.surface}»`
      : product
        ? `Краска: ${product.name}`
        : "Задача: подобрать краску",
    ...(surface?.kind === "floor"
      ? [
          ...(floorUse.material
            ? [`Материал пола: ${floorUse.material}`]
            : []),
          ...(floorUse.purpose
            ? [`Назначение помещения: ${floorUse.purpose}`]
            : []),
          ...(floorUse.cleaning
            ? [`Уборка: ${floorUse.cleaning}`]
            : []),
          ...(floorUse.load ? [`Нагрузка: ${floorUse.load}`] : []),
        ]
      : []),
    ...(hasAttachedPhoto ? ["Фотография из заявки получена"] : []),
    ...(calculation
      ? [
          `Площадь покраски: ${decimal.format(calculation.paintAreaM2)} м²`,
          `Расчёт: ${calculation.packages} ${countedNoun(
            calculation.packages,
            "упаковка",
            "упаковки",
            "упаковок",
          )}, ${decimal.format(
            calculation.roundedKg,
          )} кг`,
        ]
      : requestedKg
        ? [
            `Объём: ${money.format(requestedKg)} кг`,
            ...(firstDeliveryKg
              ? [
                  `Первая поставка: ${money.format(
                    firstDeliveryKg,
                  )} кг; затем ${money.format(
                    requestedKg - firstDeliveryKg,
                  )} кг`,
                ]
              : []),
          ]
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
          "Ответ клиента сохранится на странице заказа вместе с письмом, вопросами и новым расчётом.",
        source: "Страница заказа и история переписки",
        checkedAt: today,
      },
      ...(product && requestedKg
        ? [stockBasis(product, requestedKg, catalog)]
        : []),
      ...(floorGuidance && profile
        ? profile.sources.map((source) => ({
            fact: source.fact,
            source: source.title,
            checkedAt: source.checkedAt,
          }))
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

    return withV2Result({
      zone: "yellow",
      decision: "clarify",
      route: "needs_info",
      confidence: hasAttachedPhoto ? 0.88 : 0.8,
      understood,
      missing,
      product: productResult(
        product,
        requestedKg,
        firstDeliveryKg,
        requestedColor,
      ),
      ...(calculation ? { calculation } : {}),
      market: view,
      research,
      businessContext:
        floorGuidance && profile
          ? guidedFloorContext(profile, product)
          : surface
            ? calculation
          ? `Агент получил площадь и материал из ${
              calculation.source === "распознанное фото"
                ? "описания фото"
                : "письма"
            }, сам подобрал краску и рассчитал ${money.format(
              calculation.roundedKg,
            )} кг. Клиенту осталось ответить только на вопросы, которые меняют предложение.`
          : surface.kind === "fence"
            ? hasAttachedPhoto
              ? "Фото дополняет заявку и помогает обсудить состояние поверхности. Материал, размеры и стороны покраски подтверждает клиент; эти данные определяют краску и количество упаковок."
              : "Клиент описал забор своими словами. Материал, размеры и стороны покраски определят краску и количество упаковок."
            : hasAttachedPhoto
              ? "Фото и описание задачи помогают определить поверхность. Материал, площадь и условия подтверждает клиент; эти данные определяют краску и количество упаковок."
              : "Описание задачи помогает определить поверхность. Материал, площадь и условия определят краску и количество упаковок."
            : product
              ? `Краска «${product.name}» найдена в каталоге. Короткий ответ клиента завершит расчёт.`
              : "Агент сохранил известные факты и подготовил самый короткий путь к точному предложению.",
      zoneReason: floorGuidance
        ? "Открытые сведения о компании изменили подбор: агент связал задачу клиента с каталогом и подготовил один вопрос для точного решения."
        : surface
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
      managerNote: floorGuidance
        ? "Ответ клиента подтвердит назначение помещения, материал пола, уборку и нагрузку. Агент продолжит этот заказ, рассчитает количество и снова проверит склад."
        : "Ответ клиента продолжит тот же заказ: агент дополнит факты, пересчитает количество и снова проверит склад.",
      options: [],
      reply:
        floorGuidance && profile && surface
          ? replyWithFloorGuidance(
              profile,
              product,
              surface,
              evidenceText,
            )
          : replyWithQuestions(
              missing,
              surface,
              hasAttachedPhoto,
              product,
              calculation,
            ),
      checks: floorGuidance
        ? [
            "Открытые сведения связаны с задачей клиента",
            "Вариант краски опирается на свойства из каталога",
            "Материал, назначение, уборка и нагрузка собраны в одном вопросе",
          ]
        : [
            "Потребность клиента сохранена в заказе",
            "Вопросы влияют на подбор или расчёт",
            "Письмо собрано по правилам завода",
          ],
      sources: [
        "Письмо клиента",
        ...(product
          ? ["Каталог товаров", "Остаток на момент расчёта"]
          : []),
        ...(floorGuidance ? ["Открытые страницы компании"] : []),
        "Правила продаж",
      ],
      decisionBasis,
      review: {
        model: "Правила обработки заказов",
        verdict: "Собраны вопросы для точного расчёта",
        notes: [
          "Известные факты сохранены",
          "Следующий шаг готов",
          "Клиенту легко ответить",
        ],
      },
    }, input);
  }

  const total = requestedKg * product.pricePerKg;
  const logistics = orderLogisticsLine(fullText);
  const nextStep = /забер|самовывоз/iu.test(logistics)
    ? "Подтвердите время самовывоза — подготовим заказ к выдаче."
    : "Пришлите точный адрес разгрузки — и мы поставим отгрузку в план.";
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
  const floorFitLine =
    floorGuidance &&
    surface?.material === "бетон" &&
    floorUse.purpose &&
    floorUse.cleaning &&
    floorUse.load
      ? `Клиент подтвердил бетонный пол, назначение «${floorUse.purpose}», уборку «${floorUse.cleaning}» и нагрузку «${floorUse.load}». По описанию в каталоге краска «${product.name}» ${product.features.join(
          ", ",
        )}.`
      : "";
  const floorClientFitLine = floorFitLine
    ? `Для бетонного пола подобрали покрытие «${product.name}». Учли назначение «${floorUse.purpose}», ежедневную уборку и движение техники. По описанию в каталоге покрытие ${product.features.join(
        ", ",
      )}.`
    : "";
  const technicalContext = technicalReview
    ? technicalReviewText(evidenceText)
    : "";
  const businessContext = profile
    ? floorFitLine
      ? `${profile.summary} ${floorFitLine} Агент рассчитал ${money.format(
          requestedKg,
        )} кг и снова проверил остаток на момент расчёта. ${technicalContext}`
      : likelyTrialOrder
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
      source: "Описание краски в каталоге и второе правило о цене",
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
  if (technicalReview) {
    decisionBasis.push({
      fact: technicalReviewText(evidenceText),
      source: "Ответ клиента и описание краски в каталоге",
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

  if (shortage || specialTerms || belowMinimum || technicalReview) {
    const availableNowKg =
      firstDeliveryKg || Math.min(product.stockKg, requestedKg);
    const remainder = Math.max(0, requestedKg - availableNowKg);
    const supplierPlan = shortage
      ? buildSupplierPlan(product, catalog.market, requestedKg)
      : null;
    const supplierDaysSaved = supplierPlan
      ? Math.max(0, product.replenishmentDays - supplierPlan.deliveryDays)
      : 0;
    const supplierSaving = supplierPlan
      ? Math.max(0, product.pricePerKg * requestedKg - supplierPlan.total)
      : 0;
    if (supplierPlan) {
      decisionBasis.push({
        fact: `Полный объём: ${money.format(
          supplierPlan.ourKg,
        )} кг со склада «Колер» и ${money.format(
          supplierPlan.supplierKg,
        )} кг у «${supplierPlan.supplierName}». Общая стоимость — ${money.format(
          supplierPlan.total,
        )} ₽, срок поставщика — ${supplierPlan.deliveryDays} ${countedNoun(
          supplierPlan.deliveryDays,
          "день",
          "дня",
          "дней",
        )}.`,
        source: "Таблица цен и наличия поставщиков",
        checkedAt: supplierPlan.stockCheckedAt,
      });
      decisionBasis.push({
        fact: `Агент сравнил ${supplierPlan.offersChecked} ${countedNoun(
          supplierPlan.offersChecked,
          "предложение",
          "предложения",
          "предложений",
        )}. ${supplierPlan.eligibleOffers} ${countedNoun(
          supplierPlan.eligibleOffers,
          "поставщик может",
          "поставщика могут",
          "поставщиков могут",
        )} привезти недостающие ${money.format(
          supplierPlan.supplierKg,
        )} кг. Выбран «${supplierPlan.supplierName}»: полный объём за ${
          supplierPlan.deliveryDays
        } ${countedNoun(
          supplierPlan.deliveryDays,
          "день",
          "дня",
          "дней",
        )} по ${money.format(supplierPlan.supplierPricePerKg)} ₽/кг.`,
        source: "Таблица цен и наличия поставщиков",
        checkedAt: supplierPlan.stockCheckedAt,
      });
    }
    const compatibleAlternative = calculation
      ? null
      : catalog.products.find(
          (candidate) =>
            product.analogues.includes(candidate.sku) &&
            candidate.stockKg >= requestedKg &&
            productHasRequestedColor(candidate, evidenceText),
        );
    const colorRequest = hasColor(fullText)
      ? "После выбора варианта отложим доступную партию для вас."
      : "Назовите точный цвет, и мы отложим доступную партию для вас.";
    const firstReply = shortage
      ? `Добрый день!\n\nПодобрали «${product.name}». ${
          floorClientFitLine ? `${floorClientFitLine} ` : ""
        }Готовы отгрузить ${money.format(
          availableNowKg,
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
        )} ₽/кг. Можем сохранить эту цену при обычной оплате до отгрузки.`;
    const technicalOptions: DemoOptionDraft[] = /масл/iu.test(evidenceText)
      ? [
      {
        id: "проверка-образца",
        title: "Проверить покрытие на образце",
        rationale:
          "Технолог получает образец вещества, условия уборки и нагрузку на пол. Клиент получает подтверждённый подбор до основной закупки.",
        businessResult:
          "Завод сохраняет заказ и закрепляет свойства покрытия результатом проверки.",
        tradeoff: "Понадобится образец и короткая проверка технолога.",
        reply: `Добрый день!\n\nДля бетонного пола и движения тележек первым вариантом стала краска «${product.name}». Контакт с моторным маслом технолог проверит на образце. Мы уже передали ему условия эксплуатации, описание краски из каталога и предварительный расчёт ${money.format(
          requestedKg,
        )} кг.\n\nПосле проверки направим подтверждённое покрытие, цену и график поставки.`,
      },
      {
        id: "пробный-участок",
        title: "Сделать пробное нанесение",
        rationale:
          "Небольшой участок покажет сцепление, уборку и поведение покрытия в условиях мастерской.",
        businessResult:
          "Завод получает фактические данные и готовит основную поставку под реальные условия.",
        tradeoff: "Основная закупка начнётся после осмотра пробного участка.",
        reply: `Добрый день!\n\nПредлагаем сначала окрасить небольшой участок пола краской «${product.name}» и проверить его в рабочих условиях. На основную площадь предварительно рассчитано ${money.format(
          requestedKg,
        )} кг. После осмотра закрепим состав и график поставки.`,
      },
      {
        id: "подбор-технолога",
        title: "Подобрать покрытие под масло",
        rationale:
          "Технолог сверит частоту контакта, способ удаления масла и нагрузку, затем выберет покрытие с подтверждёнными свойствами.",
        businessResult:
          "Завод предлагает решение под условия клиента и сохраняет потенциал полного заказа.",
        tradeoff: "Клиент уточнит вид масла и способ уборки.",
        reply:
          "Добрый день!\n\nТехнолог подберёт покрытие под контакт с моторным маслом. Пришлите название масла и опишите, как быстро его удаляют с пола. Уже учли площадь, бетонное основание и нагрузку.",
      },
        ]
      : [
          {
            id: "сверить-требование",
            title: "Сверить точное требование",
            rationale:
              "Технолог получает название документа или средства для уборки и сопоставляет его с паспортом качества и описанием краски в каталоге.",
            businessResult:
              "Завод готовит подтверждённый комплект поставки и сохраняет заказ.",
            tradeoff:
              "Клиент пришлёт точное название документа или средства.",
            reply:
              "Добрый день!\n\nПришлите точное название обязательного документа или средства для уборки. Технолог сверит требование с паспортом качества и описанием краски в каталоге, затем мы направим подтверждённое предложение.",
          },
          {
            id: "проверка-технолога",
            title: "Провести проверку технолога",
            rationale:
              "Технолог проверяет режим эксплуатации по образцу и закрепляет подходящее покрытие.",
            businessResult:
              "Завод подтверждает свойства до основной поставки.",
            tradeoff: "Понадобится образец и время на проверку.",
            reply: `Добрый день!\n\nТехнолог проверит покрытие для ваших условий. Площадь, бетонное основание, уборку и предварительный расчёт ${money.format(
              requestedKg,
            )} кг уже учли. После проверки направим состав, документы и график поставки.`,
          },
          {
            id: "подобрать-покрытие",
            title: "Подобрать покрытие по требованиям",
            rationale:
              "Технолог начинает с обязательного документа и режима уборки, затем выбирает продукт с подтверждёнными свойствами.",
            businessResult:
              "Завод формирует предложение под требования закупки.",
            tradeoff: "Подбор продолжится после одного ответа клиента.",
            reply:
              "Добрый день!\n\nНапишите обязательный документ и средство для уборки. Технолог подберёт покрытие по этим требованиям. Остальные сведения о помещении и расчёт уже сохранены.",
          },
        ];
    const options: DemoOptionDraft[] = technicalReview
      ? technicalOptions
      : shortage
      ? [
          {
            id: "две-поставки",
            title: "Начать работу с первой партией",
            rationale: `${money.format(
              availableNowKg,
            )} кг отправим сейчас, ${money.format(remainder)} кг — через ${
              product.replenishmentDays
            } дней. Клиент начинает работу раньше.`,
            businessResult:
              "Завод продаёт доступную партию сейчас и сохраняет заказ на оставшийся объём.",
            tradeoff: "Вторую партию доставим отдельно.",
            reply: firstReply,
          },
          ...(supplierPlan
            ? [
                {
                  id: "помочь-с-недостающим-объёмом",
                  followUpActor: "supplier" as const,
                  title: `Собрать ${money.format(
                    requestedKg,
                  )} кг вместе с «${supplierPlan.supplierName}»`,
                  rationale: `После подтверждения партнёра клиент сможет получить все ${money.format(
                    requestedKg,
                  )} кг ориентировочно за ${supplierPlan.deliveryDays} ${countedNoun(
                    supplierPlan.deliveryDays,
                    "день",
                    "дня",
                    "дней",
                  )}${
                    supplierDaysSaved
                      ? ` — на ${money.format(
                          supplierDaysSaved,
                        )} ${countedNoun(
                          supplierDaysSaved,
                          "день",
                          "дня",
                          "дней",
                        )} раньше`
                      : ""
                  }. Общая стоимость — ${money.format(
                    supplierPlan.total,
                  )} ₽${
                    supplierSaving
                      ? `, на ${money.format(
                          supplierSaving,
                        )} ₽ меньше расчёта по цене «Колера»`
                      : ""
                  }.`,
                  businessResult:
                    "Завод продаёт свою часть, координирует общий график и помогает клиенту начать работу раньше.",
                  tradeoff:
                    "На каждом участке нужна краска одного производителя. Технолог сверит подготовку пола, цвет и совместимость материалов.",
                  reply: `Добрый день!\n\nНа складе «Колера» доступно ${money.format(
                    supplierPlan.ourKg,
                  )} кг по ${money.format(
                    supplierPlan.ourPricePerKg,
                  )} ₽/кг. По данным от ${
                    supplierPlan.stockCheckedAt
                  } у «${supplierPlan.supplierName}» доступно ${money.format(
                    supplierPlan.supplierStockKg,
                  )} кг. Готовим запрос партнёру: подтвердить ${money.format(
                    supplierPlan.supplierKg,
                  )} кг; срок — ${supplierPlan.deliveryDays} ${countedNoun(
                    supplierPlan.deliveryDays,
                    "день",
                    "дня",
                    "дней",
                  )}; ${requestedColor ? `цвет — «${requestedColor}»` : "цвет"}; совместимость материалов. Цена партнёра по проверенной строке — ${money.format(
                    supplierPlan.supplierPricePerKg,
                  )} ₽/кг; предварительная стоимость обеих частей — ${money.format(
                    supplierPlan.total,
                  )} ₽.${
                    supplierDaysSaved
                      ? `\n\nПосле подтверждения этот вариант может сократить ожидание на ${money.format(
                          supplierDaysSaved,
                        )} ${countedNoun(
                          supplierDaysSaved,
                          "день",
                          "дня",
                          "дней",
                        )}${supplierSaving ? ` и сэкономить ${money.format(supplierSaving)} ₽` : ""} относительно расчёта всего объёма по цене «Колера».`
                      : ""
                  }\n\nПосле подтверждений пришлём единый график поставки.`,
                },
              ]
            : []),
          ...(paymentAfterDelivery
            ? [
                {
                  id: "оплата-по-партиям",
                  title: "Разделить оплату по партиям",
                  rationale: `${money.format(
                    availableNowKg,
                  )} кг клиент оплачивает перед первой отгрузкой. Для оставшихся ${money.format(
                    remainder,
                  )} кг руководитель согласует оплату после поставки.`,
                  businessResult:
                    "Завод получает оплату за первую партию до отгрузки и отдельно согласует оплату оставшегося объёма.",
                  tradeoff:
                    "Договор зафиксирует сумму и срок оплаты для каждой партии.",
                  reply: `Добрый день!\n\nПредлагаем поставить заказ двумя партиями и закрепить оплату отдельно для каждой. Первые ${money.format(
                    availableNowKg,
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
                  )} кг есть на складе. Эта краска подходит для задачи клиента.`,
                  businessResult:
                    "Завод выполняет весь заказ товаром со склада и получает оплату за весь заказ сразу.",
                  tradeoff: `Цена составит ${money.format(
                    compatibleAlternative.pricePerKg,
                  )} ₽/кг.`,
                  reply: `Добрый день!\n\nМожем поставить весь объём краской «${compatibleAlternative.name}» по цене ${money.format(
                    compatibleAlternative.pricePerKg,
                  )} ₽/кг${
                    requestedColor ? `, цвет ${requestedColor}` : ""
                  }. Весь объём есть на складе. Эта краска подходит для вашей задачи.${
                    firstDeliveryKg
                      ? ` Учтём ваш график: ${money.format(
                          firstDeliveryKg,
                        )} кг подготовим для первой поставки, оставшиеся ${money.format(
                          requestedKg - firstDeliveryKg,
                        )} кг — для следующей.`
                      : ""
                  }`,
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
                  reply: `Добрый день!\n\n${
                    floorFitLine ? `${floorFitLine}\n\n` : ""
                  }Отложим для вас ${money.format(
              availableNowKg,
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
            reply: `Добрый день!\n\n${
              floorFitLine ? `${floorFitLine}\n\n` : ""
            }Напишите, какой объём нужен для начала работ и к какой дате потребуется остальная краска. По ответу закрепим удобный график поставки.`,
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

    return withV2Result({
      zone: "red",
      decision: "escalate",
      route: "manager",
      confidence: 0.94,
      understood,
      missing: missing.slice(0, 1),
      product: productResult(
        product,
        requestedKg,
        firstDeliveryKg,
        requestedColor,
      ),
      ...(calculation ? { calculation } : {}),
      market: view,
      ...(supplierPlan ? { supplierPlan } : {}),
      research,
      businessContext,
      zoneReason: technicalReview
        ? `${technicalReviewText(
            evidenceText,
          )} Агент подготовил три готовых хода для решения.`
        : shortage
        ? [
            firstDeliveryKg
              ? `Клиент выбрал ${money.format(
                  firstDeliveryKg,
                )} кг для первой поставки. Склад подтверждает этот объём; оставшиеся ${money.format(
                  remainder,
                )} кг войдут в следующий этап поставки.`
              : `Склад подтверждает ${money.format(
                  availableNowKg,
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
      managerNote: technicalReview
        ? "Выберите способ проверки. Технолог уже получает описание помещения, описание краски из каталога, расчёт и условие клиента."
        : profile
        ? likelyTrialOrder
          ? profile.suggestedMove
          : "Уточнить график следующих закупок и заранее согласовать выпуск и доставку."
        : industry
          ? `Что предлагает агент: ${industry.play}. По этой цене завод зарабатывает на заказе.`
          : "Выберите вариант, который помогает клиенту выполнить заказ и сохраняет заработок завода.",
      options,
      reply: {
        subject: `Предложение по заказу: ${product.name}`,
        body:
          "Агент подготовил варианты и тексты писем. После выбора руководителя ответ станет готов к отправке.",
      },
      checks: [
        "По этой цене завод зарабатывает на заказе",
        shortage
          ? "Склад подтвердил доступную первую партию"
          : "Весь объём подтверждён складом",
        technicalReview
          ? "Технолог получил условия и готовый план проверки"
          : "Письмо собрано по правилам завода",
        view.items.length
          ? "Цены и наличие других поставщиков содержат дату проверки"
          : "Цена сверена с данными склада и правилом заработка",
      ],
      sources: [
        "Письмо клиента",
        "Каталог товаров",
        "Остаток на момент расчёта",
        "Правила продаж",
        ...(view.items.length ? ["Цены и наличие других поставщиков"] : []),
        ...(profile ? ["Проверенные открытые источники"] : []),
      ],
      decisionBasis,
      review: {
        model: "Правила обработки заказов",
        verdict: "Руководитель получил готовые варианты",
        notes: [
          "Цифры сверены со складом",
          "Каждый вариант можно выполнить",
          "Готовый текст приложен",
        ],
      },
    }, input);
  }

  return withV2Result({
    zone: "green",
    decision: "quote",
    route: "ready",
    confidence: 0.97,
    understood,
    missing: [],
    product: productResult(
      product,
      requestedKg,
      firstDeliveryKg,
      requestedColor,
    ),
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
      body: [
        "Добрый день!",
        input.company
          ? `Подготовили предложение для компании ${input.company}.`
          : "",
        floorClientFitLine,
        `Подтверждаем наличие: ${money.format(
          requestedKg,
        )} кг краски «${product.name}»${
          requestedColor ? `, цвет — ${requestedColor}` : ""
        }. Цена — ${money.format(
          product.pricePerKg,
        )} ₽/кг, сумма — ${money.format(total)} ₽.`,
        "Весь объём есть на складе.",
        firstDeliveryKg
          ? `Учли ваш график: ${money.format(
              firstDeliveryKg,
            )} кг подготовим для первой поставки, оставшиеся ${money.format(
              requestedKg - firstDeliveryKg,
            )} кг — для следующей.`
          : "",
        logistics ? `Учли условия из заявки: ${logistics}.` : "",
        nextStep,
        calculation
          ? `Расчёт количества: ${calculation.explanation}`
          : "",
        likelyTrialOrder
          ? "Подскажите, какие свойства краски проверяете на первой партии. Предлагаем записать фактический расход на одну машину и сверить его с текущим планом выпуска. По этим данным рассчитаем возможный объём и график следующей закупки."
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    checks: [
      "По этой цене завод зарабатывает на заказе",
      "Весь объём подтверждён складом",
      "Письмо собрано по правилам завода",
      view.items.length
        ? "Цены и наличие других поставщиков содержат дату проверки"
        : "Цена сверена с данными склада и правилом заработка",
    ],
    sources: [
      "Письмо клиента",
      "Каталог товаров",
      "Остаток на момент расчёта",
      "Правила продаж",
      ...(view.items.length ? ["Цены и наличие других поставщиков"] : []),
      ...(profile ? ["Проверенные открытые источники"] : []),
    ],
    decisionBasis,
    review: {
      model: "Правила обработки заказов",
      verdict: "Ответ готов к отправке",
      notes: [
        "Цена и объём подтверждены",
        "Сохранено обновление склада",
        "Письмо собрано по правилам",
      ],
    },
  }, input);
}
