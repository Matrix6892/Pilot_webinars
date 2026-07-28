import demoData from "@/data/paint-demo.json";
import {
  asksCompatibility,
  explicitSkuFromText,
  hasColor,
  hasSpecialTerms,
  hasUsableEnvironment,
  matchProduct,
  quantityFromText,
  quotedUnitPrices,
} from "@/lib/order-facts.mjs";

export type OrderInput = {
  subject: string;
  body: string;
  company?: string;
  website?: string;
};

export type AgentOption = {
  id: string;
  title: string;
  rationale: string;
  tradeoff: string;
  reply: string;
};

export type AgentResult = {
  zone: "green" | "yellow" | "red";
  decision: "quote" | "clarify" | "escalate";
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
  market: {
    checked: boolean;
    summary: string;
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
  review: {
    model: string;
    verdict: string;
    notes: string[];
  };
};

const money = new Intl.NumberFormat("ru-RU");

function industryFor(text: string) {
  const lowered = text.toLowerCase();
  if (/(машиностро|волгамаш|завод|машин|оборудован)/.test(lowered)) {
    return demoData.industries[1];
  }
  if (/(строит|строй|объект|подряд|девелоп|ремонт|офис)/.test(lowered)) {
    return demoData.industries[2];
  }
  if (/(склад|логистическ|терминал|покрыти[ея]\s+пола)/.test(lowered)) {
    return demoData.industries[3];
  }
  if (/(металлоконструк|антикорроз|корроз)/.test(lowered)) {
    return demoData.industries[0];
  }
  return null;
}

export function buildDemoResult(input: OrderInput): AgentResult {
  const fullText = `${input.subject}\n${input.body}`;
  const businessText = `${fullText}\n${input.company ?? ""}`;
  const requestedKg = quantityFromText(fullText);
  const product = matchProduct(fullText, demoData.products);
  const missing: string[] = [];
  const unknownSku = Boolean(explicitSkuFromText(fullText)) && !product;

  if (unknownSku) {
    missing.push("артикул отсутствует в демонстрационном каталоге");
  } else if (!product) {
    missing.push("тип поверхности или назначение покрытия");
  }
  if (!requestedKg) missing.push("объём в килограммах");
  if (!hasUsableEnvironment(fullText)) {
    missing.push("условия эксплуатации");
  }
  if (!hasColor(fullText)) {
    missing.push("цвет или номер RAL");
  }
  if (asksCompatibility(fullText)) {
    missing.push("совместимость с указанной нагрузкой или средой");
  }
  const hardRed =
    Boolean(product) &&
    requestedKg > 0 &&
    (requestedKg > (product?.stockKg ?? 0) ||
      hasSpecialTerms(fullText) ||
      quotedUnitPrices(fullText).some(
        (price) => price < (product?.minPricePerKg ?? 0),
      ));

  const understood = [
    input.company ? `Компания: ${input.company}` : "Компания не указана",
    product ? `Покрытие: ${product.name}` : "Покрытие пока не определено",
    requestedKg ? `Объём: ${money.format(requestedKg)} кг` : "Объём не указан",
  ];

  if (!product || (missing.length > 0 && !hardRed)) {
    const questions = missing.map((item) => `— Уточните, пожалуйста, ${item}.`);
    const confirmedProduct = product
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
    return {
      zone: "yellow",
      decision: "clarify",
      confidence: 0.78,
      understood,
      missing,
      product: confirmedProduct,
      market: {
        checked: false,
        summary: product
          ? "Сравнение рынка продолжится после получения недостающих данных."
          : "Сравнение рынка начнётся после уточнения продукта.",
        items: [],
      },
      research: {
        checked: false,
        summary:
          "Публичный контекст компании проверит живой OpenCode при подключённом мосте.",
        sources: [],
      },
      businessContext: product
        ? `Продукт «${product.name}» подтверждён каталогом. Ответ клиента даст данные для следующего расчёта.`
        : "Агент сохранил известные факты и подготовил безопасный следующий шаг.",
      zoneReason: unknownSku
        ? "Артикул отсутствует в каталоге. Агент остановил расчёт до подтверждения продукта."
        : "Для точного предложения нужно подтвердить существенные параметры.",
      managerNote:
        "Рекомендуемый ход: отправить точные вопросы. После подключения входящей почты ответ клиента запустит следующий расчёт.",
      options: [],
      reply: {
        subject: product
          ? `Уточнение по заказу: ${product.name}`
          : "Уточнение по заказу краски",
        body: `Добрый день!\n\nСпасибо за запрос. Чтобы подобрать покрытие и рассчитать предложение без риска ошибки, нам нужны уточнения:\n\n${questions.join(
          "\n",
        )}\n\nПосле ответа мы сразу проверим наличие и срок поставки.`,
      },
      checks: product
        ? [
            "Продукт, остаток и цена подтверждены каталогом",
            "Подтверждённые данные сохранены для следующего расчёта",
            "Запрошены только существенные параметры",
          ]
        : [
            "Цена появится после подтверждения продукта",
            "Ответ опирается на подтверждённые свойства",
            "Запрошены только существенные параметры",
          ],
      sources: product
        ? ["Входящее письмо", "Каталог и остатки", "Правила продаж"]
        : ["Входящее письмо", "Правила продаж"],
      review: {
        model: "Правила стенда",
        verdict: "Правила остановили расчёт",
        notes: ["Коммерческие обещания отсутствуют", "Вопросы сокращены до необходимых"],
      },
    };
  }

  const total = requestedKg * product.pricePerKg;
  const marketItems = demoData.market.filter(
    (item) => item.category === product.category,
  );
  const shortage = requestedKg > product.stockKg;
  const specialTerms = hasSpecialTerms(fullText);
  const belowMinimum = quotedUnitPrices(fullText).some(
    (price) => price < product.minPricePerKg,
  );
  const industry = industryFor(businessText);
  const businessContext = industry
    ? `Для клиента из отрасли «${industry.name}» приоритет: ${industry.priority}. Риск: ${industry.risk}.`
    : `Решение опирается на свойства продукта: ${product.features.join(", ")}.`;
  const marketPrices = marketItems.map((item) => item.pricePerKg);
  const marketMin = Math.min(...marketPrices);
  const marketMax = Math.max(...marketPrices);
  const marketSummary = marketItems.length
    ? marketMin === marketMax
      ? `Демонстрационный срез. Цена «Колер»: ${money.format(
          product.pricePerKg,
        )} ₽/кг. Ориентир сопоставимого предложения: ${money.format(
          marketMin,
        )} ₽/кг.`
      : `Демонстрационный срез. Цена «Колер»: ${money.format(
          product.pricePerKg,
        )} ₽/кг. Диапазон сопоставимых предложений: ${money.format(
          marketMin,
        )}–${money.format(marketMax)} ₽/кг.`
    : "В демонстрационном срезе нет сопоставимых предложений.";

  if (shortage || specialTerms || belowMinimum) {
    const remainder = Math.max(0, requestedKg - product.stockKg);
    const compatibleAlternative = demoData.products.find(
      (candidate) =>
        product.analogues.includes(candidate.sku) &&
        candidate.stockKg >= requestedKg,
    );
    const colorRequest = hasColor(fullText)
      ? "После выбора варианта зарезервируем доступную партию."
      : "Уточните точный цвет, чтобы мы зарезервировали доступную партию.";
    const firstReply = shortage
      ? `Добрый день!\n\nПодобрали ${product.name} для вашего запроса. Готовы отгрузить ${money.format(
          product.stockKg,
        )} кг сразу и оставшиеся ${money.format(remainder)} кг через ${
          product.replenishmentDays
        } дней с фиксацией цены ${money.format(product.pricePerKg)} ₽/кг. ${colorRequest}`
      : `Добрый день!\n\nПодтвердили наличие ${money.format(
          requestedKg,
        )} кг продукта «${product.name}» по цене ${money.format(
          product.pricePerKg,
        )} ₽/кг. Запрошенные коммерческие условия передали руководителю. После согласования направим точный график и условия договора.`;
    const options: AgentOption[] = shortage
      ? [
          {
            id: "split",
            title: "Две поставки с фиксацией цены",
            rationale: `${money.format(product.stockKg)} кг сейчас, остаток через ${
              product.replenishmentDays
            } дней. Клиент запускает работу без ожидания всей партии.`,
            tradeoff: "Потребуются две отгрузки.",
            reply: firstReply,
          },
          ...(compatibleAlternative
            ? [
                {
                  id: "alternative",
                  title: `Предложить ${compatibleAlternative.name}`,
                  rationale: `${money.format(
                    requestedKg,
                  )} кг можно закрыть из наличия после проверки совместимости.`,
                  tradeoff: `Цена ${money.format(
                    compatibleAlternative.pricePerKg,
                  )} ₽/кг; технолог подтверждает замену.`,
                  reply: `Добрый день!\n\nМожем закрыть полный объём продуктом «${compatibleAlternative.name}» из наличия по цене ${money.format(
                    compatibleAlternative.pricePerKg,
                  )} ₽/кг. Перед резервированием подтвердим совместимость покрытия с вашей технологией.`,
                },
              ]
            : []),
          {
            id: "contract",
            title: "Поставить остаток в приоритет",
            rationale:
              "Зарезервировать доступную партию и поставить недостающий объём в производственный план.",
            tradeoff: "Производство подтверждает точную дату второй отгрузки.",
            reply: `Добрый день!\n\nЗарезервируем ${money.format(
              product.stockKg,
            )} кг из наличия и поставим недостающие ${money.format(
              remainder,
            )} кг в приоритетный производственный план. После подтверждения заказа направим точную дату второй отгрузки.`,
          },
          {
            id: "clarify",
            title: "Уточнить допустимый график",
            rationale:
              "Узнать минимальный объём первой партии и предельную дату закрытия заказа.",
            tradeoff: "Расчёт продолжится после короткого ответа клиента.",
            reply:
              "Добрый день!\n\nУточните минимальный объём первой партии и предельную дату поставки остатка. По ответу сразу закрепим выполнимый график.",
          },
        ].slice(0, 3)
      : [
          {
            id: "standard",
            title: "Сохранить стандартные условия",
            rationale:
              "Подтвердить наличие и цену, предложить обычный срок оплаты и поставки.",
            tradeoff: "Клиенту потребуется принять базовые условия.",
            reply: firstReply,
          },
          {
            id: "volume",
            title: "Связать условие с объёмом",
            rationale:
              "Рассмотреть скидку или отсрочку при предоплате и квартальном графике.",
            tradeoff: "Потребуется договорённость о будущем объёме.",
            reply: `Добрый день!\n\nГотовы обсудить специальное условие при фиксации квартального объёма и согласованной предоплате. Текущая цена по прайсу составляет ${money.format(
              product.pricePerKg,
            )} ₽/кг.`,
          },
          {
            id: "clarify",
            title: "Уточнить приоритет клиента",
            rationale:
              "Выяснить, что важнее: срок, цена или схема оплаты, и собрать выполнимое предложение.",
            tradeoff: "Понадобится один короткий ответ клиента.",
            reply:
              "Добрый день!\n\nУточните главный приоритет по заказу: срок поставки, целевая цена или схема оплаты. Подготовим выполнимый вариант под выбранное условие.",
          },
        ];
    return {
      zone: "red",
      decision: "escalate",
      confidence: 0.93,
      understood,
      missing: missing.slice(0, 1),
      product: {
        sku: product.sku,
        name: product.name,
        stockKg: product.stockKg,
        requestedKg,
        pricePerKg: product.pricePerKg,
        total,
        replenishmentDays: product.replenishmentDays,
      },
      market: {
        checked: true,
        summary: marketSummary,
        items: marketItems,
      },
      research: {
        checked: false,
        summary:
          "В живом режиме агент проверит публичный контекст компании и приложит ссылки.",
        sources: [],
      },
      businessContext,
      zoneReason: shortage
        ? `В наличии ${money.format(product.stockKg)} из ${money.format(
            requestedKg,
          )} кг. Условие поставки требует решения руководителя.`
        : belowMinimum
          ? `Клиент назвал цену ниже минимальной границы ${money.format(
              product.minPricePerKg,
            )} ₽/кг. Условие передано руководителю вместе с вариантами.`
          : "Коммерческие условия или срок выходят за полномочия агента.",
      managerNote: industry
        ? `Рекомендуемый ход: ${industry.play}. Ценовая граница сохраняется.`
        : "Рекомендуемый ход: предложить выполнимый график и закрепить цену.",
      options,
      reply: {
        subject: `Предложение по заказу: ${product.name}`,
        body:
          "Агент подготовил варианты. Текст письма соберётся из условия, которое выберет руководитель.",
      },
      checks: [
        `Цена ${money.format(product.pricePerKg)} ₽/кг подтверждена каталогом`,
        `Цена соблюдает минимум ${money.format(product.minPricePerKg)} ₽/кг`,
        shortage
          ? "Обещание полного объёма передано на согласование"
          : "Особые условия переданы на согласование",
        "Рыночные данные имеют дату среза",
      ],
      sources: [
        "Каталог и остатки",
        "Правила продаж",
        "Демонстрационный срез рынка",
        "Демонстрационные отраслевые сценарии",
      ],
      review: {
        model: "Правила стенда",
        verdict: "Решение остаётся за руководителем",
        notes: [
          "Цифры сверены с каталогом",
          shortage ? "Дефицит явно раскрыт" : "Особые условия явно раскрыты",
          "Каждый вариант сохраняет ценовую границу",
        ],
      },
    };
  }

  return {
    zone: "green",
    decision: "quote",
    confidence: 0.96,
    understood,
    missing: missing.slice(0, 1),
    product: {
      sku: product.sku,
      name: product.name,
      stockKg: product.stockKg,
      requestedKg,
      pricePerKg: product.pricePerKg,
      total,
      replenishmentDays: product.replenishmentDays,
    },
    market: {
      checked: true,
      summary: marketSummary,
      items: marketItems,
    },
    research: {
      checked: false,
      summary:
        "Для стандартного заказа публичный поиск компании не влияет на решение.",
      sources: [],
    },
    businessContext: `Товар полностью доступен. ${businessContext}`,
    zoneReason: "Товар есть полностью, цена и свойства подтверждены источниками.",
    managerNote: "Предложение проходит по стандартному регламенту.",
    options: [],
      reply: {
        subject: `Коммерческое предложение: ${product.name}`,
      body: `Добрый день!\n\nПодтверждаем возможность поставки ${money.format(
        requestedKg,
      )} кг продукта «${product.name}» по цене ${money.format(
        product.pricePerKg,
      )} ₽/кг. Стоимость партии — ${money.format(
        total,
      )} ₽ без учёта доставки.\n\nТовар есть в наличии. После подтверждения заказа зарезервируем партию и направим точный график отгрузки.`,
    },
    checks: [
      "Весь объём подтверждён остатками",
      `Цена выше минимальной границы ${money.format(product.minPricePerKg)} ₽/кг`,
      "Свойства взяты из карточки продукта",
      "Регламент разрешает самостоятельный ответ агента",
    ],
    sources: [
      "Каталог и остатки",
      "Правила продаж",
      "Демонстрационный срез рынка",
    ],
    review: {
      model: "Правила стенда",
      verdict: "Правила пропустили ответ",
      notes: ["Цена и объём подтверждены", "Неподтверждённых обещаний нет"],
    },
  };
}
