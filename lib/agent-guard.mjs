import {
  asksCompatibility,
  colorLabelFromText,
  deliveryPlanFromText,
  explicitSkuFromText,
  floorUseFactsFromText,
  hasColor,
  hasSpecialTerms,
  hasUsableEnvironment,
  matchProduct,
  orderFactsFromText,
  quantityFromText,
  quotedUnitPrices,
} from "./order-facts.mjs";
import { buildSupplierPlan } from "./supplier-plan.mjs";

const money = new Intl.NumberFormat("ru-RU");
const decimal = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 2,
});

function countedNoun(value, one, few, many) {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  const last = value % 10;
  if (last === 1) return one;
  return last >= 2 && last <= 4 ? few : many;
}
const safeTemplateReplacementCheck =
  "Клиентский текст приведён к ясному русскому шаблону";
const safeRhetoricReplacementCheck =
  "Клиентский текст приведён к правилам деловой переписки";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasUnexpectedLatin(value) {
  return /[A-Za-z]{3,}/.test(text(value).replace(/\bRAL(?:\s*\d{4})?\b/gi, ""));
}

function hasCjk(value) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u.test(
    text(value),
  );
}

function hasForbiddenContrast(value) {
  return /(?:^|\s)не\s+[^.!?\n]{0,140}\s+а\s+/iu.test(text(value));
}

function isAllCapsHeading(value) {
  const letters = text(value).match(/[А-ЯЁа-яё]/g) ?? [];
  return (
    letters.length >= 4 &&
    letters.every((letter) => letter === letter.toLocaleUpperCase("ru-RU"))
  );
}

function cleanCopy(value) {
  const candidate = text(value).replace(
    /минимальн(?:ая|ой|ую)\s+цен[аы](?:\s+с\s+прибылью)?/giu,
    "цена, от которой завод зарабатывает на заказе",
  );
  return candidate &&
    !hasUnexpectedLatin(candidate) &&
    !hasCjk(candidate) &&
    !hasForbiddenContrast(candidate) &&
    !isAllCapsHeading(candidate)
    ? candidate
    : "";
}

function cleanClientCopy(value) {
  const candidate = cleanCopy(value);
  return candidate &&
    !/(?:\bагент\p{L}*|учебн\p{L}*\s+(?:таблиц\p{L}*|каталог\p{L}*)|этап\p{L}*\s+стенд\p{L}*|модел\p{L}*\s+(?:провер|подготов)|выбор\p{L}*\s+руководител\p{L}*)/iu.test(
      candidate,
    )
    ? candidate
    : "";
}

function cleanSourceText(value, max = 160) {
  const candidate = text(value).replace(/\s+/g, " ").slice(0, max);
  return candidate && !hasCjk(candidate) ? candidate : "";
}

function cleanList(value) {
  return Array.isArray(value)
    ? value.map(cleanCopy).filter(Boolean).slice(0, 8)
    : [];
}

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function completeText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function completeStringList(value, { allowEmpty = true } = {}) {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(completeText)
  );
}

