import demoData from "@/data/paint-demo.json";

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

function quantityFrom(text: string) {
  const kilograms = text.match(/(\d[\d\s]*)\s*(?:кг|килограмм)/i);
  if (kilograms) return Number(kilograms[1].replace(/\s/g, ""));
  const tons = text.match(/(\d+(?:[.,]\d+)?)\s*(?:т|тонн)/i);
  if (tons) return Math.round(Number(tons[1].replace(",", ".")) * 1000);
  return 0;
}

function productFor(text: string) {
  const lowered = text.toLowerCase();
  if (/(пол|цех|склад|эпокс)/.test(lowered)) return demoData.products[2];
  if (/(стен|гкл|штукатур|интерьер)/.test(lowered)) return demoData.products[3];
  if (/(дерев|дос|фасад.*дерев)/.test(lowered)) return demoData.products[4];
  if (/(металл|конструкц|грунт|ржав)/.test(lowered)) return demoData.products[0];
  return null;
}

function industryFor(text: string) {
  const lowered = text.toLowerCase();
  return (
    demoData.industries.find((industry) =>
      lowered.includes(industry.name.split(" ")[0]),
    ) ??
    (/(волгамаш|завод|машин)/.test(lowered)
      ? demoData.industries[1]
      : demoData.industries[0])
  );
}

