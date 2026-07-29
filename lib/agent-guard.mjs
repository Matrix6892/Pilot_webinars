import {
  asksCompatibility,
  explicitSkuFromText,
  hasColor,
  hasSpecialTerms,
  hasUsableEnvironment,
  matchProduct,
  orderFactsFromText,
  quantityFromText,
  quotedUnitPrices,
} from "./order-facts.mjs";

const money = new Intl.NumberFormat("ru-RU");
const decimal = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 2,
});
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
  const candidate = text(value);
  return candidate &&
    !hasUnexpectedLatin(candidate) &&
    !hasCjk(candidate) &&
    !hasForbiddenContrast(candidate) &&
    !isAllCapsHeading(candidate)
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
  return Boolean(
    calculation &&
      calculation.kind === "fence-area" &&
      ["дерево", "металл"].includes(calculation.material) &&
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

function normalizeResearch(value) {
  const rawSummary = cleanCopy(value?.summary);
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

  return {
    checked: Boolean(value?.checked),
    summary:
      rawSummary.length > 700
        ? `${rawSummary.slice(0, 699).replace(/\s+\S*$/, "")}…`
        : rawSummary,
    sources,
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
        .join(" ")
    : "";
  return `${job?.subject ?? ""} ${job?.body ?? ""} ${customerReplies}`.trim();
}

function orderFacts(job, demoData) {
  const sourceOrderText = orderText(job);
  const explicitSku = explicitSkuFromText(sourceOrderText);
  const matchedProduct = matchProduct(sourceOrderText, demoData.products);
  const requestedKg = quantityFromText(sourceOrderText);
  const fence = orderFactsFromText(sourceOrderText).fence;
  const gaps = [];

  if (fence) {
    if (fence.material === "неясно") gaps.push("материал забора");
    if (!fence.areaPerSideM2) gaps.push("длина и высота забора");
    if (!fence.sides) gaps.push("стороны покраски");
    if (!hasColor(sourceOrderText)) gaps.push("желаемый цвет");
  } else if (!matchedProduct) {
    gaps.push(
      explicitSku
        ? `сверьте код ${explicitSku} с каталогом`
        : "опишите, что будете красить",
    );
  }

  if (!fence) {
    if (!requestedKg) gaps.push("объём в килограммах");
    if (!hasUsableEnvironment(sourceOrderText)) {
      gaps.push("где будут красить: на улице или в помещении");
    }
    if (!hasColor(sourceOrderText)) {
      gaps.push("цвет или номер RAL");
    }
    if (asksCompatibility(sourceOrderText)) {
      gaps.push("как будут пользоваться окрашенной поверхностью");
    }
  }

  return {
    sourceOrderText,
    explicitSku,
    matchedProduct,
    requestedKg,
    fence,
    gaps,
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
    )} кг. Берём ${packages} ${
      packages === 1
        ? "упаковку"
        : packages < 5
          ? "упаковки"
          : "упаковок"
    } по ${decimal.format(packageKg)} кг: ${decimal.format(roundedKg)} кг.`,
  };
}

function groundedUnderstanding(job, facts) {
  const company = cleanSourceText(job?.company);
  let storedAttachment = null;
  if (typeof job?.attachmentJson === "string" && job.attachmentJson.trim()) {
    try {
      storedAttachment = JSON.parse(job.attachmentJson);
    } catch {
      storedAttachment = null;
    }
  }
  const attachment = job?.attachment ?? storedAttachment;
  const hasAttachment = Boolean(
    attachment &&
      typeof attachment === "object" &&
      !Array.isArray(attachment) &&
      typeof attachment.src === "string" &&
      attachment.src.startsWith("/"),
  );
  const understood = [
    company ? `Компания из заявки: ${company}` : "",
    facts.fence ? "Задача клиента: покрасить забор" : "",
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

function marketSnapshot(product, demoData) {
  const items = demoData.market
    .filter((item) => item.category === product.category)
    .map(({ competitor, pricePerKg, deliveryDays, checkedAt }) => ({
      competitor,
      pricePerKg,
      deliveryDays,
      checkedAt,
    }));

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
  const difference = marketAverage - product.pricePerKg;
  const position =
    marketAverage === 0
      ? `Цена ${money.format(
          product.pricePerKg,
        )} ₽/кг подтверждена карточкой товара. Минимальная цена с прибылью — ${money.format(
          product.minPricePerKg,
        )} ₽/кг.`
      : Math.abs(difference) <= Math.max(5, marketAverage * 0.03)
        ? "Наша цена почти совпадает со средней ценой других поставщиков."
        : difference > 0
          ? `Наша цена на ${money.format(difference)} ₽/кг ниже средней цены других поставщиков.`
          : `Наша цена на ${money.format(Math.abs(difference))} ₽/кг выше средней цены других поставщиков. Весь объём есть на складе, срок подтверждён.`;
  const profitOpportunity =
    difference > 0
      ? `В следующем предложении можно попробовать цену до ${money.format(
          marketAverage,
        )} ₽/кг: другие поставщики уже предлагают такую цену. Журнал покажет, как изменится результат.`
      : "По текущей цене завод зарабатывает на заказе. Дополнительную прибыль могут дать крупный заказ или удобные условия поставки.";

  return {
    checked: true,
    summary: comparison
      ? `Цены других поставщиков. ${comparison} Цена «Колер»: ${money.format(
          product.pricePerKg,
        )} ₽/кг.`
      : `Цена ${money.format(
          product.pricePerKg,
        )} ₽/кг взята из карточки товара. Минимальная цена с прибылью — ${money.format(
          product.minPricePerKg,
        )} ₽/кг.`,
    items,
    position,
    profitOpportunity,
  };
}

function optionIsSafe(option) {
  if (!option || typeof option !== "object") return false;
  return (
    !isAllCapsHeading(option.title) &&
    ["title", "rationale", "tradeoff", "reply"].every((key) =>
      Boolean(cleanCopy(option[key])),
    )
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

function fallbackOptions(product, requestedKg, demoData) {
  const availableKg = Math.min(product.stockKg, requestedKg);
  const missingKg = Math.max(0, requestedKg - product.stockKg);

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
      candidate.stockKg >= requestedKg,
  );

  const options = [
    {
      id: "две-поставки",
      title: "Разделить поставку",
      rationale: `Отгрузить ${money.format(
        availableKg,
      )} кг из наличия и поставить ${money.format(
        missingKg,
      )} кг после пополнения через ${product.replenishmentDays} дней.`,
      tradeoff:
        "Клиент запускает работу с первой партией и заранее получает график второй.",
      reply: `Предлагаем разделить поставку: ${money.format(
        availableKg,
      )} кг отгрузим из наличия, ещё ${money.format(
        missingKg,
      )} кг поставим после пополнения склада через ${
        product.replenishmentDays
      } дней. Цена составляет ${money.format(product.pricePerKg)} ₽/кг.`,
    },
  ];

  if (alternative) {
    options.push({
      id: "alternative",
      title: `Предложить ${alternative.name}`,
      rationale: `${money.format(
        alternative.stockKg,
      )} кг есть на складе. Агент попросит технолога подтвердить, что краска подходит для задачи.`,
      tradeoff: `Цена составляет ${money.format(
        alternative.pricePerKg,
      )} ₽/кг. Технолог подтвердит, что краска подходит вашей поверхности.`,
      reply: `Можем предложить ${alternative.name} из наличия в полном объёме. Цена составляет ${money.format(
        alternative.pricePerKg,
      )} ₽/кг. Перед поставкой технолог подтвердит, что краска подходит для вашей задачи.`,
    });
  }

  options.push({
    id: "contract",
    title: "Добавить краску в ближайший выпуск",
    rationale: `Зарезервировать недостающие ${money.format(
      missingKg,
    )} кг в ближайшем выпуске.`,
    tradeoff:
      "Производство подтвердит срок, руководитель закрепит условия до отправки письма.",
    reply: `Готовы зарезервировать недостающие ${money.format(
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

function fallbackReply(result, job) {
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
          "Какой цвет нужен? Если знаете номер по каталогу RAL, добавьте его.",
      })[item] ?? item;
    const questions = result.missing.length
      ? result.missing.map((item) => `— ${questionFor(item)}`).join("\n")
      : "— что будете красить\n— сколько краски нужно\n— улица или помещение";
    return {
      subject: `Уточнение по заказу: ${safeJobSubject || "краска"}`,
      body: `Добрый день!\n\nЧтобы подготовить точное предложение, уточните:\n${questions}\n\nПосле ответа проверим наличие, цену и срок поставки.`,
    };
  }

  if (result.product) {
    return {
      subject,
      body: `Добрый день!\n\nПодтвердили ${money.format(
        result.product.requestedKg,
      )} кг краски «${result.product.name}» по цене ${money.format(
        result.product.pricePerKg,
      )} ₽/кг. Подготовим отгрузку после подтверждения адреса доставки.`,
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
      "Модель вернула ответ в непонятном формате. Запустите карточку снова.",
    );
  }

  const rawOptionCount = Array.isArray(result.options)
    ? result.options.length
    : 0;
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
    (facts.fence ? undefined : normalizeCalculation(result.calculation));
  const safeDecisionBasis = normalizeDecisionBasis(result.decisionBasis);
  const {
    sourceOrderText,
    explicitSku,
    matchedProduct,
    requestedKg: requestedFromText,
  } = facts;
  const requestedFromOrder =
    requestedFromText || safeCalculation?.roundedKg || 0;
  const explicitProduct = explicitSku ? matchedProduct : null;
  const modelSku = text(result.product?.sku).toUpperCase();
  const modelSkuMismatch = Boolean(
    matchedProduct && modelSku && modelSku !== matchedProduct.sku,
  );
  const sourceFactGaps = facts.gaps.filter(
    (gap) => !(safeCalculation && gap === "объём в килограммах"),
  );
  let hardRedRiskDetected = false;

  result.understood = cleanList(result.understood);
  result.missing = cleanList(result.missing);
  result.options = Array.isArray(result.options)
    ? result.options.filter(optionIsSafe).slice(0, 3)
    : [];
  result.confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
  result.research = normalizeResearch(result.research);
  result.calculation = safeCalculation;
  result.decisionBasis = safeDecisionBasis;

  const industry = industryFor(job, demoData);
  const suppliedBusinessContext = cleanCopy(result.businessContext);
  result.businessContext =
    suppliedBusinessContext ||
    (industry
      ? `Заказ влияет на ${industry.risk}. Агент предлагает: ${industry.play}.`
      : "Агент опирается на задачу клиента и свойства выбранной краски.");

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
        pricePerKg: sourceProduct.pricePerKg,
        minPricePerKg: sourceProduct.minPricePerKg,
        replenishmentDays: sourceProduct.replenishmentDays,
        total: requestedKg * sourceProduct.pricePerKg,
      };
      result.market = marketSnapshot(sourceProduct, demoData);

      const marketDate = result.market.items[0]?.checkedAt;
      result.checks = [
        `Каталог подтверждает краску «${sourceProduct.name}» и её свойства`,
        `Остаток: ${money.format(sourceProduct.stockKg)} кг`,
        "По этой цене завод зарабатывает на заказе",
        marketDate
          ? `Цены других поставщиков проверены ${marketDate}`
          : "Цена сверена с карточкой товара и минимальной ценой с прибылью",
      ];
      result.sources = [
        "Входящее письмо",
        "Каталог и остатки",
        "Правила продаж",
        ...(result.market.items.length ? ["Цены других поставщиков"] : []),
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

      if (
        requestedKg > sourceProduct.stockKg ||
        requestedBelowMinimum ||
        replyBelowMinimum ||
        sourceHasSpecialTerms ||
        clientCopyHasSpecialTerms
      ) {
        hardRedRiskDetected = true;
        result.zone = "red";
        result.decision = "escalate";
        result.zoneReason =
          requestedKg > sourceProduct.stockKg
            ? `Склад подтверждает ${money.format(
                sourceProduct.stockKg,
              )} из ${money.format(
                requestedKg,
              )} кг. Руководитель выберет готовый способ закрыть заказ.`
            : requestedBelowMinimum
              ? "Клиент предложил особую цену. Руководитель получил варианты, при которых завод заработает на заказе."
              : replyBelowMinimum
                ? "Руководитель выбирает один из готовых вариантов; рядом показан заработок завода."
                : clientCopyHasSpecialTerms
                  ? "Агент подготовил руководителю варианты цены, срока и оплаты."
                  : "Руководитель получил варианты по особым условиям заказа.";
        result.checks.push("Следующий шаг выбран по правилам завода");
      }

      if (requestedKg <= 0) {
        result.zone = "yellow";
        result.product = null;
        result.missing = [
          ...new Set([...result.missing, "укажите объём в килограммах"]),
        ];
        result.zoneReason =
          "Агент уточнит объём и сразу соберёт точный расчёт.";
      }

      if (result.zone === "red") {
        const optionIds = result.options.map((option) => text(option?.id));
        if (
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
          )
        ) {
          result.options = fallbackOptions(
            sourceProduct,
            requestedKg,
            demoData,
          );
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
        ? "Агент сверит товар с письмом и продолжит по подтверждённой карточке."
        : explicitSku && !matchedProduct
          ? "Агент уточнит товар и продолжит расчёт по каталогу."
          : "Агент собрал известные данные и подготовил короткие вопросы клиенту.";
    }
  }

  if (!["green", "yellow", "red"].includes(result.zone)) {
    throw new Error(
      "Модель не выбрала следующий шаг. Запустите карточку снова.",
    );
  }

  result.decision =
    result.zone === "red"
      ? "escalate"
      : result.zone === "yellow"
        ? "clarify"
        : "quote";

  const suppliedReason = cleanCopy(result.zoneReason);
  result.zoneReason =
    suppliedReason ||
    (
      result.zone === "green"
        ? "Краска, объём и цена подтверждены."
        : result.zone === "yellow"
          ? "Добавьте данные для выбора краски и расчёта."
          : "Руководитель выбирает вариант по условиям заказа."
    );

  const suppliedManagerNote = cleanCopy(result.managerNote);
  result.managerNote =
    suppliedManagerNote ||
    (result.zone === "red"
      ? industry
        ? `Предлагаем: ${industry.play}.`
        : "Предлагаем выполнимый график и закреплённую цену."
      : result.zone === "yellow"
        ? "Отправьте короткие вопросы. Ответ клиента продолжит ту же карточку."
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
      source: "Размеры клиента и карточка товара",
      checkedAt: new Intl.DateTimeFormat("ru-RU").format(new Date()),
      stockVersion: "",
    });
  }
  if (result.product && guardedProduct) {
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
        source: "Живой склад",
        checkedAt:
          cleanSourceText(guardedProduct.stockUpdatedAt, 80) ||
          new Intl.DateTimeFormat("ru-RU").format(new Date()),
        stockVersion: guardedProduct.stockRevision
          ? `Обновление склада №${guardedProduct.stockRevision}`
          : "Исходное обновление склада",
      },
      {
        fact: `Цена ${money.format(
          result.product.pricePerKg,
        )} ₽/кг. Минимальная цена с прибылью — ${money.format(
          guardedProduct.minPricePerKg,
        )} ₽/кг. По этой цене завод зарабатывает на заказе.`,
        source: "Карточка товара и правила продаж",
        checkedAt: "Редакция 5.6",
        stockVersion: "",
      },
    );
    if (result.market?.position && result.market.items?.length) {
      const comparedPrices = result.market.items
        .map(
          (item) =>
            `${cleanSourceText(item.competitor, 100)} — ${money.format(
              Number(item.pricePerKg),
            )} ₽/кг`,
        )
        .join("; ");
      groundedBasis.push({
        fact: `${result.market.position} Для сравнения: ${comparedPrices}.`,
        source: "Цены других поставщиков",
        checkedAt:
          result.market.items?.at(-1)?.checkedAt ??
          new Intl.DateTimeFormat("ru-RU").format(new Date()),
        stockVersion: "",
      });
    }
  }
  for (const source of result.research?.sources ?? []) {
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
    body: cleanCopy(result.reply.body),
  };
  result.reply =
    result.zone === "yellow"
      ? fallbackReply(result, job)
      : suppliedReply?.subject && suppliedReply.body
        ? suppliedReply
        : fallbackReply(result, job);

  if (result.zone === "red") {
    result.reply = {
      subject: result.reply.subject,
      body: "Агент подготовил варианты ответа. Письмо получит условия, которые выберет руководитель.",
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
          pricePerKg: result.product.pricePerKg,
          total: result.product.total,
          replenishmentDays: result.product.replenishmentDays,
        }
      : null,
    ...(result.calculation ? { calculation: result.calculation } : {}),
    market: result.market,
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

  result.review = {
    model: reviewerModel,
    verdict:
      reviewVerdict
        ? reviewVerdict.slice(0, 240)
        : reviewerApproved
          ? "Факты и границы полномочий подтверждены"
          : "Руководителю подготовлены пункты для решения",
    notes: [...blockingNotes, ...reviewNotes].slice(0, 4),
  };

  if (reviewerApproved) return result;

  result.zone = "red";
  result.decision = "escalate";
  result.zoneReason =
    "Сильная модель отметила условие для руководителя и приложила факты.";
  result.managerNote = `Сильная модель подготовила данные для выбора. ${result.managerNote}`;
  result.options = [];
  const normalized = normalizeAgentResult(result, demoData, job);
  const facts = orderFacts(job, demoData);
  const mismatchNote = normalized.missing.find((item) =>
    /^сверьте код: модель указала (?:КР-\d{1,4}|другой код), письмо соответствует КР-\d{1,4}$/iu.test(
      item,
    ),
  );
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
  normalized.zoneReason =
    "Руководитель получил проверенные факты и выбирает, что делать дальше.";
  normalized.managerNote =
    "Руководитель видит проверенные факты и выбирает один подготовленный ход.";
  const hasProduct = Boolean(normalized.product ?? facts.matchedProduct);
  const hasResearchSources = Boolean(normalized.research?.sources.length);
  normalized.businessContext = hasProduct
    ? hasResearchSources
      ? "Письмо, каталог, склад и открытые источники собраны рядом с решением руководителя."
      : "Письмо, каталог и склад собраны рядом с решением руководителя."
    : hasResearchSources
      ? "Письмо и открытые источники собраны рядом с решением руководителя."
      : "Письмо даёт руководителю данные для следующего шага.";
  if (normalized.research) {
    if (hasResearchSources) {
      normalized.research.sources = normalized.research.sources.map(
        (source) => ({
          ...source,
          fact: "Источник найден. Руководитель проверяет сведения перед решением.",
        }),
      );
    }
    normalized.research.summary = hasResearchSources
      ? "Агент нашёл открытые источники. Руководитель может открыть их прямо перед выбором."
      : normalized.research.checked
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
        "Подключить снабжение, технолога или финансы и получить подтверждённый ответ.",
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