function completeNumber(value, minimum = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function completeCalculation(value) {
  if (value === undefined) return true;
  const calculation = objectRecord(value);
  const validKind = ["fence-area", "wall-area", "floor-area"].includes(
    calculation?.kind,
  );
  const validMaterial =
    calculation?.kind === "fence-area"
      ? ["дерево", "металл"].includes(calculation.material)
      : calculation?.kind === "wall-area"
        ? ["штукатурка", "бетон", "гипсокартон"].includes(
            calculation.material,
          )
        : calculation?.kind === "floor-area"
          ? calculation.material === "бетон"
          : false;
  return Boolean(
    calculation &&
      validKind &&
      validMaterial &&
      (calculation.lengthM === null ||
        completeNumber(calculation.lengthM, 0.01)) &&
      (calculation.heightM === null ||
        completeNumber(calculation.heightM, 0.01)) &&
      completeNumber(calculation.areaPerSideM2, 0.01) &&
      completeNumber(calculation.sides, 1) &&
      completeNumber(calculation.paintAreaM2, 0.01) &&
      completeNumber(calculation.coverageKgPerM2PerCoat, 0.01) &&
      completeNumber(calculation.coats, 1) &&
      completeNumber(calculation.reservePercent) &&
      completeNumber(calculation.estimatedKg, 0.01) &&
      completeNumber(calculation.packageKg, 0.01) &&
      completeNumber(calculation.packages, 1) &&
      completeNumber(calculation.roundedKg, 0.01) &&
      completeText(calculation.explanation),
  );
}

export function isCompleteAgentResult(value) {
  const result = objectRecord(value);
  if (!result) return false;

  const expected = {
    green: { decision: "quote", route: "ready" },
    yellow: { decision: "clarify", route: "needs_info" },
    red: { decision: "escalate", route: "manager" },
  }[result.zone];
  if (
    !expected ||
    result.decision !== expected.decision ||
    result.route !== expected.route
  ) {
    return false;
  }

  const reply = objectRecord(result.reply);
  const market = objectRecord(result.market);
  const review = objectRecord(result.review);
  const product =
    result.product === null ? null : objectRecord(result.product);
  const research =
    result.research === undefined ? undefined : objectRecord(result.research);
  const options = Array.isArray(result.options) ? result.options : null;
  const decisionBasis = Array.isArray(result.decisionBasis)
    ? result.decisionBasis
    : null;

  const optionsComplete =
    options &&
    options.every((value) => {
      const option = objectRecord(value);
      return Boolean(
        option &&
          completeText(option.id) &&
          completeText(option.title) &&
          completeText(option.rationale) &&
          completeText(option.tradeoff) &&
          completeText(option.reply),
      );
    });
  const optionCountMatchesRoute =
    result.route === "manager"
      ? options && options.length >= 2 && options.length <= 3
      : options && options.length === 0;

  return Boolean(
    completeNumber(result.confidence) &&
      result.confidence <= 1 &&
      completeStringList(result.understood, { allowEmpty: false }) &&
      completeStringList(result.missing) &&
      (result.route !== "needs_info" || result.missing.length > 0) &&
      completeStringList(result.checks, { allowEmpty: false }) &&
      completeStringList(result.sources, { allowEmpty: false }) &&
      completeText(result.businessContext) &&
      completeText(result.zoneReason) &&
      completeText(result.managerNote) &&
      reply &&
      completeText(reply.subject) &&
      completeText(reply.body) &&
      market &&
      typeof market.checked === "boolean" &&
      completeText(market.summary) &&
      completeText(market.position) &&
      completeText(market.profitOpportunity) &&
      Array.isArray(market.items) &&
      market.items.every((value) => {
        const item = objectRecord(value);
        return Boolean(
          item &&
            completeText(item.competitor) &&
            completeNumber(item.pricePerKg, 0.01) &&
            completeNumber(item.deliveryDays) &&
            completeText(item.checkedAt),
        );
      }) &&
      review &&
      completeText(review.model) &&
      completeText(review.verdict) &&
      completeStringList(review.notes) &&
      optionsComplete &&
      optionCountMatchesRoute &&
      decisionBasis &&
      decisionBasis.length > 0 &&
      decisionBasis.every((value) => {
        const basis = objectRecord(value);
        return Boolean(
          basis &&
            completeText(basis.fact) &&
            completeText(basis.source) &&
            completeText(basis.checkedAt) &&
            (basis.stockVersion === undefined ||
              typeof basis.stockVersion === "string"),
        );
      }) &&
      (product === null ||
        (completeText(product.sku) &&
          completeText(product.name) &&
          completeNumber(product.stockKg) &&
          completeNumber(product.requestedKg) &&
          completeNumber(product.pricePerKg, 0.01) &&
          completeNumber(product.total) &&
          completeNumber(product.replenishmentDays))) &&
      (result.route !== "ready" || product !== null) &&
      completeCalculation(result.calculation) &&
      (research === undefined ||
        (typeof research.checked === "boolean" &&
          typeof research.summary === "string" &&
          Array.isArray(research.sources) &&
          research.sources.every((value) => {
            const source = objectRecord(value);
            return Boolean(
              source &&
                completeText(source.title) &&
                completeText(source.url) &&
                /^https?:\/\//iu.test(source.url) &&
                completeText(source.checkedAt) &&
                completeText(source.fact),
            );
          }))),
  );
}

function finiteNumber(value, minimum = 0) {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate >= minimum
    ? candidate
    : null;
}

function normalizeCalculation(value) {
  if (!value || typeof value !== "object" || value.kind !== "fence-area") {
    return undefined;
  }
  const material = ["дерево", "металл"].includes(value.material)
    ? value.material
    : "";
  const areaPerSideM2 = finiteNumber(value.areaPerSideM2, 0.01);
  const sides = finiteNumber(value.sides, 1);
  const paintAreaM2 = finiteNumber(value.paintAreaM2, 0.01);
  const coverageKgPerM2PerCoat = finiteNumber(
    value.coverageKgPerM2PerCoat,
    0.01,
  );
  const coats = finiteNumber(value.coats, 1);
  const reservePercent = finiteNumber(value.reservePercent, 0);
  const estimatedKg = finiteNumber(value.estimatedKg, 0.01);
  const packageKg = finiteNumber(value.packageKg, 0.01);
  const packages = finiteNumber(value.packages, 1);
  const roundedKg = finiteNumber(value.roundedKg, 0.01);
  const explanation = cleanCopy(value.explanation);
  if (
    !material ||
    areaPerSideM2 === null ||
    sides === null ||
    paintAreaM2 === null ||
    coverageKgPerM2PerCoat === null ||
    coats === null ||
    reservePercent === null ||
    estimatedKg === null ||
    packageKg === null ||
    packages === null ||
    roundedKg === null ||
    !explanation
  ) {
    return undefined;
  }
  return {
    kind: "fence-area",
    material,
    lengthM: finiteNumber(value.lengthM, 0.01),
    heightM: finiteNumber(value.heightM, 0.01),
    areaPerSideM2,
    sides,
    paintAreaM2,
    coverageKgPerM2PerCoat,
    coats,
    reservePercent,
    estimatedKg,
    packageKg,
    packages,
    roundedKg,
    explanation,
  };
}

function normalizeDecisionBasis(value) {
  return Array.isArray(value)
    ? value
        .map((basis) => ({
          fact: cleanCopy(basis?.fact).slice(0, 420),
          source: cleanCopy(basis?.source).slice(0, 180),
          checkedAt: cleanSourceText(basis?.checkedAt, 80),
          stockVersion: cleanSourceText(basis?.stockVersion, 100),
        }))
        .filter((basis) => basis.fact && basis.source && basis.checkedAt)
        .slice(0, 6)
    : [];
}

function safeHttpUrl(value) {
  try {
    const url = new URL(text(value));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function comparableHttpUrl(value) {
  const url = safeHttpUrl(value);
  return url ? url.replace(/#.*$/, "").replace(/\/$/, "") : "";
}

function openedSourceUrlSet(job) {
  return new Set(
    (Array.isArray(job?.openedSourceUrls) ? job.openedSourceUrls : [])
      .map(comparableHttpUrl)
      .filter(Boolean),
  );
}

function sourceWasOpened(source, job) {
  return openedSourceUrlSet(job).has(comparableHttpUrl(source?.url));
}

function normalizeResearch(value, job, matchByName = false) {
  const rawSummary = cleanCopy(value?.summary);
  const rawSourceCount = Array.isArray(value?.sources)
    ? value.sources.length
    : 0;
  const sources = Array.isArray(value?.sources)
    ? value.sources
        .map((source) => ({
          title: cleanCopy(source?.title).slice(0, 180),
          url: safeHttpUrl(source?.url),
          checkedAt: cleanSourceText(source?.checkedAt, 40),
          fact: cleanCopy(source?.fact).slice(0, 420),
        }))
        .filter(
          (source) =>
            source.title && source.url && source.checkedAt && source.fact,
        )
        .slice(0, 3)
    : [];
  const openedUrls = openedSourceUrlSet(job);
  const openedCount = sources.filter((source) =>
    openedUrls.has(comparableHttpUrl(source.url)),
  ).length;
  const checked =
    sources.length > 0 &&
    sources.length === rawSourceCount &&
    openedCount === sources.length;
  const nameMatch =
    matchByName && sources.length ? "Совпадение по названию. " : "";
  const safeSources = sources.map((source) => {
    const opened = openedUrls.has(comparableHttpUrl(source.url));
    return {
      ...source,
      fact: opened
        ? `${matchByName ? "Совпадение по названию: " : ""}${source.fact}`
        : `${nameMatch}Ссылка сохранена для проверки. Решение опирается на письмо, каталог и склад.`,
    };
  });
  const summary = checked
    ? `${nameMatch}${rawSummary || "Агент открыл сохранённые страницы и собрал сведения для решения."}`
    : sources.length
      ? `${nameMatch}Агент сохранил ссылки для проверки. Решение опирается на открытые страницы и внутренние данные.`
      : value?.checked || rawSummary
        ? `${nameMatch}Поиск завершён. Решение опирается на письмо и внутренние данные.`
        : "";

  return {
    checked,
    summary:
      summary.length > 700
        ? `${summary.slice(0, 699).replace(/\s+\S*$/, "")}…`
        : summary,
    sources: safeSources,
  };
}

function orderText(job) {
  let conversation = job?.conversation;
  if (!Array.isArray(conversation) && typeof job?.conversationJson === "string") {
    try {
      conversation = JSON.parse(job.conversationJson);
    } catch {
      conversation = [];
    }
  }
  const customerReplies = Array.isArray(conversation)
    ? conversation
        .filter((message) => message?.role === "customer")
        .map((message) => text(message?.body))
        .filter(Boolean)
        .map((body, index) => `Ответ клиента ${index + 1}: ${body}`)
        .join("\n")
    : "";
  return `${job?.subject ?? ""} ${job?.body ?? ""} ${customerReplies}`.trim();
}

function productHasRequestedColor(product, requestText) {
  const requested = colorLabelFromText(requestText);
  if (!requested) return false;

  const available = product.colors.join(" ").toLocaleLowerCase("ru-RU");
  const ral = requested.match(/\bRAL\s*\d{4}\b/iu)?.[0].toUpperCase();
  if (ral) return available.includes(ral.toLocaleLowerCase("ru-RU"));

  const color = requested.split(",")[0].toLocaleLowerCase("ru-RU");
  const knownRal = {
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

function orderLogisticsLine(value) {
  const sentence = String(value ?? "")
    .split(/[.!?\n]+/u)
    .map((item) => item.trim())
    .find((item) =>
      /достав|поставк|отгруз|забер|самовывоз/iu.test(item),
    );
  if (!sentence) return "";

  const normalized = sentence
    .replace(/\s+/g, " ")
    .replace(/^забер[её]м\b/iu, "вы заберёте")
    .replace(/^готовы\s+забрать\b/iu, "вы готовы забрать");
  return `${normalized.charAt(0).toLocaleLowerCase("ru-RU")}${normalized.slice(1)}`;
}

function orderAttachment(job) {
  if (job?.attachment && typeof job.attachment === "object") {
    return job.attachment;
  }
  if (typeof job?.attachmentJson !== "string" || !job.attachmentJson.trim()) {
    return null;
  }
  try {
    const attachment = JSON.parse(job.attachmentJson);
    return attachment && typeof attachment === "object" ? attachment : null;
  } catch {
    return null;
  }
}

function hasOrderAttachment(job) {
  const attachment = orderAttachment(job);
  return Boolean(
    attachment &&
      !Array.isArray(attachment) &&
      typeof attachment.src === "string" &&
      attachment.src.startsWith("/"),
  );
}

function orderFacts(job, demoData) {
  const sourceOrderText = orderText(job);
  const explicitSku = explicitSkuFromText(sourceOrderText);
  const matchedProduct = matchProduct(sourceOrderText, demoData.products);
  const deliveryPlan = deliveryPlanFromText(sourceOrderText);
  const requestedKg = deliveryPlan.totalKg;
  const parsedOrderFacts = orderFactsFromText(sourceOrderText);
  const floorUse = floorUseFactsFromText(sourceOrderText);
  const fence = parsedOrderFacts.fence;
  const hasWall =
    /(?:^|[^\p{L}])стен\p{L}*(?:[^\p{L}]|$)/iu.test(sourceOrderText);
  const hasFloor =
    /(?:^|[^\p{L}])пол(?:а|у|ом|ы|ов|е)?(?:[^\p{L}]|$)/iu.test(
      sourceOrderText,
    );
  const surfaceKind = hasWall === hasFloor ? "" : hasWall ? "wall" : "floor";
  const areaMatch = sourceOrderText.match(
    /(\d+(?:[.,]\d+)?)\s*(?:м\s*[²2]|кв(?:адратн\p{L}*)?\.?\s*м(?:етр\p{L}*)?|квадратн\p{L}*\s+метр\p{L}*)/iu,
  );
  const areaM2 = areaMatch
    ? Number(areaMatch[1].replace(",", "."))
    : 0;
  const surfaceMaterial =
    surfaceKind === "wall"
      ? /гипсокартон|(?:^|[^\p{L}])гкл(?:[^\p{L}]|$)/iu.test(sourceOrderText)
        ? "гипсокартон"
        : /штукатур/iu.test(sourceOrderText)
          ? "штукатурка"
          : /бетон/iu.test(sourceOrderText)
            ? "бетон"
            : ""
      : surfaceKind === "floor" &&
          /бетон|стяжк|цемент/iu.test(sourceOrderText)
        ? "бетон"
        : "";
  const surface =
    !fence && surfaceKind
      ? {
          kind: surfaceKind,
          material: surfaceMaterial,
          areaM2:
            Number.isFinite(areaM2) && areaM2 > 0 ? areaM2 : 0,
        }
      : null;
  const gaps = [];

  if (fence) {
    if (fence.material === "неясно") gaps.push("материал забора");
    if (!fence.areaPerSideM2) gaps.push("длина и высота забора");
    if (!fence.sides) gaps.push("стороны покраски");
    if (!hasColor(sourceOrderText)) gaps.push("желаемый цвет");
  } else if (surface && !requestedKg) {
    if (!surface.material) {
      gaps.push(
        surface.kind === "wall" ? "материал стены" : "материал пола",
      );
    }
    if (!surface.areaM2) {
      gaps.push(
        surface.kind === "wall" ? "площадь стен" : "площадь пола",
      );
    }
  } else if (!matchedProduct) {
    gaps.push(
      explicitSku
        ? `сверьте код ${explicitSku} с каталогом`
        : "опишите, что будете красить",
    );
  }

  if (!fence) {
    if (!requestedKg && !surface) gaps.push("объём в килограммах");
    if (!hasUsableEnvironment(sourceOrderText)) {
      gaps.push("где будут красить: на улице или в помещении");
    }
    if (!hasColor(sourceOrderText)) {
      gaps.push("цвет или номер RAL");
    }
    if (asksCompatibility(sourceOrderText)) {
      if (surface?.kind === "floor") {
        if (!floorUse.purpose) gaps.push("назначение помещения");
        if (!floorUse.cleaning) gaps.push("способ уборки");
        if (!floorUse.load) gaps.push("нагрузка на пол");
      } else {
        gaps.push("как будут пользоваться окрашенной поверхностью");
      }
    }
  }

  if (
    /(?:фото|фотограф|снимок|прикреп\p{L}*)/iu.test(sourceOrderText) &&
    !hasOrderAttachment(job)
  ) {
    gaps.push("приложите фотографию");
  }

  return {
    sourceOrderText,
    explicitSku,
    matchedProduct,
    requestedKg,
    firstDeliveryKg: deliveryPlan.firstDeliveryKg,
    color: colorLabelFromText(sourceOrderText),
    inn: parsedOrderFacts.inn,
    fence,
    surface,
    floorUse,
    gaps,
  };
}

function hasCommercialBoundary(facts) {
  const product = facts.matchedProduct;
  const priceBelowProfit =
    product &&
    quotedUnitPrices(facts.sourceOrderText).some(
      (price) => price < product.minPricePerKg,
    );

  return Boolean(
    hasSpecialTerms(facts.sourceOrderText) ||
      (facts.explicitSku && !product) ||
      (product &&
        facts.requestedKg > 0 &&
        facts.requestedKg > product.stockKg) ||
      priceBelowProfit,
  );
}

function companyResearchMatch(job, facts) {
  if (facts.inn) return "exact";
  const website = text(job?.website);
  if (website) {
    try {
      const url = new URL(
        website.includes("://") ? website : `https://${website}`,
      );
      const host = url.hostname.toLowerCase();
      if (
        host &&
        !host.endsWith(".example") &&
        host !== "example.com" &&
        host !== "www.example.com"
      ) {
        return "exact";
      }
    } catch {
      // A company name can still support a cautious search.
    }
  }
  return cleanSourceText(job?.company) ? "name" : "";
}

function comparableHost(value) {
  const source = text(value);
  if (!source) return "";
  try {
    return new URL(source.includes("://") ? source : `https://${source}`)
      .hostname.toLowerCase()
      .replace(/^www\./u, "");
  } catch {
    return "";
  }
}

function preparedProfileForJob(job, facts, demoData) {
  const profiles = Array.isArray(demoData?.companyProfiles)
    ? demoData.companyProfiles
    : [];
  if (facts.inn) {
    const byInn = profiles.find(
      (profile) => text(profile?.inn) === facts.inn,
    );
    if (byInn) return byInn;
  }

  const host = comparableHost(job?.website);
  return host
    ? profiles.find(
        (profile) => comparableHost(profile?.website) === host,
      ) ?? null
    : null;
}

function preparedResearchFor(profile) {
  if (!profile) return null;
  const rawSources = Array.isArray(profile.sources) ? profile.sources : [];
  const sources = rawSources
    .map((source) => ({
      title: cleanCopy(source?.title).slice(0, 180),
      url: safeHttpUrl(source?.url),
      checkedAt: cleanSourceText(source?.checkedAt, 40),
      fact: cleanCopy(source?.fact).slice(0, 420),
    }))
    .filter(
      (source) =>
        source.title && source.url && source.checkedAt && source.fact,
    )
    .slice(0, 3);
  if (!sources.length || sources.length !== Math.min(rawSources.length, 3)) {
    return null;
  }
  return {
    checked: true,
    summary: `${cleanCopy(profile.summary)} Источники заранее проверены для демонстрации.`,
    sources,
  };
}

function fenceCalculation(facts, demoData) {
  const fence = facts.fence;
  const product = facts.matchedProduct;
  if (
    !fence ||
    !product ||
    fence.material === "неясно" ||
    !fence.areaPerSideM2 ||
    !fence.sides
  ) {
    return undefined;
  }

  const paintAreaM2 = fence.areaPerSideM2 * fence.sides;
  const coverageKgPerM2PerCoat = Number(product.coverageKgPerM2PerCoat);
  const coats = Number(product.recommendedCoats);
  const reservePercent = Number(
    demoData.rules?.calculationReservePercent ?? 10,
  );
  const packageKg = Number(product.packKg);
  if (
    !Number.isFinite(coverageKgPerM2PerCoat) ||
    coverageKgPerM2PerCoat <= 0 ||
    !Number.isFinite(coats) ||
    coats <= 0 ||
    !Number.isFinite(packageKg) ||
    packageKg <= 0
  ) {
    return undefined;
  }

  const estimatedKg =
    paintAreaM2 *
    coverageKgPerM2PerCoat *
    coats *
    (1 + reservePercent / 100);
  const packages = Math.ceil(estimatedKg / packageKg);
  const roundedKg = packages * packageKg;

  return {
    kind: "fence-area",
    material: fence.material,
    lengthM: fence.lengthM,
    heightM: fence.heightM,
    areaPerSideM2: fence.areaPerSideM2,
    sides: fence.sides,
    paintAreaM2,
    coverageKgPerM2PerCoat,
    coats,
    reservePercent,
    estimatedKg,
    packageKg,
    packages,
    roundedKg,
    explanation: `${decimal.format(
      paintAreaM2,
    )} м² × ${coats} слоя × ${decimal.format(
      coverageKgPerM2PerCoat,
    )} кг/м² + ${decimal.format(
      reservePercent,
    )}% запаса = ${decimal.format(
      estimatedKg,
    )} кг. Берём ${packages} ${countedNoun(
      packages,
      "упаковку",
      "упаковки",
      "упаковок",
    )} по ${decimal.format(packageKg)} кг: ${decimal.format(roundedKg)} кг.`,
  };
}

function surfaceCalculation(facts, demoData) {
  const surface = facts.surface;
  const product = facts.matchedProduct;
  if (
    !surface ||
    !product ||
    !surface.material ||
    !surface.areaM2 ||
    facts.requestedKg > 0 ||
    !Array.isArray(product.substrates) ||
    !product.substrates.includes(surface.material)
  ) {
    return undefined;
  }

  const coverageKgPerM2PerCoat = Number(product.coverageKgPerM2PerCoat);
  const coats = Number(product.recommendedCoats);
  const reservePercent = Number(
    demoData.rules?.calculationReservePercent ?? 10,
  );
  const packageKg = Number(product.packKg);
  if (
    ![coverageKgPerM2PerCoat, coats, reservePercent, packageKg].every(
      Number.isFinite,
    ) ||
    coverageKgPerM2PerCoat <= 0 ||
    coats <= 0 ||
    reservePercent < 0 ||
    packageKg <= 0
  ) {
    return undefined;
  }

  const estimatedKg =
    surface.areaM2 *
    coverageKgPerM2PerCoat *
    coats *
    (1 + reservePercent / 100);
  const packages = Math.ceil(estimatedKg / packageKg);
  const roundedKg = packages * packageKg;
  const surfaceLabel = surface.kind === "wall" ? "стена" : "пол";

  return {
    kind: surface.kind === "wall" ? "wall-area" : "floor-area",
    surface: surfaceLabel,
    material: surface.material,
    source: "письмо клиента",
    lengthM: null,
    heightM: null,
    areaPerSideM2: surface.areaM2,
    sides: 1,
    paintAreaM2: surface.areaM2,
    coverageKgPerM2PerCoat,
    coats,
    reservePercent,
    estimatedKg: Number(estimatedKg.toFixed(2)),
    packageKg,
    packages,
    roundedKg,
    explanation: `${decimal.format(surface.areaM2)} м² × ${coats} слоя × ${decimal.format(
      coverageKgPerM2PerCoat,
    )} кг/м² + ${decimal.format(
      reservePercent,
    )}% запаса = ${decimal.format(
      estimatedKg,
    )} кг. Берём ${packages} ${countedNoun(
      packages,
      "упаковку",
      "упаковки",
      "упаковок",
    )} по ${decimal.format(packageKg)} кг: ${decimal.format(roundedKg)} кг.`,
  };
}

function groundedUnderstanding(job, facts) {
  const company = cleanSourceText(job?.company);
  const hasAttachment = hasOrderAttachment(job);
  const understood = [
    company ? `Компания из заявки: ${company}` : "",
    facts.fence ? "Задача клиента: покрасить забор" : "",
    facts.surface?.kind === "floor" ? "Задача клиента: покрасить пол" : "",
    facts.fence && hasAttachment ? "Фотография приложена к заявке" : "",
    facts.fence && facts.fence.material !== "неясно"
      ? `Материал забора: ${facts.fence.material}`
      : "",
    facts.matchedProduct
      ? `Краска по каталогу: ${facts.matchedProduct.name}`
      : "",
    facts.fence?.paintAreaM2
      ? `Площадь покраски: ${decimal.format(facts.fence.paintAreaM2)} м²`
      : "",
    facts.surface?.areaM2
      ? `Площадь пола: ${decimal.format(facts.surface.areaM2)} м²`
      : "",
    facts.floorUse?.material
      ? `Материал пола: ${facts.floorUse.material}`
      : "",
    facts.floorUse?.purpose
      ? `Назначение помещения: ${facts.floorUse.purpose}`
      : "",
    facts.floorUse?.cleaning
      ? `Уборка: ${facts.floorUse.cleaning}`
      : "",
    facts.floorUse?.load ? `Нагрузка: ${facts.floorUse.load}` : "",
    facts.requestedKg
      ? `Объём из письма: ${money.format(facts.requestedKg)} кг`
      : "",
  ].filter(Boolean);
  return understood.length
    ? understood
    : ["Добавьте детали заказа — агент сразу начнёт расчёт."];
}

function industryFor(job, demoData) {
  const source = `${orderText(job)} ${job?.company ?? ""}`.toLowerCase();
  if (/(машиностро|волгамаш|завод|машин|оборудован)/.test(source)) {
    return demoData.industries[1];
  }
  if (/(строит|строй|объект|подряд|девелоп|ремонт|офис)/.test(source)) {
    return demoData.industries[2];
  }
  if (/(склад|логистическ|терминал|покрыти[ея]\s+пола)/.test(source)) {
    return demoData.industries[3];
  }
  if (/(металлоконструк|антикорроз|корроз)/.test(source)) {
    return demoData.industries[0];
  }
  return null;
}

function groundedBusinessContext({
  facts,
  industry,
  openedResearchSources,
}) {
  const researchFacts = openedResearchSources
    .map((source) => source.fact)
    .filter(Boolean);
  const product = facts.matchedProduct;
  const productLine = product
    ? `Каталог подтверждает для «${product.name}»: ${product.features.join(
        ", ",
      )}.`
    : "";
  const publicContext = researchFacts.join(" ");
  const companyAndOrder = `${publicContext} ${facts.sourceOrderText}`;
  const profileSuggestsRegulatedWarehouse =
    facts.surface?.kind === "floor" &&
    /фармацевт|медицин|лекарств|логистическ\p{L}*\s+(?:парк|склад)|мультитемпературн\p{L}*\s+хранени/iu.test(
      companyAndOrder,
    );
  const floorUseConfirmed = Boolean(
    facts.floorUse?.material &&
      facts.floorUse?.purpose &&
      facts.floorUse?.cleaning &&
      facts.floorUse?.load,
  );
  const hypothesis = profileSuggestsRegulatedWarehouse
    ? floorUseConfirmed
      ? `Клиент подтвердил бетонный пол, назначение «${facts.floorUse.purpose}», уборку «${facts.floorUse.cleaning}» и нагрузку «${facts.floorUse.load}». Каталог подтверждает КР-003 для бетонного пола внутри цехов и складов и для нагрузки от тележек и техники.`
      : "Агент предполагает, что краска нужна для склада компании, и проверит это одним вопросом. Для бетонного пола склада, по которому ездит техника, первым вариантом станет КР-003."
    : "";
  const needsCompatibilityDetails =
    asksCompatibility(facts.sourceOrderText) &&
    (facts.surface?.kind !== "floor" ||
      !facts.floorUse?.cleaning ||
      !facts.floorUse?.load);
  const asksSpecificProof =
    /ГОСТ|GMP|ISO|СанПиН|дезинф|дезсредств|химическ\p{L}*\s+стойк/iu.test(
      facts.sourceOrderText,
    );
  const compatibilityStep = needsCompatibilityDetails
    ? facts.surface?.kind === "floor"
      ? "Клиент сообщил о ежедневной уборке. Агент уточнит материал пола, назначение помещения, средство для уборки и нагрузку перед расчётом."
      : "Агент уточнит условия использования поверхности перед расчётом."
    : asksSpecificProof
      ? "Технолог проверит точное требование к документу или средству до предложения."
    : "";
  const quantityStep =
    product && !facts.requestedKg && !facts.surface
      ? "Письмо связано с каталогом. После ответа об объёме агент сверит остаток на момент расчёта и соберёт расчёт."
      : "";
  const industryLine =
    industry && !hypothesis
      ? `Для клиента важно: ${industry.risk}. Агент предлагает: ${industry.play}.`
      : "";

  return [
    publicContext,
    hypothesis,
    productLine,
    compatibilityStep,
    quantityStep,
    industryLine,
  ]
    .filter(Boolean)
    .join(" ");
}

function marketSnapshot(product, demoData, requestedKg) {
  const items = demoData.market
    .filter((item) => item.category === product.category)
    .map(
      ({
        competitor,
        pricePerKg,
        deliveryDays,
        checkedAt,
        stockKg,
        stockCheckedAt,
      }) => ({
      competitor,
      pricePerKg,
      deliveryDays,
      checkedAt,
        stockKg,
        stockCheckedAt,
      }),
    );

  const comparison = items
    .map(
      (item) =>
        `${item.competitor}: ${money.format(item.pricePerKg)} ₽/кг, срок ${
          item.deliveryDays
        } дн.`,
    )
    .join(" ");
  const marketAverage = items.length
    ? Math.round(
        items.reduce((sum, item) => sum + item.pricePerKg, 0) / items.length,
      )
    : 0;
  const marketMax = items.length
    ? Math.max(...items.map((item) => item.pricePerKg))
    : 0;
  const difference = product.pricePerKg - marketAverage;
  const marketReference =
    items.length === 1
      ? "цены другого поставщика"
      : "средней цены других поставщиков";
  const equalMarketReference =
    items.length === 1
      ? "с ценой другого поставщика"
      : "со средней ценой других поставщиков";
  const closeToAverage =
    marketAverage > 0 &&
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
  const position =
    marketAverage === 0
      ? `Цена ${money.format(
          product.pricePerKg,
        )} ₽/кг взята из описания краски в каталоге. Завод зарабатывает при цене от ${money.format(
          product.minPricePerKg,
        )} ₽/кг.`
      : closeToAverage
        ? Math.round(Math.abs(difference)) === 0
          ? `Наша цена ${money.format(
              product.pricePerKg,
            )} ₽/кг совпадает ${equalMarketReference}. ${availability}`
          : `Наша цена ${money.format(product.pricePerKg)} ₽/кг, на ${money.format(
              Math.round(Math.abs(difference)),
            )} ₽ ${difference > 0 ? "выше" : "ниже"} ${marketReference}. ${
              difference > 0
                ? "Цена близка к рынку."
                : "Цена выглядит привлекательно."
            } ${availability}`
        : difference < 0
          ? `Наша цена ${money.format(
              product.pricePerKg,
            )} ₽/кг на ${money.format(
              Math.round(Math.abs(difference)),
            )} ₽ ниже ${marketReference}.`
          : `Наша цена ${money.format(
              product.pricePerKg,
            )} ₽/кг, на ${money.format(
              Math.round(difference),
            )} ₽ выше ${marketReference}. Агент покажет клиенту наличие, срок и свойства краски. ${availability}`;
  const priceRoom = marketMax - product.pricePerKg;
  const profitOpportunity =
    priceRoom > 0
      ? `На следующем похожем заказе можно проверить цену до ${money.format(
          marketMax,
        )} ₽/кг при сопоставимых свойствах, объёме и сроке. Журнал покажет результат.`
      : "Заработать больше поможет крупный заказ или удобный график поставки.";

  return {
    checked: true,
    summary: comparison
      ? `Цены других поставщиков. ${comparison} Цена «Колер»: ${money.format(
          product.pricePerKg,
        )} ₽/кг.`
      : `Цена ${money.format(
          product.pricePerKg,
        )} ₽/кг взята из описания краски в каталоге. Завод зарабатывает при цене от ${money.format(
          product.minPricePerKg,
        )} ₽/кг.`,
    items,
    position,
    profitOpportunity,
  };
}

function productCoversRequestedUse(product, requestText) {
  const features = Array.isArray(product?.features)
    ? product.features.join(" ")
    : "";
  if (!features) return false;
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

function technicalReviewSummary(requestText) {
  if (/масл/iu.test(requestText)) {
    return "Клиент сообщил о регулярном контакте пола с моторным маслом. Агент собрал условия, расчёт и описание краски из каталога; технолог проверит стойкость на образце и закрепит подходящее покрытие.";
  }
  if (/дезинф|дезсредств/iu.test(requestText)) {
    return "Клиент использует дезинфицирующее средство. Агент передаст технологу название средства, режим уборки, расчёт и описание краски из каталога для точного подтверждения.";
  }
  return "Клиент указал обязательный документ. Агент передаст технологу точное требование, описание краски из каталога и готовый расчёт для проверки комплекта поставки.";
}

function technicalReviewOptions(product, requestedKg, requestText) {
  if (/масл/iu.test(requestText)) {
    return [
      {
        id: "проверка-образца",
        title: "Проверить покрытие на образце",
        rationale:
          "Технолог получает образец вещества, условия уборки и нагрузку на пол.",
        tradeoff: "Понадобится образец и короткая проверка технолога.",
        reply: `Для бетонного пола и движения тележек первым вариантом стала краска «${product.name}». Контакт с моторным маслом технолог проверит на образце. Предварительный расчёт — ${money.format(
          requestedKg,
        )} кг. После проверки направим подтверждённое покрытие, цену и график поставки.`,
      },
      {
        id: "пробный-участок",
        title: "Сделать пробное нанесение",
        rationale:
          "Небольшой участок покажет поведение покрытия в условиях мастерской.",
        tradeoff: "Основная закупка начнётся после осмотра пробного участка.",
        reply: `Предлагаем сначала окрасить небольшой участок пола краской «${product.name}». На основную площадь предварительно рассчитано ${money.format(
          requestedKg,
        )} кг. После осмотра закрепим состав и график поставки.`,
      },
      {
        id: "подбор-технолога",
        title: "Подобрать покрытие под масло",
        rationale:
          "Технолог сверит частоту контакта, способ удаления масла и нагрузку.",
        tradeoff: "Клиент уточнит вид масла и способ уборки.",
        reply:
          "Технолог подберёт покрытие под контакт с моторным маслом. Пришлите название масла и опишите, как быстро его удаляют с пола. Остальные условия уже сохранены в заказе.",
      },
    ];
  }

  return [
    {
      id: "сверить-требование",
      title: "Сверить точное требование",
      rationale:
        "Технолог сопоставит название документа или средства с паспортом качества и описанием краски в каталоге.",
      tradeoff: "Клиент пришлёт точное название документа или средства.",
      reply:
        "Пришлите точное название обязательного документа или средства для уборки. Технолог сверит требование с паспортом качества и описанием краски в каталоге, затем мы направим подтверждённое предложение.",
    },
    {
      id: "проверка-технолога",
      title: "Провести проверку технолога",
      rationale:
        "Технолог проверит режим эксплуатации по образцу и закрепит подходящее покрытие.",
      tradeoff: "Понадобится образец и время на проверку.",
      reply: `Технолог проверит покрытие для ваших условий. Площадь, бетонное основание, уборку и предварительный расчёт ${money.format(
        requestedKg,
      )} кг уже сохранены. После проверки направим состав, документы и график поставки.`,
    },
    {
      id: "подобрать-покрытие",
      title: "Подобрать покрытие по требованиям",
      rationale:
        "Технолог начинает с обязательного документа и режима уборки.",
      tradeoff: "Подбор продолжится после одного ответа клиента.",
      reply:
        "Напишите обязательный документ и средство для уборки. Технолог подберёт покрытие по этим требованиям. Остальные сведения о помещении и расчёт уже сохранены.",
    },
  ];
}

function optionIsSafe(option) {
  if (!option || typeof option !== "object") return false;
  return (
    !isAllCapsHeading(option.title) &&
    ["title", "rationale", "tradeoff"].every((key) =>
      Boolean(cleanCopy(option[key])),
    ) && Boolean(cleanClientCopy(option.reply))
  );
}

function mentionedProduct(value, products) {
  const source = text(value).toLowerCase();
  return products.find(
    (product) =>
      source.includes(product.sku.toLowerCase()) ||
      source.includes(product.name.toLowerCase()),
  );
}

function optionCopy(option) {
  return [
    option?.title,
    option?.rationale,
    option?.tradeoff,
    option?.reply,
  ]
    .map(text)
    .join(" ");
}

function targetProductForOption(option, product, demoData) {
  return (
    mentionedProduct(option?.reply, demoData.products) ??
    mentionedProduct(optionCopy(option), demoData.products) ??
    product
  );
}

function offersUnapprovedAnalogue(option, product, demoData) {
  const copy = optionCopy(option).toLowerCase();
  const approvedSkus = new Set([product.sku, ...product.analogues]);
  const mentionedSkus = [
    ...copy.matchAll(/кр-\d{1,4}/gi),
  ].map((match) => match[0].toUpperCase());
  if (mentionedSkus.some((sku) => !approvedSkus.has(sku))) return true;

  return demoData.products.some(
    (candidate) =>
      candidate.sku !== product.sku &&
      !product.analogues.includes(candidate.sku) &&
      (copy.includes(candidate.sku.toLowerCase()) ||
        copy.includes(candidate.name.toLowerCase())),
  );
}

function offersUnavailableColor(
  option,
  product,
  requestText,
  demoData,
) {
  const targetProduct = targetProductForOption(option, product, demoData);
  return (
    targetProduct.sku !== product.sku &&
    !productHasRequestedColor(targetProduct, requestText)
  );
}

function promisesUnavailableFullVolume(
  option,
  product,
  requestedKg,
  demoData,
) {
  if (requestedKg <= 0) return false;
  const reply = text(option?.reply);
  const promisesDelivery =
    /(подтвержд\w*|в\s+наличии|есть\s+на\s+складе|доступн\w*|отгруз\w*|постав\w*|достав\w*|закро\w*|обеспеч\w*|зарезервир\w*|можем\s+(?:предложить|поставить|отгрузить|закрыть)|готовы\s+(?:предложить|поставить|отгрузить|закрыть))/i.test(
      reply,
    );
  if (!promisesDelivery) return false;

  const targetProduct = targetProductForOption(
    option,
    product,
    demoData,
  );
  const promisesFullVolume =
    /(?:полный|весь)\s+объ[её]м/i.test(reply) ||
    quantityFromText(reply) >= requestedKg;

  return promisesFullVolume && targetProduct.stockKg < requestedKg;
}

function quotesBelowMinimum(option, product, demoData) {
  const reply = text(option?.reply);
  const targetProduct = targetProductForOption(
    option,
    product,
    demoData,
  );
  return quotedUnitPrices(reply).some(
    (price) => price < targetProduct.minPricePerKg,
  );
}

function fallbackOptions(
  product,
  requestedKg,
  demoData,
  allowAlternative = true,
  requestText = "",
  requestedFirstDeliveryKg = 0,
) {
  const availableKg = Math.min(product.stockKg, requestedKg);
  const missingKg = Math.max(0, requestedKg - availableKg);
  const firstDeliveryKg = Math.min(
    requestedFirstDeliveryKg || availableKg,
    availableKg,
  );
  const nextDeliveryKg = Math.max(0, requestedKg - firstDeliveryKg);

  if (missingKg === 0) {
    return [
      {
        id: "standard",
        title: "Предложить обычную цену и срок",
        rationale:
          "Подтвердить наличие и цену, предложить обычный срок оплаты и поставки.",
        tradeoff: "Клиент сразу увидит действующие условия.",
        reply: `Подтверждаем наличие ${money.format(
          requestedKg,
        )} кг краски «${product.name}» по цене ${money.format(
          product.pricePerKg,
        )} ₽/кг. Готовы согласовать поставку на обычных условиях.`,
      },
      {
        id: "volume",
        title: "Дать лучшую цену за план закупок",
        rationale:
          "Клиент заранее согласует объём на квартал и вносит предоплату.",
        tradeoff:
          "Руководитель увидит план закупок и выберет цену.",
        reply: `Готовы обсудить лучшую цену, если согласуем закупки на квартал и предоплату. Текущая цена составляет ${money.format(
          product.pricePerKg,
        )} ₽/кг.`,
      },
      {
        id: "clarify",
        title: "Спросить, что важнее клиенту",
        rationale:
          "Уточнить, что важнее: срок, цена или порядок оплаты.",
        tradeoff: "Расчёт продолжится после одного короткого ответа.",
        reply:
          "Что для вас важнее: срок, цена или порядок оплаты? По ответу подготовим подходящий вариант.",
      },
    ];
  }

  const alternative = demoData.products.find(
    (candidate) =>
      product.analogues.includes(candidate.sku) &&
      candidate.stockKg >= requestedKg &&
      productHasRequestedColor(candidate, requestText),
  );
  const supplierPlan = buildSupplierPlan(
    product,
    demoData.market,
    requestedKg,
  );
  const supplierDaysSaved = supplierPlan
    ? Math.max(0, product.replenishmentDays - supplierPlan.deliveryDays)
    : 0;
  const supplierSaving = supplierPlan
    ? Math.max(0, product.pricePerKg * requestedKg - supplierPlan.total)
    : 0;
  const requestedColor = colorLabelFromText(requestText);

  const options = [
    {
      id: "две-поставки",
      title: "Разделить поставку",
      rationale: `Отгрузить ${money.format(
        firstDeliveryKg,
      )} кг из наличия и поставить ${money.format(
        nextDeliveryKg,
      )} кг после пополнения через ${product.replenishmentDays} дней.`,
      tradeoff:
        "Клиент запускает работу с первой партией и заранее получает график второй.",
      reply: `Предлагаем разделить поставку: ${money.format(
        firstDeliveryKg,
      )} кг отгрузим из наличия, ещё ${money.format(
        nextDeliveryKg,
      )} кг поставим после пополнения склада через ${
        product.replenishmentDays
      } дней. Цена составляет ${money.format(product.pricePerKg)} ₽/кг.`,
    },
  ];

  if (supplierPlan) {
    options.push({
      id: "помочь-с-недостающим-объёмом",
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
          ? ` — на ${money.format(supplierDaysSaved)} ${countedNoun(
              supplierDaysSaved,
              "день",
              "дня",
              "дней",
            )} раньше`
          : ""
      }. Общая стоимость — ${money.format(supplierPlan.total)} ₽${
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
    });
  }

  if (allowAlternative && alternative) {
    options.push({
      id: "alternative",
      title: `Предложить ${alternative.name}`,
      rationale: `${money.format(
        alternative.stockKg,
      )} кг есть на складе. Эта краска подходит для задачи клиента.`,
      tradeoff: `Цена составляет ${money.format(
        alternative.pricePerKg,
      )} ₽/кг. В письме прямо указана выбранная замена.`,
      reply: `Можем предложить ${alternative.name} из наличия в полном объёме. Цена составляет ${money.format(
        alternative.pricePerKg,
      )} ₽/кг. Эта краска подходит для вашей задачи.`,
    });
  }

  options.push({
    id: "contract",
    title: "Добавить краску в ближайший выпуск",
    rationale: `Добавить недостающие ${money.format(
      missingKg,
    )} кг в ближайшем выпуске.`,
    tradeoff:
      "Производство подтвердит срок, руководитель закрепит условия до отправки письма.",
    reply: `Готовы добавить недостающие ${money.format(
      missingKg,
    )} кг в ближайшем выпуске. После подтверждения заказа закрепим цену и направим точный график поставки.`,
  });

  options.push({
    id: "clarify",
    title: "Уточнить нужный график",
    rationale:
      "Получить от клиента минимальный объём первой партии и крайний срок второй.",
    tradeoff: "Расчёт продолжится после одного короткого ответа.",
    reply:
      "Уточните минимальный объём первой партии и крайний срок второй. По ответу сразу закрепим выполнимый график.",
  });

  return options.slice(0, 3);
}

function fallbackReply(result, job, demoData, facts) {
  const safeJobSubject = cleanCopy(job?.subject);
  const subject = `Предложение по заказу: ${safeJobSubject || "краска"}`;

  if (result.zone === "yellow") {
    const questionFor = (item) =>
      ({
        "материал забора":
          "Из чего сделан забор: из дерева, металла или другого материала?",
        "длина и высота забора":
          "Напишите длину и среднюю высоту забора. Можно указать готовую площадь.",
        "стороны покраски": "Красим одну сторону забора или обе?",
        "желаемый цвет": "Какой цвет хотите получить?",
        "объём в килограммах": "Сколько килограммов краски нужно?",
        "где будут красить: на улице или в помещении":
          "Где будете красить: на улице или в помещении?",
        "цвет или номер RAL":
          "Какой цвет нужен? Можно описать его словами или указать номер из каталога цветов RAL.",
        "приложите фотографию":
          "Приложите фотографию, которую упомянули в письме.",
      })[item] ?? item;
    const questions = result.missing.length
      ? result.missing.length === 1 &&
        /^Подскажите, пожалуйста:/iu.test(result.missing[0])
        ? result.missing[0]
        : result.missing.map((item) => `— ${questionFor(item)}`).join("\n")
      : "— что будете красить\n— сколько краски нужно\n— улица или помещение";
    const sourceProduct = result.product
      ? demoData?.products?.find(
          (product) => product.sku === result.product.sku,
        )
      : null;
    const researchedFloor =
      sourceProduct?.sku === "КР-003" &&
      result.research?.checked &&
      /фармацевт|медицин|лекарств|мультитемпературн|логистическ\p{L}*\s+(?:парк|склад)/iu.test(
        result.businessContext,
      );
    if (researchedFloor) {
      const requestedColor = colorLabelFromText(orderText(job));
      const colorLine =
        requestedColor &&
        Array.isArray(sourceProduct.colors) &&
        sourceProduct.colors.some(
          (color) =>
            text(color).toLocaleLowerCase("ru-RU") ===
            requestedColor.toLocaleLowerCase("ru-RU"),
        )
          ? `Запрошенный цвет «${requestedColor}» есть в каталоге.`
          : requestedColor
            ? `Учли запрошенный цвет «${requestedColor}».`
            : "";
      const documentRequest =
        /ГОСТ|GMP|ISO|СанПиН|дезинф|дезсредств|химическ\p{L}*\s+стойк/iu.test(
          orderText(job),
        )
          ? "Пришлите точное требование к документу или средству — технолог проверит его до предложения."
          : "";
      return {
        subject: "Один вопрос для точного подбора краски",
        body: [
          "Добрый день!",
          [
            "Как используют помещение?",
            `Чтобы подобрать покрытие${
              facts?.surface?.areaM2
                ? ` для ${decimal.format(facts.surface.areaM2)} м²`
                : ""
            }, выберите ближайший вариант:`,
            "— медицинский склад: материал пола, средство для ежедневной уборки, техника на полу и нужные документы;",
            "— обычный склад: материал пола, уборка и техника;",
            "— другое помещение: назначение, материал пола, уборка и нагрузка.",
          ].join("\n"),
          "На сайте группы описаны фармацевтические и медицинские направления и складской комплекс. Похоже, помещение может быть складом.",
          `Если его используют как медицинский склад, пол бетонный, его моют нейтральным средством и по нему ездят тележки, первым вариантом станет краска «${sourceProduct.name}». Описание краски в каталоге подтверждает такую уборку, нагрузку от техники и паспорт качества на партию.`,
          colorLine,
          documentRequest,
          "Если помещение используют иначе, подберём покрытие по назначению, нагрузке и условиям уборки.",
          facts?.surface?.areaM2
            ? `После ответа рассчитаем заказ на ${decimal.format(
                facts.surface.areaM2,
              )} м², проверим цвет и свежий остаток на складе.`
            : "После ответа рассчитаем количество краски и проверим остаток на складе.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    }
    return {
      subject: `Уточнение по заказу: ${safeJobSubject || "краска"}`,
      body: `Добрый день!\n\nЧтобы подготовить точное предложение, уточните:\n${questions}\n\nПосле ответа проверим наличие, цену и срок поставки.`,
    };
  }

  if (result.product) {
    const sourceOrderText = orderText(job);
    const color = colorLabelFromText(sourceOrderText);
    const logistics = orderLogisticsLine(sourceOrderText);
    const sourceProduct = demoData?.products?.find(
      (product) => product.sku === result.product.sku,
    );
    const floorFitLine =
      facts?.surface?.kind === "floor" &&
      facts.floorUse?.material === "бетон" &&
      facts.floorUse?.purpose &&
      facts.floorUse?.cleaning &&
      facts.floorUse?.load &&
      sourceProduct
        ? `Для вашей задачи выбрали эту краску по описанию в каталоге: она ${sourceProduct.features.join(
            ", ",
          )}.`
        : "";
    const nextStep = /забер|самовывоз/iu.test(logistics)
      ? "Подтвердите время самовывоза — подготовим заказ к выдаче."
      : "Пришлите точный адрес разгрузки — и мы запланируем отгрузку.";
    return {
      subject,
      body: [
        "Добрый день!",
        "",
        floorFitLine,
        `Подтверждаем наличие: ${money.format(
          result.product.requestedKg,
        )} кг краски «${result.product.name}»${
          color ? `, цвет — ${color}` : ""
        }. Цена — ${money.format(
          result.product.pricePerKg,
        )} ₽/кг, сумма — ${money.format(result.product.total)} ₽.`,
        logistics ? `Учли условия из заявки: ${logistics}.` : "",
        nextStep,
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  return {
    subject,
    body: "Агент подготовил ответ по подтверждённым данным.",
  };
}

export function normalizeAgentResult(result, demoData, job = {}) {
  if (!result || typeof result !== "object") {
    throw new Error(
      "Ответ модели нужно пересобрать. Запустите обработку заказа снова.",
    );
  }

  const rawOptionCount = Array.isArray(result.options)
    ? result.options.length
    : 0;
  const rawResearch = objectRecord(result.research);
  const rawResearchSources = Array.isArray(rawResearch?.sources)
    ? rawResearch.sources
    : [];
  const hadResearchClaim = Boolean(
    rawResearch?.checked ||
      text(rawResearch?.summary) ||
      rawResearchSources.length,
  );
  const rawClientCopy = [
    result.reply?.body,
    ...(Array.isArray(result.options)
      ? result.options.map((option) => option?.reply)
      : []),
  ].join("\n");
  const replacedUnexpectedLatin =
    hasUnexpectedLatin(result.reply?.subject) ||
    hasUnexpectedLatin(rawClientCopy) ||
    (Array.isArray(result.checks) &&
      result.checks.includes(safeTemplateReplacementCheck));
  const replacedForbiddenRhetoric =
    hasForbiddenContrast(result.reply?.subject) ||
    hasForbiddenContrast(rawClientCopy) ||
    (Array.isArray(result.checks) &&
      result.checks.includes(safeRhetoricReplacementCheck));
  const facts = orderFacts(job, demoData);
  const safeCalculation =
    fenceCalculation(facts, demoData) ??
    surfaceCalculation(facts, demoData) ??
    (facts.fence || facts.surface
      ? undefined
      : normalizeCalculation(result.calculation));
  const safeDecisionBasis = normalizeDecisionBasis(result.decisionBasis);
  const {
    sourceOrderText,
    explicitSku,
    matchedProduct,
    requestedKg: requestedFromText,
    firstDeliveryKg,
    color: requestedColor,
  } = facts;
  const requestedFromOrder =
    requestedFromText || safeCalculation?.roundedKg || 0;
  const explicitProduct = explicitSku ? matchedProduct : null;
  const modelSku = text(result.product?.sku).toUpperCase();
  const modelSkuMismatch = Boolean(
    matchedProduct && modelSku && modelSku !== matchedProduct.sku,
  );
  let sourceFactGaps = facts.gaps.filter(
    (gap) => !(safeCalculation && gap === "объём в килограммах"),
  );
  if (
    facts.surface?.kind === "floor" &&
    asksCompatibility(facts.sourceOrderText)
  ) {
    const floorQuestionParts = [
      ...(!facts.surface.material ? ["из чего сделан пол"] : []),
      ...(!facts.surface.areaM2 ? ["какая площадь пола"] : []),
      ...(!facts.floorUse.purpose ? ["как будете использовать помещение"] : []),
      ...(!facts.floorUse.cleaning ? ["чем его моете"] : []),
      ...(!facts.floorUse.load ? ["ездят ли по нему погрузчики"] : []),
    ];
    const lastQuestionPart = floorQuestionParts.pop();
    sourceFactGaps = [
      ...(lastQuestionPart
        ? [
            `Подскажите, пожалуйста: ${
              floorQuestionParts.length
                ? `${floorQuestionParts.join(", ")} и `
                : ""
            }${lastQuestionPart}?`,
          ]
        : []),
      ...sourceFactGaps.filter((gap) => gap === "приложите фотографию"),
    ];
  }
  let hardRedRiskDetected = false;
  let technicalReviewDetected = false;
  let technicalReviewReason = "";

  const suppliedUnderstanding = cleanList(result.understood);
  const company = cleanSourceText(job?.company, 180);
  const companyKey = company.toLocaleLowerCase("ru-RU");
  const floorUnderstanding =
    facts.surface?.kind === "floor"
      ? [
          ...(facts.floorUse.material
            ? [`Материал пола: ${facts.floorUse.material}`]
            : []),
          ...(facts.floorUse.purpose
            ? [`Назначение помещения: ${facts.floorUse.purpose}`]
            : []),
          ...(facts.floorUse.cleaning
            ? [`Уборка: ${facts.floorUse.cleaning}`]
            : []),
          ...(facts.floorUse.load
            ? [`Нагрузка: ${facts.floorUse.load}`]
            : []),
        ]
      : [];
  result.understood = [
    ...(company ? [`Клиент: ${company}`] : []),
    ...floorUnderstanding,
    ...suppliedUnderstanding.filter(
      (item) =>
        !(
          companyKey &&
          /^(?:клиент|компания)(?:\s|:|—|-)/iu.test(item) &&
            item.toLocaleLowerCase("ru-RU").includes(companyKey)
        ) &&
        !/^(?:материал пола|назначение помещения|уборка|нагрузка)(?:\s|:|—|-)/iu.test(
          item,
        ),
    ),
  ].slice(0, 8);
  result.missing = cleanList(result.missing);
  result.options = Array.isArray(result.options)
    ? result.options.filter(optionIsSafe).slice(0, 3)
    : [];
  result.confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
  const researchMatch = companyResearchMatch(job, facts);
  result.research = researchMatch
    ? normalizeResearch(result.research, job, researchMatch === "name")
    : {
        checked: false,
        summary: "",
        sources: [],
      };
  const openedResearchSources = result.research.sources.filter((source) =>
    sourceWasOpened(source, job),
  );
  const allResearchClaimsGrounded =
    !hadResearchClaim ||
    (rawResearchSources.length > 0 &&
      result.research.sources.length === rawResearchSources.length &&
      openedResearchSources.length === rawResearchSources.length);
  const preparedResearch = preparedResearchFor(
    preparedProfileForJob(job, facts, demoData),
  );
  const hasGroundedModelResearch =
    allResearchClaimsGrounded && result.research.checked;
  const groundedResearchSources = hasGroundedModelResearch
    ? openedResearchSources
    : (preparedResearch?.sources ?? []);
  if (!hasGroundedModelResearch && preparedResearch) {
    result.research = preparedResearch;
  }
  result.calculation = safeCalculation;
  result.supplierPlan = undefined;
  result.decisionBasis = allResearchClaimsGrounded ? safeDecisionBasis : [];

  const industry = industryFor(job, demoData);
  result.businessContext =
    groundedBusinessContext({
      facts,
      industry,
      openedResearchSources: groundedResearchSources,
    }) ||
    "Агент опирается на задачу клиента и подтверждённые свойства выбранной краски.";

  if (explicitSku && !explicitProduct) {
    result.zone = "yellow";
    result.decision = "clarify";
    result.product = null;
    result.options = [];
    result.missing = [...sourceFactGaps];
    result.zoneReason =
      "Агент уточнит товар и сразу продолжит расчёт по каталогу.";
  } else {
    if (matchedProduct) {
      result.product = {
        sku: matchedProduct.sku,
        requestedKg: requestedFromOrder,
      };
    }
  }

  if (result.product?.sku) {
    const requestedSku = text(result.product.sku).toUpperCase();
    const sourceProduct = demoData.products.find(
      (product) => product.sku === requestedSku,
    );
    if (sourceProduct) {
      const requestedKg = requestedFromOrder;
      result.product = {
        sku: sourceProduct.sku,
        name: sourceProduct.name,
        stockKg: sourceProduct.stockKg,
        requestedKg,
        ...(firstDeliveryKg
          ? {
              firstDeliveryKg: Math.min(
                firstDeliveryKg,
                sourceProduct.stockKg,
                requestedKg,
              ),
            }
          : {}),
        ...(requestedColor ? { color: requestedColor } : {}),
        pricePerKg: sourceProduct.pricePerKg,
        minPricePerKg: sourceProduct.minPricePerKg,
        replenishmentDays: sourceProduct.replenishmentDays,
        total: requestedKg * sourceProduct.pricePerKg,
      };
      const currentDeliveryFacts = [
        ...(requestedColor ? [`Цвет: ${requestedColor}`] : []),
        ...(firstDeliveryKg
          ? [
              `Первая поставка: ${money.format(
                firstDeliveryKg,
              )} кг; затем ${money.format(
                requestedKg - firstDeliveryKg,
              )} кг`,
            ]
          : []),
      ];
      result.understood = [
        ...result.understood
          .filter(
            (item) =>
              !/^(?:цвет|первая\s+(?:поставка|партия))(?:\s|:|—|-)/iu.test(
                item,
              ),
          )
          .slice(0, 8 - currentDeliveryFacts.length),
        ...currentDeliveryFacts,
      ];
      result.market = marketSnapshot(sourceProduct, demoData, requestedKg);
      result.supplierPlan =
        requestedKg > sourceProduct.stockKg
          ? buildSupplierPlan(sourceProduct, demoData.market, requestedKg)
          : undefined;

      const marketDate = result.market.items[0]?.checkedAt;
      result.checks = [
        `Каталог подтверждает краску «${sourceProduct.name}» и её свойства`,
        `Остаток: ${money.format(sourceProduct.stockKg)} кг`,
        "По этой цене завод зарабатывает на заказе",
        marketDate
          ? `Цены и наличие других поставщиков проверены ${marketDate}`
          : "Цена сверена с описанием краски в каталоге и правилом заработка",
      ];
      result.sources = [
        "Входящее письмо",
        "Каталог и остатки",
        "Правила продаж",
        ...(result.market.items.length
          ? ["Цены и наличие других поставщиков"]
          : []),
        "Как заказ влияет на работу клиента",
      ];

      const requestedBelowMinimum = quotedUnitPrices(sourceOrderText).some(
        (price) => price < sourceProduct.minPricePerKg,
      );
      const replyBelowMinimum = quotedUnitPrices(rawClientCopy).some(
        (price) => price < sourceProduct.minPricePerKg,
      );
      const sourceHasSpecialTerms = hasSpecialTerms(sourceOrderText);
      const clientCopyHasSpecialTerms = hasSpecialTerms(rawClientCopy);
      technicalReviewDetected =
        requestedKg > 0 &&
        sourceFactGaps.length === 0 &&
        asksCompatibility(sourceOrderText) &&
        (facts.surface?.kind !== "floor" ||
          Boolean(
            facts.floorUse?.material &&
              facts.floorUse?.purpose &&
              facts.floorUse?.cleaning &&
              facts.floorUse?.load,
          )) &&
        !productCoversRequestedUse(sourceProduct, sourceOrderText);
      technicalReviewReason = technicalReviewDetected
        ? technicalReviewSummary(sourceOrderText)
        : "";

      if (
        requestedKg > sourceProduct.stockKg ||
        requestedBelowMinimum ||
        replyBelowMinimum ||
        sourceHasSpecialTerms ||
        clientCopyHasSpecialTerms ||
        technicalReviewDetected
      ) {
        hardRedRiskDetected = true;
        result.zone = "red";
        result.decision = "escalate";
        result.zoneReason =
          technicalReviewDetected
            ? `${technicalReviewReason} Агент подготовил три готовых хода для решения.`
            : requestedKg > sourceProduct.stockKg
            ? firstDeliveryKg
              ? `Клиент выбрал ${money.format(
                  firstDeliveryKg,
                )} кг для первой поставки. Склад подтверждает этот объём; руководитель получил план для оставшихся ${money.format(
                  requestedKg - firstDeliveryKg,
                )} кг.`
              : `Склад подтверждает ${money.format(
                  sourceProduct.stockKg,
                )} из ${money.format(
                  requestedKg,
                )} кг. Руководитель выберет готовый способ выполнить заказ.`
            : requestedBelowMinimum
              ? "Клиент предложил особую цену. Руководитель получил варианты, при которых завод заработает на заказе."
              : replyBelowMinimum
                ? "Руководитель выбирает один из готовых вариантов; рядом показан заработок завода."
                : clientCopyHasSpecialTerms
                  ? "Агент подготовил руководителю варианты цены, срока и оплаты."
                  : "Руководитель получил варианты по особым условиям заказа.";
        result.checks.push("Следующий шаг выбран по правилам завода");
      }

      const verifiedReady =
        requestedKg > 0 &&
        sourceFactGaps.length === 0 &&
        requestedKg <= sourceProduct.stockKg &&
        !requestedBelowMinimum &&
        !replyBelowMinimum &&
        !sourceHasSpecialTerms &&
        !clientCopyHasSpecialTerms &&
        !technicalReviewDetected;
      if (verifiedReady) {
        hardRedRiskDetected = false;
        result.zone = "green";
        result.decision = "quote";
        result.options = [];
        result.zoneReason =
          "Весь объём подтверждён складом. По этой цене завод зарабатывает на заказе. Письмо готово.";
        result.managerNote =
          "Цена и объём подтверждены. Письмо готово к отправке.";
      }

      if (requestedKg <= 0) {
        result.zone = "yellow";
        if (facts.surface) {
          result.zoneReason =
            "Агент уточнит, из чего сделан пол и как его используют, затем рассчитает расход по площади и целым упаковкам.";
        } else {
          result.product = null;
          result.missing = [
            ...new Set([...result.missing, "укажите объём в килограммах"]),
          ];
          result.zoneReason =
            "Агент уточнит объём и сразу соберёт точный расчёт.";
        }
      }

      if (result.zone === "red") {
        const optionIds = result.options.map((option) => text(option?.id));
        if (technicalReviewDetected) {
          result.options = technicalReviewOptions(
            sourceProduct,
            requestedKg,
            sourceOrderText,
          );
        } else if (
          rawOptionCount < 2 ||
          rawOptionCount > 3 ||
          result.options.length !== rawOptionCount ||
          optionIds.some((id) => !id) ||
          new Set(optionIds).size !== optionIds.length ||
          result.options.some((option) =>
            promisesUnavailableFullVolume(
              option,
              sourceProduct,
              requestedKg,
              demoData,
            ),
          ) ||
          result.options.some((option) =>
            quotesBelowMinimum(option, sourceProduct, demoData),
          ) ||
          result.options.some((option) =>
            offersUnapprovedAnalogue(option, sourceProduct, demoData),
          ) ||
          result.options.some((option) =>
            offersUnavailableColor(
              option,
              sourceProduct,
              sourceOrderText,
              demoData,
            ),
          ) ||
          (firstDeliveryKg > 0 &&
            requestedKg > sourceProduct.stockKg) ||
          (result.calculation &&
            result.options.some(
              (option) =>
                targetProductForOption(option, sourceProduct, demoData).sku !==
                sourceProduct.sku,
            ))
        ) {
          result.options = fallbackOptions(
            sourceProduct,
            requestedKg,
            demoData,
            !result.calculation,
            sourceOrderText,
            firstDeliveryKg,
          );
        }

        if (
          !technicalReviewDetected &&
          requestedKg > sourceProduct.stockKg
        ) {
          const supplierHelp = fallbackOptions(
            sourceProduct,
            requestedKg,
            demoData,
            !result.calculation,
            sourceOrderText,
            firstDeliveryKg,
          ).find(
            (option) => option.id === "помочь-с-недостающим-объёмом",
          );
          if (
            supplierHelp &&
            !result.options.some(
              (option) =>
                option.id === "помочь-с-недостающим-объёмом",
            )
          ) {
            result.options = [
              ...result.options.slice(0, 2),
              supplierHelp,
            ];
          }
        }
      }
    } else {
      result.zone = "yellow";
      result.decision = "clarify";
      result.product = null;
      result.options = [];
      result.missing = [
        ...new Set([
          ...result.missing,
          `сверьте код ${requestedSku || "из письма"} с каталогом`,
        ]),
      ];
      result.zoneReason =
        "Агент уточнит товар и продолжит расчёт по каталогу.";
    }
  } else if (result.zone !== "yellow") {
    result.zone = "yellow";
    result.decision = "clarify";
    result.product = null;
    result.options = [];
    result.missing = [
      ...new Set([...result.missing, "подтвердите краску или задачу"]),
    ];
    result.zoneReason =
      "Агент уточнит назначение и подберёт товар по каталогу.";
  }

  if (modelSkuMismatch) {
    const modelSkuLabel = /^КР-\d{1,4}$/i.test(modelSku)
      ? modelSku
      : "другой код";
    sourceFactGaps.unshift(
      `сверьте код: модель указала ${modelSkuLabel}, письмо соответствует ${matchedProduct.sku}`,
    );
  }

  if (sourceFactGaps.length) {
    result.missing = [...new Set(sourceFactGaps)];
    const preserveHardRed =
      hardRedRiskDetected &&
      Boolean(matchedProduct) &&
      requestedFromOrder > 0 &&
      !modelSkuMismatch;
    if (preserveHardRed) {
      result.zone = "red";
    } else {
      result.zone = "yellow";
      result.options = [];
      if (!matchedProduct) result.product = null;
      result.zoneReason = modelSkuMismatch
        ? "Агент сверит товар с письмом и продолжит по подтверждённому описанию в каталоге."
        : explicitSku && !matchedProduct
          ? "Агент уточнит товар и продолжит расчёт по каталогу."
          : "Агент собрал известные данные и подготовил короткие вопросы клиенту.";
    }
  }

  if (!["green", "yellow", "red"].includes(result.zone)) {
    throw new Error(
      "Ответ модели нужно пересобрать. Запустите обработку заказа снова.",
    );
  }

  result.decision =
    result.zone === "red"
      ? "escalate"
      : result.zone === "yellow"
        ? "clarify"
        : "quote";

  const suppliedReason = allResearchClaimsGrounded
    ? cleanCopy(result.zoneReason)
    : "";
  result.zoneReason =
    suppliedReason ||
    (
      result.zone === "green"
        ? "Краска, объём и цена подтверждены."
        : result.zone === "yellow"
          ? "Добавьте данные для выбора краски и расчёта."
          : "Руководитель выбирает вариант по условиям заказа."
    );

  const suppliedManagerNote = allResearchClaimsGrounded
    ? cleanCopy(result.managerNote)
    : "";
  result.managerNote =
    technicalReviewDetected
      ? "Выберите способ проверки. Технолог уже получает описание помещения, описание краски из каталога, расчёт и условие клиента."
      : suppliedManagerNote ||
        (result.zone === "red"
          ? industry
            ? `Предлагаем: ${industry.play}.`
            : "Предлагаем выполнимый график и закреплённую цену."
          : result.zone === "yellow"
            ? "Отправьте короткие вопросы. Ответ клиента продолжит тот же заказ."
            : "Цена и объём подтверждены. Письмо готово.");

  if (!result.product) {
    result.market = {
      checked: false,
      summary: "Сравнение цен начнётся после уточнения краски.",
      position: "Краска пока подбирается.",
      profitOpportunity:
        "После подбора агент сравнит нашу цену с ценами других поставщиков.",
      items: [],
    };
    result.checks = [
      "Запрошены данные для выбора краски и расчёта",
      "Расчёт начнётся после подтверждения краски",
    ];
    result.sources = ["Входящее письмо", "Правила продаж"];
  }

  const groundedBasis = [];
  const guardedProduct = result.product
    ? demoData.products.find((item) => item.sku === result.product.sku)
    : null;
  if (result.calculation) {
    groundedBasis.push({
      fact: result.calculation.explanation,
      source: "Размеры клиента и описание краски в каталоге",
      checkedAt: new Intl.DateTimeFormat("ru-RU").format(new Date()),
      stockVersion: "",
    });
  }
  if (result.product && guardedProduct) {
    groundedBasis.push({
      fact: `Каталог подтверждает для «${guardedProduct.name}»: ${guardedProduct.features.join(
        ", ",
      )}.`,
      source: "Описание краски в каталоге",
      checkedAt: "Редакция демонстрационного каталога",
      stockVersion: "",
    });
    if (result.product.requestedKg > 0) {
      groundedBasis.push(
      {
        fact:
          result.product.requestedKg <= result.product.stockKg
            ? `Весь объём подтверждён складом: ${money.format(
                result.product.requestedKg,
              )} из ${money.format(result.product.stockKg)} кг.`
            : `Склад подтверждает ${money.format(
                result.product.stockKg,
              )} из ${money.format(result.product.requestedKg)} кг.`,
        source: "Остаток на момент расчёта",
        checkedAt:
          cleanSourceText(guardedProduct.stockUpdatedAt, 80) ||
          new Intl.DateTimeFormat("ru-RU").format(new Date()),
        stockVersion: guardedProduct.stockRevision
          ? `Обновление склада №${guardedProduct.stockRevision}`
          : "Исходное обновление склада",
      },
      );
    }
    groundedBasis.push({
      fact: `Цена ${money.format(
        result.product.pricePerKg,
      )} ₽/кг. Завод зарабатывает при цене от ${money.format(
        guardedProduct.minPricePerKg,
      )} ₽/кг.`,
      source: "Описание краски в каталоге и правила продаж",
      checkedAt: "Редакция 5.6",
      stockVersion: "",
    });
    if (result.market?.position && result.market.items?.length) {
      const comparedPrices = result.market.items
        .map(
          (item) =>
            `${cleanSourceText(item.competitor, 100)} — ${money.format(
              Number(item.pricePerKg),
            )} ₽/кг${
              Number.isFinite(Number(item.stockKg))
                ? `, в таблице указано ${money.format(
                    Number(item.stockKg),
                  )} кг`
                : ""
            }`,
        )
        .join("; ");
      groundedBasis.push({
        fact: `${result.market.position} Для сравнения: ${comparedPrices}.`,
        source: "Таблица цен и наличия поставщиков",
        checkedAt:
          result.market.items?.at(-1)?.stockCheckedAt ??
          result.market.items?.at(-1)?.checkedAt ??
          new Intl.DateTimeFormat("ru-RU").format(new Date()),
        stockVersion: "",
      });
    }
    if (result.supplierPlan) {
      const plan = result.supplierPlan;
      const savedDays = Math.max(
        0,
        guardedProduct.replenishmentDays - plan.deliveryDays,
      );
      const savedMoney = Math.max(
        0,
        result.product.requestedKg * result.product.pricePerKg - plan.total,
      );
      groundedBasis.push({
        fact: `План совместной поставки содержит недостающие ${money.format(
          plan.supplierKg,
        )} кг: со склада «Колера» — ${money.format(
          plan.ourKg,
        )} кг, по данным «${plan.supplierName}» — ${money.format(
          plan.supplierKg,
        )} кг. После подтверждения поставщика клиент получит все ${money.format(
          result.product.requestedKg,
        )} кг за ${plan.deliveryDays} ${countedNoun(
          plan.deliveryDays,
          "день",
          "дня",
          "дней",
        )}; стоимость — ${money.format(plan.total)} ₽${
          savedDays
            ? `, выигрыш по сроку — ${money.format(savedDays)} ${countedNoun(
                savedDays,
                "день",
                "дня",
                "дней",
              )}`
            : ""
        }${savedMoney ? `, экономия — ${money.format(savedMoney)} ₽` : ""}.`,
        source: "Таблица цен и наличия поставщиков",
        checkedAt: plan.stockCheckedAt,
        stockVersion: "",
      });
    }
  }
  for (const source of groundedResearchSources) {
    groundedBasis.push({
      fact: source.fact,
      source: source.title,
      checkedAt: source.checkedAt,
      stockVersion: "",
    });
  }
  result.decisionBasis = groundedBasis.length
    ? groundedBasis.slice(0, 6)
    : result.decisionBasis.length
      ? result.decisionBasis
      : [
          {
            fact: result.zoneReason,
            source: "Входящее письмо и правила продаж",
            checkedAt: new Intl.DateTimeFormat("ru-RU").format(new Date()),
            stockVersion: "",
          },
        ];

  const suppliedReply = result.reply && {
    subject: isAllCapsHeading(result.reply.subject)
      ? ""
      : cleanCopy(result.reply.subject),
    body: allResearchClaimsGrounded
      ? cleanClientCopy(result.reply.body)
      : "",
  };
  result.reply =
    result.zone === "yellow"
      ? fallbackReply(result, job, demoData, facts)
      : result.zone === "green"
        ? fallbackReply(result, job, demoData, facts)
        : suppliedReply?.subject && suppliedReply.body
          ? suppliedReply
          : fallbackReply(result, job, demoData, facts);

  if (result.zone === "red") {
    result.reply = {
      subject: result.reply.subject,
      body: "Выберите один подготовленный вариант — его условия войдут в письмо клиенту.",
    };
  } else {
    result.options = [];
  }
  if (replacedUnexpectedLatin) {
    result.checks = [
      ...new Set([...(result.checks ?? []), safeTemplateReplacementCheck]),
    ];
  }
  if (replacedForbiddenRhetoric) {
    result.checks = [
      ...new Set([...(result.checks ?? []), safeRhetoricReplacementCheck]),
    ];
  }

  return {
    zone: result.zone,
    decision: result.decision,
    route:
      result.zone === "red"
        ? "manager"
        : result.zone === "yellow"
          ? "needs_info"
          : "ready",
    confidence: result.confidence,
    understood: result.understood,
    missing: result.missing,
    product: result.product
      ? {
          sku: result.product.sku,
          name: result.product.name,
          stockKg: result.product.stockKg,
          requestedKg: result.product.requestedKg,
          ...(result.product.firstDeliveryKg
            ? { firstDeliveryKg: result.product.firstDeliveryKg }
            : {}),
          ...(result.product.color ? { color: result.product.color } : {}),
          pricePerKg: result.product.pricePerKg,
          total: result.product.total,
          replenishmentDays: result.product.replenishmentDays,
        }
      : null,
    ...(result.calculation ? { calculation: result.calculation } : {}),
    market: result.market,
    ...(result.supplierPlan ? { supplierPlan: result.supplierPlan } : {}),
    research: result.research,
    businessContext: result.businessContext,
    zoneReason: result.zoneReason,
    managerNote: result.managerNote,
    options: result.options,
    reply: result.reply,
    checks: result.checks,
    sources: result.sources,
    decisionBasis: result.decisionBasis,
    review: {
      model: cleanSourceText(result.review?.model, 120),
      verdict: cleanCopy(result.review?.verdict),
      notes: cleanList(result.review?.notes).slice(0, 4),
    },
  };
}

export function applyReviewerResult(
  result,
  review,
  reviewerModel,
  demoData,
  job = {},
) {
  const facts = orderFacts(job, demoData);
  const hasBlockingIssuesArray = Array.isArray(review?.blockingIssues);
  const blockingIssues = hasBlockingIssuesArray
    ? review.blockingIssues
    : [];
  const reviewerApproved =
    review?.approved === true &&
    hasBlockingIssuesArray &&
    blockingIssues.length === 0;
  const blockingNotes = blockingIssues
    .slice(0, 2)
    .map((item) => cleanCopy(`Для решения: ${String(item).slice(0, 240)}`))
    .filter(Boolean);
  const reviewNotes = Array.isArray(review?.notes)
    ? review.notes
        .slice(0, 4)
        .map((item) => cleanCopy(String(item).slice(0, 260)))
        .filter(Boolean)
    : [];
  const reviewVerdict = cleanCopy(review?.verdict);

  const readyProduct = result.product
    ? demoData.products.find((item) => item.sku === result.product.sku)
    : null;
  const readyDetails = [
    colorLabelFromText(facts.sourceOrderText) ? "цвет" : "",
    orderLogisticsLine(facts.sourceOrderText) ? "условия поставки" : "",
  ].filter(Boolean);
  const approvedReadyNotes =
    result.route === "ready" && result.product && readyProduct
      ? [
          `Склад подтверждает ${money.format(
            result.product.requestedKg,
          )} кг из ${money.format(result.product.stockKg)} кг.`,
          `Цена ${money.format(
            result.product.pricePerKg,
          )} ₽/кг выше нижней выгодной границы ${money.format(
            readyProduct.minPricePerKg,
          )} ₽/кг — заказ приносит прибыль.`,
          readyDetails.length
            ? `Письмо повторяет ${readyDetails.join(" и ")} из заявки.`
            : "Письмо повторяет подтверждённые данные заказа.",
        ]
      : [];

  result.review = {
    model: reviewerModel,
    verdict:
      reviewerApproved && result.route === "ready"
        ? "Ответ проверен и готов к отправке"
        : reviewerApproved && result.route === "needs_info"
          ? "Вопросы проверены и готовы к отправке"
          : reviewerApproved && result.route === "manager"
            ? "Руководитель получил готовые варианты"
            : reviewVerdict
              ? reviewVerdict.slice(0, 240)
              : "Руководителю подготовлены пункты для решения",
    notes: reviewerApproved
      ? approvedReadyNotes.length
        ? approvedReadyNotes
        : reviewNotes
      : [...blockingNotes, ...reviewNotes].slice(0, 4),
  };

  if (reviewerApproved) return result;

  const mismatchNote = result.missing?.find((item) =>
    /^сверьте код: модель указала (?:КР-\d{1,4}|другой код), письмо соответствует КР-\d{1,4}$/iu.test(
      item,
    ),
  );
  const canAskClient =
    !hasCommercialBoundary(facts) &&
    (facts.gaps.length > 0 || Boolean(mismatchNote));
  if (canAskClient) {
    result.zone = "yellow";
    result.decision = "clarify";
    result.missing = [...new Set([mismatchNote, ...facts.gaps].filter(Boolean))];
    result.options = [];
    result.businessContext = facts.matchedProduct
      ? "Письмо и каталог собраны. Ответ клиента завершит расчёт по остатку на момент расчёта."
      : "Письмо разобрано. Агент подготовил вопросы, после которых подберёт краску и рассчитает заказ.";
    result.zoneReason =
      "Агент собрал известные данные и подготовил короткие вопросы клиенту.";
    result.managerNote =
      "Отправьте точные вопросы. Ответ клиента продолжит тот же заказ.";
    const clarified = normalizeAgentResult(result, demoData, job);
    clarified.understood = groundedUnderstanding(job, facts);
    return clarified;
  }

  result.zone = "red";
  result.decision = "escalate";
  result.zoneReason =
    "Модель проверки отметила условие для руководителя и приложила факты.";
  result.managerNote = `Модель проверки подготовила данные для выбора. ${result.managerNote}`;
  result.options = [];
  const normalized = normalizeAgentResult(result, demoData, job);
  normalized.understood = groundedUnderstanding(job, facts);
  normalized.missing = [
    ...new Set([mismatchNote, ...facts.gaps].filter(Boolean)),
  ];
  const missing =
    normalized.missing.slice(0, 2).join(", ") ||
    "условие, отмеченное сильной моделью";
  const safeQuestionReply =
    "Что для вас важнее: срок, цена или график поставки? После ответа подготовим подтверждённый вариант.";

  normalized.zone = "red";
  normalized.decision = "escalate";
  normalized.route = "manager";
  const hasProduct = Boolean(normalized.product ?? facts.matchedProduct);
  const hasResearchSources = Boolean(normalized.research?.sources.length);
  normalized.zoneReason = hasProduct
    ? "Письмо, каталог и склад подтверждают данные для решения руководителя."
    : "Письмо содержит данные для решения руководителя.";
  normalized.managerNote = hasResearchSources
    ? "Откройте найденные ссылки и выберите один из подготовленных ходов."
    : "Выберите один из подготовленных ходов по данным заявки.";
  normalized.businessContext = hasProduct
    ? hasResearchSources
      ? "Письмо, каталог, склад и найденные ссылки собраны рядом с решением руководителя."
      : "Письмо, каталог и склад собраны рядом с решением руководителя."
    : hasResearchSources
      ? "Письмо и найденные ссылки собраны рядом с решением руководителя."
      : "Письмо даёт руководителю данные для следующего шага.";
  if (normalized.research) {
    if (hasResearchSources) {
      const researchTitles = new Set(
        normalized.research.sources.map((source) => source.title),
      );
      normalized.research.checked = false;
      normalized.research.sources = normalized.research.sources.map(
        (source) => ({
          ...source,
          fact: "Источник найден. Руководитель проверяет сведения перед решением.",
        }),
      );
      normalized.decisionBasis = normalized.decisionBasis.filter(
        (basis) => !researchTitles.has(basis.source),
      );
      if (normalized.decisionBasis.length === 0) {
        normalized.decisionBasis = [
          {
            fact: "Запрос клиента сохранён на странице заказа.",
            source: "Входящее письмо",
            checkedAt: new Intl.DateTimeFormat("ru-RU").format(new Date()),
            stockVersion: "",
          },
        ];
      }
    }
    normalized.research.summary = hasResearchSources
      ? "Агент нашёл ссылки на открытые страницы. Руководитель проверит сведения перед решением."
      : normalized.research.summary
        ? "Публичный поиск завершён. Решение опирается на письмо и внутренние данные."
        : "";
  }
  normalized.options = [
    {
      id: "review-ask",
      title: "Уточнить один факт у клиента",
      rationale: `Уточнить у клиента: ${missing}.`,
      tradeoff: "Расчёт продолжится после одного ответа.",
      reply: safeQuestionReply,
    },
    {
      id: "review-check",
      title: "Проверить условие внутри компании",
      rationale:
        "Подключить коллег, которые отвечают за наличие, свойства краски и оплату, и получить точный ответ.",
      tradeoff:
        "Команда даст клиенту подтверждённый ответ после внутренней проверки.",
      reply:
        "Ваш запрос принят. Проверяем условия со специалистами и направим подтверждённый ответ после согласования.",
    },
    {
      id: "review-call",
      title: "Уточнить, что важнее клиенту",
      rationale:
        "Провести короткий разговор и выбрать подходящие срок, цену и условия.",
      tradeoff: "Менеджер подключится к следующему контакту.",
      reply:
        "Что для вас важнее: срок, цена или условия поставки? После разговора сразу закрепим выполнимый вариант.",
    },
  ];
  normalized.reply = {
    subject: `Ответ по заказу: ${cleanCopy(job?.subject) || "краска"}`,
    body:
      "Агент подготовил следующие ходы. Письмо получит текст выбранного руководителем варианта.",
  };
  return normalized;
}