export function buildDemoResult(input: OrderInput): AgentResult {
  const fullText = `${input.subject}\n${input.body}\n${input.company ?? ""}`;
  const requestedKg = quantityFrom(fullText);
  const product = productFor(fullText);
  const missing: string[] = [];

  if (!product) missing.push("тип поверхности или назначение покрытия");
  if (!requestedKg) missing.push("объём в килограммах");
  if (!/(внутр|наруж|улиц|цех|помещ)/i.test(fullText)) {
    missing.push("условия эксплуатации");
  }
  if (!/(ral|бел|сер|ч[её]рн|зел[её]н|цвет)/i.test(fullText)) {
    missing.push("цвет или номер RAL");
  }

  const understood = [
    input.company ? `Компания: ${input.company}` : "Компания не указана",
    product ? `Покрытие: ${product.name}` : "Покрытие пока не определено",
    requestedKg ? `Объём: ${money.format(requestedKg)} кг` : "Объём не указан",
  ];

  if (!product || missing.length >= 2) {
    const questions = missing.map((item) => `— Уточните, пожалуйста, ${item}.`);
    return {
      zone: "yellow",
      decision: "clarify",
      confidence: 0.78,
      understood,
      missing,
      product: null,
      market: {
        checked: false,
        summary: "Проверка рынка преждевременна: сначала нужно определить продукт.",
        items: [],
      },
      businessContext:
        "Агент фиксирует пробелы в заявке и сохраняет контекст заказа.",
      zoneReason: "Без существенных параметров безопасное предложение невозможно.",
      managerNote: "Запрос проходит по стандартному регламенту уточнения.",
      options: [],
      reply: {
        subject: `Уточнение по запросу: ${input.subject}`,
        body: `Добрый день!\n\nСпасибо за запрос. Чтобы подобрать покрытие и рассчитать предложение без риска ошибки, нам нужны уточнения:\n\n${questions.join(
          "\n",
        )}\n\nПосле ответа мы сразу проверим наличие и срок поставки.`,
      },
      checks: [
        "Цена появится после подтверждения продукта",
        "Ответ опирается на подтверждённые свойства",
        "Запрошены только существенные параметры",
      ],
      sources: ["Входящее письмо", "Правила продаж"],
      review: {
        model: "Модель-руководитель",
        verdict: "Корректно остановлено",
        notes: ["Коммерческие обещания отсутствуют", "Вопросы сокращены до необходимых"],
      },
    };
  }

  const total = requestedKg * product.pricePerKg;
  const marketItems = demoData.market.filter(
    (item) => item.category === product.category,
  );
  const shortage = requestedKg > product.stockKg;
  const industry = industryFor(fullText);
  const marketSummary = marketItems.length
    ? `Наша цена ${money.format(product.pricePerKg)} ₽/кг. Диапазон сопоставимых предложений: ${money.format(
        Math.min(...marketItems.map((item) => item.pricePerKg)),
      )}–${money.format(
        Math.max(...marketItems.map((item) => item.pricePerKg)),
      )} ₽/кг.`
    : "Сопоставимых предложений в текущем срезе рынка нет.";

  if (shortage) {
    const remainder = requestedKg - product.stockKg;
    const firstReply = `Добрый день!\n\nПодобрали ${product.name} для вашего запроса. Готовы отгрузить ${money.format(
      product.stockKg,
    )} кг сразу и оставшиеся ${money.format(remainder)} кг через ${
      product.replenishmentDays
    } дней с фиксацией цены ${money.format(product.pricePerKg)} ₽/кг. Уточните, пожалуйста, точный RAL для резервирования партии.`;
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
      businessContext: `Для отрасли «${industry.name}» важны ${industry.priority}; ключевой риск — ${industry.risk}.`,
      zoneReason: `В наличии ${money.format(product.stockKg)} из ${money.format(
        requestedKg,
      )} кг. Обещание полного объёма требует решения руководителя.`,
      managerNote: `Рекомендуется ${industry.play}. Это сохраняет заказ без выхода за минимальную цену.`,
      options: [
        {
          id: "split",
          title: "Две поставки с фиксацией цены",
          rationale: `${money.format(product.stockKg)} кг сейчас, остаток через ${
            product.replenishmentDays
          } дней. Клиент запускает работу без ожидания всей партии.`,
          tradeoff: "Потребуются две отгрузки.",
          reply: firstReply,
        },
        {
          id: "alternative",
          title: "Предложить доступный аналог",
          rationale:
            "Закрыть полный объём продуктом «Металл Про» из наличия с расширенной защитой.",
          tradeoff: "Цена выше, требуется подтверждение совместимости.",
          reply: `Добрый день!\n\nТребуемый объём базового продукта сейчас ограничен. Можем предложить ${demoData.products[1].name} в полном объёме из наличия. Покрытие обладает повышенной стойкостью к УФ и химическим воздействиям. Перед расчётом подтвердим совместимость с вашей технологией.`,
        },
        {
          id: "contract",
          title: "Условия за прогнозируемый объём",
          rationale:
            "Согласовать специальную цену в обмен на предоплату и квартальный график закупок.",
          tradeoff: "Потребуется договорённость о будущем объёме.",
          reply: `Добрый день!\n\nГотовы обсудить специальное ценовое условие при фиксации квартального объёма и предоплате. Текущий заказ предложим поставить двумя партиями без остановки ваших работ.`,
        },
      ],
      reply: {
        subject: `Предложение по заказу: ${product.name}`,
        body: firstReply,
      },
      checks: [
        `Цена ${money.format(product.pricePerKg)} ₽/кг подтверждена каталогом`,
        `Цена соблюдает минимум ${money.format(product.minPricePerKg)} ₽/кг`,
        "Обещание полного объёма передано на согласование",
        "Рыночные данные имеют дату среза",
      ],
      sources: ["Каталог и остатки", "Правила продаж", "Срез рынка", "Отраслевые сценарии"],
      review: {
        model: "Модель-руководитель",
        verdict: "Разрешено только после выбора руководителя",
        notes: [
          "Цифры сверены с каталогом",
          "Дефицит явно раскрыт",
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
    businessContext: `Товар полностью доступен. Для отрасли «${industry.name}» предложение усилено аргументом о ${industry.priority}.`,
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
      )} ₽ без учёта доставки.\n\nТовар есть в наличии. После подтверждения цвета и адреса поставки зарезервируем партию и направим точный график отгрузки.`,
    },
    checks: [
      "Весь объём подтверждён остатками",
      `Цена выше минимальной границы ${money.format(product.minPricePerKg)} ₽/кг`,
      "Свойства взяты из карточки продукта",
      "Регламент разрешает самостоятельный ответ агента",
    ],
    sources: ["Каталог и остатки", "Правила продаж", "Срез рынка"],
    review: {
      model: "Модель-руководитель",
      verdict: "Одобрено для автоответа",
      notes: ["Цена и объём подтверждены", "Неподтверждённых обещаний нет"],
    },
  };
}
