const money = new Intl.NumberFormat("ru-RU");

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasUnexpectedLatin(value) {
  return /[A-Za-z]{3,}/.test(text(value).replace(/\bRAL(?:\s*\d{4})?\b/gi, ""));
}

function cleanCopy(value) {
  const candidate = text(value);
  return candidate && !hasUnexpectedLatin(candidate) ? candidate : "";
}

function cleanList(value) {
  return Array.isArray(value)
    ? value.map(cleanCopy).filter(Boolean).slice(0, 8)
    : [];
}

function industryFor(job, demoData) {
  const source = `${job?.subject ?? ""} ${job?.body ?? ""} ${
    job?.company ?? ""
  }`.toLowerCase();
  return (
    demoData.industries.find((industry) =>
      source.includes(industry.name.split(" ")[0]),
    ) ??
    (/(волгамаш|завод|машин|оборудован)/.test(source)
      ? demoData.industries[1]
      : demoData.industries[0])
  );
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
      ? `${comparison} Цена КОЛЕР: ${money.format(product.pricePerKg)} ₽/кг.`
      : "Сопоставимых предложений в демонстрационном срезе пока нет.",
    items,
  };
}

function optionIsSafe(option) {
  if (!option || typeof option !== "object") return false;
  return ["title", "rationale", "tradeoff", "reply"].every(
    (key) => Boolean(cleanCopy(option[key])),
  );
}

function fallbackOptions(product, requestedKg, demoData) {
  const availableKg = Math.min(product.stockKg, requestedKg);
  const missingKg = Math.max(0, requestedKg - product.stockKg);
  const alternative = demoData.products.find(
    (candidate) =>
      candidate.sku !== product.sku &&
      candidate.stockKg >= requestedKg &&
      candidate.substrates.some((substrate) =>
        product.substrates.includes(substrate),
      ),
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

  return options.slice(0, 3);
}

function fallbackReply(result, job) {
  const subject = `Предложение по заказу: ${text(job?.subject) || "краска"}`;

  if (result.zone === "yellow") {
    const questions = result.missing.length
      ? result.missing.map((item) => `— ${item}`).join("\n")
      : "— назначение покрытия\n— объём\n— условия эксплуатации";
    return {
      subject: `Уточнение по заказу: ${text(job?.subject) || "краска"}`,
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

  result.understood = cleanList(result.understood);
  result.missing = cleanList(result.missing);
  result.options = Array.isArray(result.options)
    ? result.options.filter(optionIsSafe).slice(0, 3)
    : [];
  result.confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));

  const industry = industryFor(job, demoData);
  const suppliedBusinessContext = cleanCopy(result.businessContext);
  result.businessContext =
    suppliedBusinessContext ||
    `Для отрасли «${industry.name}» важны ${industry.priority}; ключевой риск — ${industry.risk}.`;

  if (result.product?.sku) {
    const sourceProduct = demoData.products.find(
      (product) => product.sku === result.product.sku,
    );
    if (sourceProduct) {
      const requestedKg = Number(result.product.requestedKg) || 0;
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
          ? `Срез рынка проверен ${marketDate}`
          : "Срез рынка проверен по доступным данным",
      ];
      result.sources = [
        "Входящее письмо",
        "Каталог и остатки",
        "Правила продаж",
        ...(result.market.items.length ? ["Срез рынка"] : []),
        "Отраслевой сценарий",
      ];

      if (
        requestedKg > sourceProduct.stockKg ||
        sourceProduct.pricePerKg < sourceProduct.minPricePerKg
      ) {
        result.zone = "red";
        result.decision = "escalate";
        result.zoneReason = `Красная зона по жёсткому правилу: запрошено ${money.format(
          requestedKg,
        )} кг, в наличии ${money.format(
          sourceProduct.stockKg,
        )} кг. Обещание полного объёма требует решения руководителя.`;
        result.checks.push("Границу зоны определили жёсткие правила");
      }

      if (result.zone === "red" && result.options.length < 3) {
        result.options = fallbackOptions(sourceProduct, requestedKg, demoData);
      }
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
      ? `Рекомендуется ${industry.play}.`
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
    subject: cleanCopy(result.reply.subject),
    body: cleanCopy(result.reply.body),
  };
  result.reply =
    suppliedReply?.subject && suppliedReply.body
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

  return result;
}
