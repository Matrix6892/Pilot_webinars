import {
  asksCompatibility,
  explicitSkuFromText,
  hasColor,
  hasSpecialTerms,
  hasUsableEnvironment,
  matchProduct,
  quantityFromText,
  quotedUnitPrices,
} from "./order-facts.mjs";

const money = new Intl.NumberFormat("ru-RU");
const safeTemplateReplacementCheck =
  "Клиентский текст заменён безопасным шаблоном: обнаружена неподдерживаемая латиница";
const safeRhetoricReplacementCheck =
  "Клиентский текст заменён безопасным шаблоном: нарушены правила русского текста";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasUnexpectedLatin(value) {
  return /[A-Za-z]{3,}/.test(text(value).replace(/\bRAL(?:\s*\d{4})?\b/gi, ""));
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
    !hasForbiddenContrast(candidate) &&
    !isAllCapsHeading(candidate)
    ? candidate
    : "";
}

function cleanList(value) {
  return Array.isArray(value)
    ? value.map(cleanCopy).filter(Boolean).slice(0, 8)
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
          checkedAt: text(source?.checkedAt).slice(0, 40),
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
  return `${job?.subject ?? ""} ${job?.body ?? ""}`.trim();
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

  return {
    checked: true,
    summary: comparison
      ? `Демонстрационный срез. ${comparison} Цена «Колер»: ${money.format(
          product.pricePerKg,
        )} ₽/кг.`
      : "В демонстрационном срезе пока нет сопоставимых предложений.",
    items,
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
        title: "Сохранить стандартные условия",
        rationale:
          "Подтвердить наличие и цену, предложить обычный срок оплаты и поставки.",
        tradeoff: "Клиенту потребуется принять базовые условия.",
        reply: `Подтверждаем наличие ${money.format(
          requestedKg,
        )} кг продукта «${product.name}» по цене ${money.format(
          product.pricePerKg,
        )} ₽/кг. Готовы согласовать поставку на стандартных условиях.`,
      },
      {
        id: "volume",
        title: "Связать условие с объёмом",
        rationale:
          "Обсудить специальное условие при предоплате и зафиксированном квартальном объёме.",
        tradeoff:
          "Руководитель подтверждает экономику после получения прогноза закупок.",
        reply: `Готовы рассмотреть специальное условие при фиксации квартального объёма и согласованной предоплате. Текущая цена составляет ${money.format(
          product.pricePerKg,
        )} ₽/кг.`,
      },
      {
        id: "clarify",
        title: "Уточнить приоритет клиента",
        rationale:
          "Выяснить главный приоритет: срок, цена или схема оплаты.",
        tradeoff: "Расчёт продолжится после одного короткого ответа.",
        reply:
          "Уточните главный приоритет по заказу: срок поставки, целевая цена или схема оплаты. Подготовим выполнимый вариант под выбранное условие.",
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
      id: "split",
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
      )} кг есть на складе. Агент запросит подтверждение совместимости покрытия.`,
      tradeoff: `Цена составляет ${money.format(
        alternative.pricePerKg,
      )} ₽/кг; технические свойства требуют согласования с клиентом.`,
      reply: `Можем предложить ${alternative.name} из наличия в полном объёме. Цена составляет ${money.format(
        alternative.pricePerKg,
      )} ₽/кг. Перед поставкой подтвердим совместимость покрытия с вашей технологией.`,
    });
  }

  options.push({
    id: "contract",
    title: "Согласовать приоритетное производство",
    rationale: `Зарезервировать недостающие ${money.format(
      missingKg,
    )} кг в производственном плане и зафиксировать график.`,
    tradeoff:
      "Производство подтвердит срок, руководитель закрепит условия до отправки письма.",
    reply: `Готовы зарезервировать недостающие ${money.format(
      missingKg,
    )} кг в производственном плане. После подтверждения заказа закрепим цену и направим точный график поставки.`,
  });

  options.push({
    id: "clarify",
    title: "Уточнить допустимый график",
    rationale:
      "Получить от клиента минимальный объём первой партии и предельную дату закрытия заказа.",
    tradeoff: "Расчёт продолжится после одного короткого ответа.",
    reply:
      "Уточните минимальный объём первой партии и предельную дату поставки остатка. По ответу сразу закрепим выполнимый график.",
  });

  return options.slice(0, 3);
}

function fallbackReply(result, job) {
  const safeJobSubject = cleanCopy(job?.subject);
  const subject = `Предложение по заказу: ${safeJobSubject || "краска"}`;

  if (result.zone === "yellow") {
    const questions = result.missing.length
      ? result.missing.map((item) => `— ${item}`).join("\n")
      : "— назначение покрытия\n— объём\n— условия эксплуатации";
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
      )} кг продукта «${result.product.name}» по цене ${money.format(
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
    throw new Error("Agent result is not an object");
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
  const sourceOrderText = orderText(job);
  const explicitSku = explicitSkuFromText(sourceOrderText);
  const matchedProduct = matchProduct(sourceOrderText, demoData.products);
  const explicitProduct = explicitSku ? matchedProduct : null;
  const modelSku = text(result.product?.sku).toUpperCase();
  const modelSkuMismatch = Boolean(
    matchedProduct && modelSku && modelSku !== matchedProduct.sku,
  );
  const requestedFromOrder = quantityFromText(sourceOrderText);
  const sourceFactGaps = [];
  if (!matchedProduct) {
    sourceFactGaps.push(
      explicitSku
        ? `артикул ${explicitSku} отсутствует в каталоге`
        : "тип поверхности или назначение покрытия",
    );
  }
  if (!requestedFromOrder) sourceFactGaps.push("объём в килограммах");
  if (!hasUsableEnvironment(sourceOrderText)) {
    sourceFactGaps.push("условия эксплуатации");
  }
  if (!hasColor(sourceOrderText)) {
    sourceFactGaps.push("цвет или номер RAL");
  }
  if (asksCompatibility(sourceOrderText)) {
    sourceFactGaps.push("совместимость с указанной нагрузкой или средой");
  }
  let hardRedRiskDetected = false;

  result.understood = cleanList(result.understood);
  result.missing = cleanList(result.missing);
  result.options = Array.isArray(result.options)
    ? result.options.filter(optionIsSafe).slice(0, 3)
    : [];
  result.confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
  result.research = normalizeResearch(result.research);

  const industry = industryFor(job, demoData);
  const suppliedBusinessContext = cleanCopy(result.businessContext);
  result.businessContext =
    suppliedBusinessContext ||
    (industry
      ? `Для клиента из отрасли «${industry.name}» приоритет: ${industry.priority}. Риск: ${industry.risk}.`
      : "Контекст решения строится на подтверждённых фактах заказа и свойствах продукта.");

  if (explicitSku && !explicitProduct) {
    result.zone = "yellow";
    result.decision = "clarify";
    result.product = null;
    result.options = [];
    result.missing = [...sourceFactGaps];
    result.zoneReason =
      "Артикул из письма отсутствует в каталоге. Агент остановил расчёт до подтверждения продукта.";
  } else {
    if (matchedProduct) {
      result.product = {
        ...(result.product && typeof result.product === "object"
          ? result.product
          : {}),
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
        ...result.product,
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
        `Карточка ${sourceProduct.sku} подтверждает продукт и свойства`,
        `Остаток: ${money.format(sourceProduct.stockKg)} кг`,
        `Цена ${money.format(
          sourceProduct.pricePerKg,
        )} ₽/кг соблюдает минимум ${money.format(
          sourceProduct.minPricePerKg,
        )} ₽/кг`,
        marketDate
          ? `Демонстрационный срез рынка датирован ${marketDate}`
          : "Демонстрационный срез рынка подготовлен",
      ];
      result.sources = [
        "Входящее письмо",
        "Каталог и остатки",
        "Правила продаж",
        ...(result.market.items.length ? ["Демонстрационный срез рынка"] : []),
        "Демонстрационный отраслевой сценарий",
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
            ? `Красная зона по жёсткому правилу: запрошено ${money.format(
                requestedKg,
              )} кг, в наличии ${money.format(
                sourceProduct.stockKg,
              )} кг. Обещание полного объёма требует решения руководителя.`
            : requestedBelowMinimum
              ? `Клиент запросил цену ниже минимальной границы ${money.format(
                  sourceProduct.minPricePerKg,
                )} ₽/кг. Условие передано руководителю вместе с вариантами.`
              : replyBelowMinimum
                ? `В клиентском тексте найдена цена ниже минимальной границы ${money.format(
                    sourceProduct.minPricePerKg,
                  )} ₽/кг. Условие передано руководителю.`
                : clientCopyHasSpecialTerms
                  ? "В клиентском тексте найдены особые коммерческие условия. Черновик передан руководителю."
                  : "Коммерческие условия выходят за полномочия агента и требуют решения руководителя.";
        result.checks.push("Границу зоны определили жёсткие правила");
      }

      if (requestedKg <= 0) {
        result.zone = "yellow";
        result.product = null;
        result.missing = [
          ...new Set([...result.missing, "укажите объём в килограммах"]),
        ];
        result.zoneReason =
          "Количество не подтверждено. Расчёт продолжится после уточнения.";
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
          `артикул ${requestedSku || "из письма"} отсутствует в каталоге`,
        ]),
      ];
      result.zoneReason =
        "Артикул отсутствует в каталоге. Агент остановил расчёт до подтверждения продукта.";
    }
  } else if (result.zone !== "yellow") {
    result.zone = "yellow";
    result.decision = "clarify";
    result.product = null;
    result.options = [];
    result.missing = [
      ...new Set([...result.missing, "подтвердите продукт или назначение"]),
    ];
    result.zoneReason =
      "Продукт не подтверждён каталогом. Агент подготовил уточнение.";
  }

  if (modelSkuMismatch) {
    sourceFactGaps.unshift(
      `подтвердите артикул: модель указала ${modelSku}, письмо соответствует ${matchedProduct.sku}`,
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
        ? "Артикул модели расходится с уверенно распознанным продуктом из письма. Коммерческое предложение остановлено до подтверждения."
        : explicitSku && !matchedProduct
          ? "Артикул из письма отсутствует в каталоге. Агент остановил расчёт до подтверждения продукта."
          : "В исходном письме не хватает существенных параметров. Коммерческое предложение остановлено до уточнения.";
    }
  }

  if (!["green", "yellow", "red"].includes(result.zone)) {
    throw new Error("Agent returned an unknown zone");
  }

  result.decision =
    result.zone === "red"
      ? "escalate"
      : result.zone === "yellow"
        ? "clarify"
        : "quote";

  const suppliedReason = cleanCopy(result.zoneReason);
  if (!suppliedReason) {
    result.zoneReason =
      result.zone === "green"
        ? "Товар, объём и цена подтверждены."
        : result.zone === "yellow"
          ? "Для расчёта нужны существенные параметры заказа."
          : "Условия заказа требуют решения руководителя.";
  }

  const suppliedManagerNote = cleanCopy(result.managerNote);
  result.managerNote =
    suppliedManagerNote ||
    (result.zone === "red"
      ? industry
        ? `Рекомендуемый ход: ${industry.play}.`
        : "Рекомендуемый ход: предложить выполнимый график и закрепить цену."
      : result.zone === "yellow"
        ? "Рекомендуемый ход: запросить недостающий факт. После подключения входящей почты ответ клиента запустит следующий расчёт."
        : "Предложение проходит по стандартному регламенту.");

  if (!result.product) {
    result.market = {
      checked: false,
      summary: "Сравнение рынка начнётся после уточнения продукта.",
      items: [],
    };
    result.checks = [
      "Запрошены только существенные параметры",
      "Расчёт начнётся после подтверждения продукта",
    ];
    result.sources = ["Входящее письмо", "Правила продаж"];
  }

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

  return result;
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
    .map((item) => cleanCopy(`Блокер: ${String(item).slice(0, 240)}`))
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
          : "Найдены блокирующие замечания",
    notes: [...blockingNotes, ...reviewNotes].slice(0, 4),
  };

  if (reviewerApproved) return result;

  result.zone = "red";
  result.decision = "escalate";
  result.zoneReason =
    "ИИ-рецензент нашёл риск, который требует решения человека.";
  result.managerNote = `Перед выбором учтите замечания ИИ-рецензента. ${result.managerNote}`;
  result.options = [];
  const normalized = normalizeAgentResult(result, demoData, job);
  const missing =
    normalized.missing.slice(0, 2).join(", ") ||
    "условие, отмеченное ИИ-рецензентом";
  const safeQuestionReply =
    "Уточните, пожалуйста, главный приоритет по заказу: срок, цена или график поставки. После ответа подготовим подтверждённый вариант.";

  normalized.zone = "red";
  normalized.decision = "escalate";
  normalized.zoneReason =
    "ИИ-рецензент нашёл блокирующий риск. Руководитель выбирает следующий ход.";
  normalized.businessContext =
    "ИИ-рецензент исключил неподтверждённые выводы. Решение опирается на письмо, каталог, остатки и открытые источники ниже.";
  if (normalized.research) {
    normalized.research.summary = normalized.research.sources.length
      ? "Агент нашёл публичные источники. ИИ-рецензент исключил неподтверждённые выводы; откройте источники перед решением."
      : "";
  }
  normalized.options = [
    {
      id: "review-ask",
      title: "Запросить недостающий факт",
      rationale: `Уточнить у клиента: ${missing}.`,
      tradeoff: "Расчёт продолжится после одного ответа.",
      reply: safeQuestionReply,
    },
    {
      id: "review-check",
      title: "Проверить условие внутри компании",
      rationale:
        "Передать замечание снабжению, технологу или финансам и вернуться с подтверждённым ответом.",
      tradeoff: "Ответ клиенту потребует дополнительной внутренней проверки.",
      reply:
        "Ваш запрос принят. Проверяем условия со специалистами и направим подтверждённый ответ после согласования.",
    },
    {
      id: "review-call",
      title: "Согласовать приоритет с клиентом",
      rationale:
        "Провести короткий разговор и выбрать выполнимую комбинацию срока, цены и условий.",
      tradeoff: "Менеджер подключится к следующему контакту.",
      reply:
        "Предлагаем коротко согласовать приоритеты заказа: срок, цену и условия поставки. После разговора сразу закрепим выполнимый вариант.",
    },
  ];
  normalized.reply = {
    subject: `Ответ по заказу: ${cleanCopy(job?.subject) || "краска"}`,
    body:
      "Агент подготовил безопасные следующие ходы. Письмо получит текст выбранного руководителем варианта.",
  };
  return normalized;
}
