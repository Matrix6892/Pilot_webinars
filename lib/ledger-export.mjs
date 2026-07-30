export const LEDGER_CSV_HEADERS = [
  "Тип записи",
  "Состояние записи",
  "Состояние карточки",
  "Дата и время",
  "Номер записи",
  "Заявка",
  "Этап переписки №",
  "Компания",
  "Отправитель",
  "Получатель",
  "Тема письма",
  "Полный текст",
  "Вложение",
  "Название события",
  "Этап агента",
  "Модель для заказов",
  "Модель для проверки",
  "Решение агента",
  "Основание решения",
  "Предложенные варианты",
  "Решение руководителя",
  "Время решения руководителя",
  "Время отправки",
  "Код краски",
  "Было, кг",
  "Стало, кг",
  "Обновление склада №",
  "Причина изменения склада",
  "Кто изменил склад",
  "Внутренний номер записи",
];

/**
 * @typedef {{
 *   id?: string,
 *   subject?: string,
 *   body?: string,
 *   company?: string,
 *   status?: string,
 *   zone?: string | null,
 *   result?: unknown,
 *   resultJson?: string | null,
 *   attachment?: unknown,
 *   attachmentJson?: string | null,
 *   conversation?: unknown,
 *   conversationJson?: string | null,
 *   roundNo?: number,
 *   managerDecision?: string | null,
 *   managerOptionId?: string | null,
 *   managerDecidedAt?: string | null,
 *   agentModel?: string | null,
 *   reviewerModel?: string | null,
 *   sentAt?: string | null,
 *   createdAt?: string,
 *   updatedAt?: string,
 * }} LedgerOrderRow
 */

/**
 * @typedef {{
 *   id?: string | number,
 *   orderId?: string,
 *   stage?: string,
 *   title?: string,
 *   detail?: string,
 *   state?: string,
 *   createdAt?: string,
 * }} LedgerEventRow
 */

/**
 * @typedef {{
 *   id?: string | number,
 *   sku?: string,
 *   revision?: number,
 *   beforeStockKg?: number,
 *   afterStockKg?: number,
 *   reason?: string,
 *   actor?: string,
 *   createdAt?: string,
 * }} LedgerInventoryRow
 */

/**
 * @typedef {{
 *   id?: string | number,
 *   orderId?: string,
 *   roundNo?: number,
 *   zone?: string,
 *   route?: string,
 *   status?: string,
 *   reason?: string,
 *   replySubject?: string,
 *   replyBody?: string,
 *   zoneReason?: string,
 *   optionsJson?: string,
 *   resultJson?: string,
 *   inventorySnapshotJson?: string | null,
 *   agentModel?: string | null,
 *   reviewerModel?: string | null,
 *   sourceKey?: string | null,
 *   createdAt?: string,
 * }} LedgerResultHistoryRow
 */

const ORDER_STATUS_LABELS = {
  queued: "Агент принял заявку",
  processing: "Агент готовит решение",
  clarification_ready: "Агент подготовил вопросы клиенту",
  awaiting_customer: "Агент ждёт ответ клиента",
  awaiting_approval: "Руководитель выбирает вариант",
  ready_to_send: "Агент подготовил ответ · следующий шаг — резерв товара",
  reserved: "Агент подготовил резерв товара",
  completed: "Агент подготовил ответ к отправке",
  sent: "Стенд записал отправку",
  error: "Стенд сохранил карточку · можно запустить снова",
};

const EVENT_STATE_LABELS = {
  active: "Система выполняет шаг",
  done: "Система завершила шаг",
  error: "Система сохранила карточку · можно запустить снова",
  pending: "Система ждёт запуска",
  queued: "Система поставила шаг в очередь",
};

const MODEL_LABELS = {
  "opencode-go/deepseek-v4-flash": "DeepSeek V4 Flash",
  "opencode-go/deepseek-v4-pro": "DeepSeek V4 Pro",
  "opencode/gpt-5.6-sol": "GPT-5.6 Sol",
  "Готовая инструкция": "Автоматическая обработка по правилам",
  "Расчёт по готовой инструкции": "Автоматическая обработка по правилам",
};

const INVENTORY_ACTOR_LABELS = {
  admin: "Ведущий",
  "sheets-sync": "Таблица склада",
};

const HUMAN_TEXT_HEADERS = new Set([
  "Тип записи",
  "Состояние записи",
  "Состояние карточки",
  "Компания",
  "Отправитель",
  "Получатель",
  "Тема письма",
  "Полный текст",
  "Название события",
  "Этап агента",
  "Решение агента",
  "Основание решения",
  "Предложенные варианты",
  "Решение руководителя",
  "Причина изменения склада",
]);

const EVENT_STAGE_LABELS = {
  received: "Получение заявки",
  understanding: "Понимание запроса",
  clarification: "Подготовка вопросов",
  inventory: "Проверка склада",
  market: "Сравнение с ценами других поставщиков",
  "partner-stock": "Проверка наличия у другого поставщика",
  "company-context": "Сведения о компании",
  "source-plan": "Выбор данных для решения",
  research: "Поиск сведений в открытых источниках",
  "research-fallback": "Продолжение по данным заказа",
  "primary-retry": "Продолжение по данным заказа",
  "research-result": "Сведения для решения собраны",
  review: "Проверка ответа",
  "review-result": "Проверка GPT-5.6 Sol завершена",
  "review-fallback": "Передача решения руководителю",
  vision: "Осмотр фотографии",
  "vision-result": "Признаки на фотографии собраны",
  "vision-fallback": "Подготовка вопросов по фотографии",
  model: "Выбор модели для заявки",
  decision: "Подготовка решения",
  fallback: "Программа завершает шаг",
  "clarification-sent": "Запись вопросов",
  "customer-reply": "Получение ответа клиента",
  recalculate: "Пересчёт по свежему складу",
  reserve: "Подготовка резерва товара",
  sent: "Запись отправки",
  approval: "Решение руководителя",
  approve: "Решение руководителя",
  approved: "Решение руководителя",
  error: "Карточку можно запустить снова",
  agent: "Работа агента",
  retry: "Повторный запуск",
};

const EVENT_STAGE_PRESENTATIONS = {
  received: {
    recordType: "Приём заявки",
    sender: "Программа стенда",
    recipient: "Агент отдела продаж",
  },
  understanding: {
    recordType: "Анализ заявки",
    sender: "Агент отдела продаж",
    recipient: "Карточка заказа",
  },
  "source-plan": {
    recordType: "Выбор данных",
    sender: "Агент отдела продаж",
    recipient: "Карточка заказа",
  },
  clarification: {
    recordType: "Подготовка вопросов",
    sender: "Агент отдела продаж",
    recipient: "Карточка заказа",
  },
  inventory: {
    recordType: "Проверка склада",
    sender: "Агент отдела продаж",
    recipient: "Склад",
  },
  market: {
    recordType: "Сравнение цен других поставщиков",
    sender: "Агент отдела продаж",
    recipient: "Карточка заказа",
  },
  "partner-stock": {
    recordType: "Проверка наличия у другого поставщика",
    sender: "Агент отдела продаж",
    recipient: "Карточка заказа",
  },
  "company-context": {
    recordType: "Проверка компании",
    sender: "Агент отдела продаж",
    recipient: "Карточка заказа",
  },
  research: {
    recordType: "Поиск сведений",
    sender: "Агент отдела продаж",
    recipient: "Открытый источник",
  },
  "research-result": {
    recordType: "Результат поиска",
    sender: "Агент отдела продаж",
    recipient: "Карточка заказа",
  },
  review: {
    recordType: "Проверка ответа",
    sender: "Программа проверки",
    recipient: "Агент отдела продаж",
  },
  "review-result": {
    recordType: "Результат проверки",
    sender: "Модель проверки",
    recipient: "Агент отдела продаж",
  },
  "review-fallback": {
    recordType: "Передача руководителю",
    sender: "Программа проверки",
    recipient: "Руководитель",
    stateLabel: "Программа передала решение руководителю",
  },
  vision: {
    recordType: "Осмотр фотографии",
    sender: "Модель для фотографий",
    recipient: "Вложение клиента",
  },
  "vision-result": {
    recordType: "Результат осмотра фотографии",
    sender: "Модель для фотографий",
    recipient: "Агент отдела продаж",
  },
  "vision-fallback": {
    recordType: "Вопросы по фотографии",
    sender: "Программа стенда",
    recipient: "Агент отдела продаж",
    stateLabel: "Агент подготовил уточняющие вопросы",
  },
  "research-fallback": {
    recordType: "Продолжение работы",
    sender: "Программа запуска моделей",
    recipient: "Агент отдела продаж",
    stateLabel: "Программа продолжила обработку по данным заказа",
  },
  "primary-retry": {
    recordType: "Продолжение работы",
    sender: "Программа запуска моделей",
    recipient: "Агент отдела продаж",
    stateLabel: "Программа продолжила обработку по данным заказа",
  },
  model: {
    recordType: "Выбор модели",
    sender: "Программа запуска моделей",
    recipient: "Агент отдела продаж",
  },
  decision: {
    recordType: "Решение агента",
    sender: "Агент отдела продаж",
    recipient: "Карточка заказа",
  },
  fallback: {
    recordType: "Событие программы",
    sender: "Программа стенда",
    recipient: "Карточка заказа",
  },
  "clarification-sent": {
    recordType: "Запись вопросов",
    sender: "Агент отдела продаж",
    recipient: "Клиент",
    stateLabel: "Стенд записал вопросы",
  },
  "customer-reply": {
    recordType: "Ответ клиента",
    sender: "Клиент",
    recipient: "Отдел продаж",
    stateLabel: "Клиент ответил",
  },
  recalculate: {
    recordType: "Пересчёт заказа",
    sender: "Программа расчёта",
    recipient: "Карточка заказа",
  },
  reserve: {
    recordType: "Резерв товара",
    sender: "Агент отдела продаж",
    recipient: "Учётная система",
    stateLabel: "Агент подготовил резерв товара",
  },
  sent: {
    recordType: "Запись отправки",
    sender: "Агент отдела продаж",
    recipient: "Клиент",
    stateLabel: "Стенд записал отправку ответа",
  },
  approval: {
    recordType: "Решение руководителя",
    sender: "Руководитель",
    recipient: "Агент отдела продаж",
    stateLabel: "Руководитель принял решение",
  },
  approve: {
    recordType: "Решение руководителя",
    sender: "Руководитель",
    recipient: "Агент отдела продаж",
    stateLabel: "Руководитель принял решение",
  },
  approved: {
    recordType: "Решение руководителя",
    sender: "Руководитель",
    recipient: "Агент отдела продаж",
    stateLabel: "Руководитель принял решение",
  },
  error: {
    recordType: "Повторный запуск программы",
    sender: "Программа стенда",
    recipient: "Карточка заказа",
  },
  agent: {
    recordType: "Действие агента",
    sender: "Агент отдела продаж",
    recipient: "Карточка заказа",
  },
  retry: {
    recordType: "Повторный запуск",
    sender: "Программа стенда",
    recipient: "Карточка заказа",
  },
};

const ROUTE_LABELS = {
  green: "Готов ответить",
  yellow: "Нужны детали",
  red: "Решает руководитель",
  ready: "Готов ответить",
  needs_info: "Нужны детали",
  manager: "Решает руководитель",
};

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function storedObject(value) {
  const parsed = storedJson(value);
  return objectValue(parsed);
}

function storedJson(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let candidate = value;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (typeof candidate !== "string") return candidate;
    const text = candidate.trim();
    if (!text) return null;
    try {
      candidate = JSON.parse(text);
      continue;
    } catch {
      try {
        const decoded = decodeURIComponent(text);
        if (decoded !== text) {
          candidate = decoded;
          continue;
        }
      } catch {
        // Some old rows contain malformed percent escapes.
      }
      return null;
    }
  }

  return typeof candidate === "string" ? null : candidate;
}

function textValue(value) {
  return typeof value === "string" ? value : "";
}

function replacementWithInitialCase(source, replacement) {
  if (!/^[А-ЯЁA-Z]/u.test(source)) return replacement;
  return replacement[0].toLocaleUpperCase("ru-RU") + replacement.slice(1);
}

function friendlyLedgerText(value) {
  return textValue(value)
    .replace(
      /цена\s+([\d\s]+)\s*₽\/кг\s+в\s+пределах\s+minPricePerKg\s+([\d\s]+)\s*₽\/кг\s*[—-]\s*нарушений\s+нет\.?/giu,
      (_, price, floor) =>
        `Цена ${price.trim()} ₽/кг. Завод зарабатывает при цене от ${floor.trim()} ₽/кг.`,
    )
    .replace(
      /вариант\s+split\s+не\s+обещает\s+отгрузку\s+сверх\s+остатка\.?/giu,
      "Поставка двумя партиями опирается на подтверждённый остаток.",
    )
    .replace(
      /вариант руководителя согласован/giu,
      "Руководитель подтвердил выбранный вариант",
    )
    .replace(
      /(\d[\d\s]*)\s*кг\s+остал(?:ось|ись)\s+после\s+резервов/giu,
      (_, quantity) =>
        `${quantity.trim()} кг осталось после других заказов`,
    )
    .replace(
      /после согласования/giu,
      "после подтверждения условий руководителем",
    )
    .replace(
      /цена\s+([\d\s]+)\s*₽\/кг\s+выше\s+(?:нижней\s+)?выгодной\s+границы\s+([\d\s]+)\s*₽\/кг\s*[—-]\s*заказ\s+приносит\s+прибыль\.?/giu,
      (_, price, floor) =>
        `Цена ${price.trim()} ₽/кг. Завод зарабатывает при цене от ${floor.trim()} ₽/кг.`,
    )
    .replace(/\broute\s+ready\b/giu, "ответ готов")
    .replace(/\broute\s+manager\b/giu, "решает руководитель")
    .replace(/\broute\s+needs_info\b/giu, "нужны детали")
    .replace(
      /(?:вариант|формат)\s+split\b/giu,
      "Поставка двумя партиями",
    )
    .replace(/\bsplit\b/giu, "поставка двумя партиями")
    .replace(
      /нарушени\p{L}*\s+передано\s+руководителю/giu,
      "Особое условие передано руководителю",
    )
    .replace(/нарушений\s+нет/giu, (match) =>
      replacementWithInitialCase(match, "условия подходят"),
    )
    .replace(/без\s+нарушений/giu, (match) =>
      replacementWithInitialCase(match, "условия подходят"),
    )
    .replace(/нарушени\p{L}*/giu, (match) =>
      replacementWithInitialCase(
        match,
        "условие для решения руководителя",
      ),
    )
    .replace(/снимок\s+склада/giu, (match) =>
      replacementWithInitialCase(match, "остаток на момент расчёта"),
    )
    .replace(/рыночн\p{L}*\s+позици\p{L}*\s+учтена/giu, (match) =>
      replacementWithInitialCase(
        match,
        "сравнение с ценами других поставщиков учтено",
      ),
    )
    .replace(/рыночн\p{L}*\s+позици\p{L}*/giu, (match) =>
      replacementWithInitialCase(
        match,
        "сравнение с ценами других поставщиков",
      ),
    )
    .replace(
      /\bminPricePerKg\b/giu,
      "цена, от которой завод зарабатывает на заказе",
    );
}

function modelLabel(value) {
  const key = textValue(value);
  return MODEL_LABELS[key] ?? key;
}

function inventoryActorLabel(value) {
  const key = textValue(value);
  return INVENTORY_ACTOR_LABELS[key] ?? key;
}

function orderNumber(id) {
  let hash = 0;
  for (const character of textValue(id)) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `№${String(1000 + (hash % 9000))}`;
}

function cardStatus(value) {
  const key = textValue(value);
  return (
    ORDER_STATUS_LABELS[key] ?? (key || "Состояние уточняется")
  );
}

function emptyRecord() {
  return Object.fromEntries(LEDGER_CSV_HEADERS.map((header) => [header, ""]));
}

function csvCell(value) {
  let text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : String(value);
  if (
    /^[\s\u00a0\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*[=+\-@]/u.test(
      text,
    )
  ) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function csvLine(values) {
  return values.map(csvCell).join(",");
}

function timestampMillis(value) {
  const text = textValue(value);
  const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  const parsed = Date.parse(sqliteUtc);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ledgerDateTime(value) {
  const millis = timestampMillis(value);
  if (!millis) return textValue(value);
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(millis);
  const byType = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${byType.day}.${byType.month}.${byType.year} · ${byType.hour}:${byType.minute}:${byType.second}`;
}

function routeLabel(value) {
  const key = textValue(value);
  return ROUTE_LABELS[key] ?? "";
}

function eventPresentation(stage, company) {
  const presentation = EVENT_STAGE_PRESENTATIONS[stage] ?? {
    recordType: "Событие агента",
    sender: "Агент отдела продаж",
    recipient: "Карточка заказа",
  };
  if (stage === "customer-reply") {
    return {
      ...presentation,
      sender: company || presentation.sender,
    };
  }
  if (stage === "sent" || stage === "clarification-sent") {
    return {
      ...presentation,
      recipient: company || presentation.recipient,
    };
  }
  return presentation;
}

/** @param {LedgerOrderRow} order */
function orderRecords(order, includeCurrentResult = true) {
  const status = cardStatus(order.status);
  const company = textValue(order.company);
  const card = textValue(order.id);
  const cardNumber = orderNumber(card);
  const records = [];
  const incoming = {
    ...emptyRecord(),
    "Тип записи": "Входящее письмо",
    "Состояние записи": "Клиент отправил письмо",
    "Состояние карточки": status,
    "Дата и время": textValue(order.createdAt),
    "Номер записи": `${cardNumber} · входящее письмо`,
    Заявка: cardNumber,
    "Этап переписки №": 1,
    Компания: company,
    Отправитель: company || "Клиент",
    Получатель: "Отдел продаж",
    "Тема письма": textValue(order.subject),
    "Полный текст": textValue(order.body),
    Вложение: (() => {
      const attachment =
        objectValue(order.attachment) ?? storedObject(order.attachmentJson);
      if (!attachment) return "";
      return [textValue(attachment.name), textValue(attachment.src)]
        .filter(Boolean)
        .join(" · ");
    })(),
    "Решение агента": routeLabel(order.zone),
    "Внутренний номер записи": `${cardNumber}:входящее`,
  };
  records.push({ sortAt: incoming["Дата и время"], values: incoming });

  const conversation = Array.isArray(order.conversation)
    ? order.conversation
    : storedJson(order.conversationJson);
  let conversationRound = 1;
  if (Array.isArray(conversation)) {
    conversation.forEach((message, index) => {
      const item = objectValue(message);
      if (!item) return;
      const body = textValue(item.body) || textValue(item.text);
      const subject = textValue(item.subject);
      if (!body && !subject) return;
      const customer =
        item.role === "customer" ||
        item.from === "customer" ||
        item.direction === "incoming" ||
        item.kind === "customer_reply";
      if (customer) conversationRound += 1;
      const createdAt =
        textValue(item.createdAt) ||
        textValue(item.at) ||
        textValue(order.updatedAt);
      const conversationRecord = {
        ...emptyRecord(),
        "Тип записи": customer ? "Ответ клиента" : "Письмо агента",
        "Состояние записи": customer
          ? "Клиент ответил"
          : "Стенд записал отправку",
        "Состояние карточки": status,
        "Дата и время": createdAt,
        "Номер записи": `${cardNumber} · письмо ${index + 1}`,
        Заявка: cardNumber,
        "Этап переписки №": conversationRound,
        Компания: company,
        Отправитель: customer
          ? company || "Клиент"
          : "Агент отдела продаж",
        Получатель: customer ? "Отдел продаж" : company || "Клиент",
        "Тема письма": subject,
        "Полный текст": body,
        "Время отправки": customer ? "" : createdAt,
        "Внутренний номер записи": `${cardNumber}:письмо:${index + 1}`,
      };
      records.push({
        sortAt: conversationRecord["Дата и время"],
        values: conversationRecord,
      });
    });
  }

  const result =
    objectValue(order.result) ?? storedObject(order.resultJson) ?? null;
  const reply = objectValue(result?.reply);
  const replyBody = textValue(reply?.body);
  if (includeCurrentResult && (replyBody || textValue(reply?.subject))) {
    const sentAt = textValue(order.sentAt);
    const agentEmail = {
      ...emptyRecord(),
      "Тип записи": "Письмо агента",
      "Состояние записи": sentAt
        ? "Стенд записал отправку"
        : "Агент подготовил письмо",
      "Состояние карточки": status,
      "Дата и время": sentAt || textValue(order.updatedAt),
      "Номер записи": `${cardNumber} · итоговое письмо`,
      Заявка: cardNumber,
      "Этап переписки №": Number(order.roundNo) || 1,
      Компания: company,
      Отправитель: "Агент отдела продаж",
      Получатель: company || "Клиент",
      "Тема письма": textValue(reply?.subject),
      "Полный текст": friendlyLedgerText(replyBody),
      "Время отправки": sentAt,
      "Модель для заказов": textValue(order.agentModel),
      "Модель для проверки": textValue(order.reviewerModel),
      "Решение агента": routeLabel(result?.route ?? result?.zone ?? order.zone),
      "Основание решения": textValue(result?.zoneReason),
      "Предложенные варианты": Array.isArray(result?.options)
        ? result.options
            .map((option) => {
              const item = objectValue(option);
              return textValue(item?.title);
            })
            .filter(Boolean)
            .join(" · ")
        : "",
      "Внутренний номер записи": `${cardNumber}:итоговое-письмо`,
    };
    records.push({ sortAt: agentEmail["Дата и время"], values: agentEmail });
  }

  const managerDecision = textValue(order.managerDecision);
  if (managerDecision) {
    const decidedAt =
      textValue(order.managerDecidedAt) || textValue(order.updatedAt);
    const decisionRecord = {
      ...emptyRecord(),
      "Тип записи": "Решение руководителя",
      "Состояние записи": "Руководитель принял решение",
      "Состояние карточки": status,
      "Дата и время": decidedAt,
      "Номер записи": `${cardNumber} · решение руководителя`,
      Заявка: cardNumber,
      "Этап переписки №": Number(order.roundNo) || 1,
      Компания: company,
      Отправитель: "Руководитель",
      Получатель: "Агент отдела продаж",
      "Полный текст": friendlyLedgerText(managerDecision),
      "Решение руководителя": friendlyLedgerText(managerDecision),
      "Время решения руководителя": decidedAt,
      "Решение агента": routeLabel(order.zone),
      "Внутренний номер записи": `${cardNumber}:решение-руководителя`,
    };
    records.push({
      sortAt: decisionRecord["Дата и время"],
      values: decisionRecord,
    });
  }

  return records;
}

/**
 * @param {LedgerResultHistoryRow} history
 * @param {Map<string, LedgerOrderRow>} ordersById
 */
function resultHistoryRecord(history, ordersById) {
  const options = storedJson(history.optionsJson);
  const order = ordersById.get(textValue(history.orderId));
  const card = textValue(history.orderId);
  const cardNumber = orderNumber(card);
  const values = {
    ...emptyRecord(),
    "Тип записи": "Решение агента",
    "Состояние записи": "Агент сохранил решение",
    "Состояние карточки": cardStatus(history.status),
    "Дата и время": textValue(history.createdAt),
    "Номер записи": `${cardNumber} · решение ${history.roundNo ?? 1}`,
    Заявка: cardNumber,
    "Этап переписки №": Number(history.roundNo) || 1,
    Компания: order ? textValue(order.company) : "",
    Отправитель: "Агент отдела продаж",
    Получатель: "Карточка заказа",
    "Тема письма": textValue(history.replySubject),
    "Полный текст": friendlyLedgerText(history.replyBody),
    "Название события": friendlyLedgerText(history.reason),
    "Этап агента": "Решение и письмо",
    "Модель для заказов": textValue(history.agentModel),
    "Модель для проверки": textValue(history.reviewerModel),
    "Решение агента": routeLabel(history.route || history.zone),
    "Основание решения": textValue(history.zoneReason),
    "Предложенные варианты": Array.isArray(options)
      ? options
          .map((option) => {
            const item = objectValue(option);
            if (!item) return "";
            const title = textValue(item.title) || "Вариант";
            const details = [
              textValue(item.rationale),
              textValue(item.tradeoff),
            ].filter(Boolean);
            const reply = textValue(item.reply);
            return [
              title,
              details.length ? `Основание: ${details.join(" ")}` : "",
              reply ? `Письмо клиенту:\n${reply}` : "",
            ]
              .filter(Boolean)
              .join("\n");
          })
          .filter(Boolean)
          .join("\n\n")
      : "",
    "Внутренний номер записи": `${cardNumber}:решение:${history.roundNo ?? 1}:${history.id ?? ""}`,
  };
  return { sortAt: values["Дата и время"], values };
}

/**
 * @param {LedgerEventRow} event
 * @param {Map<string, LedgerOrderRow>} ordersById
 */
function eventRecord(event, ordersById) {
  const order = ordersById.get(textValue(event.orderId));
  const createdAt = textValue(event.createdAt);
  const stage = textValue(event.stage);
  const standSend = stage === "sent" || stage === "clarification-sent";
  const card = textValue(event.orderId);
  const cardNumber = orderNumber(card);
  const company = order ? textValue(order.company) : "";
  const presentation = eventPresentation(stage, company);
  const values = {
    ...emptyRecord(),
    "Тип записи": presentation.recordType,
    "Состояние записи":
      presentation.stateLabel ??
      EVENT_STATE_LABELS[textValue(event.state)] ??
      "Система уточняет состояние",
    "Состояние карточки": "",
    "Дата и время": createdAt,
    "Номер записи": `${cardNumber} · действие ${event.id ?? ""}`,
    Заявка: cardNumber,
    "Этап переписки №": "",
    Компания: company,
    Отправитель: presentation.sender,
    Получатель: presentation.recipient,
    "Полный текст": standSend
      ? "Отправка ответа записана в журнале демонстрации"
      : friendlyLedgerText(event.detail),
    "Название события": standSend
      ? "Запись отправки"
      : friendlyLedgerText(event.title),
    "Этап агента": EVENT_STAGE_LABELS[stage] ?? "Работа агента",
    "Внутренний номер записи": `event:${event.id ?? ""}`,
  };
  return { sortAt: createdAt, values };
}

/** @param {LedgerInventoryRow} change */
function inventoryRecord(change) {
  const createdAt = textValue(change.createdAt);
  const values = {
    ...emptyRecord(),
    "Тип записи": "Изменение склада",
    "Состояние записи": "Склад показывает новый остаток",
    "Дата и время": createdAt,
    "Номер записи": `Склад · изменение ${change.revision ?? change.id ?? ""}`,
    Отправитель: "Склад",
    Получатель: "Общий журнал",
    "Полный текст": friendlyLedgerText(change.reason),
    "Название события": "Изменение остатка",
    "Код краски": textValue(change.sku),
    "Было, кг": change.beforeStockKg ?? "",
    "Стало, кг": change.afterStockKg ?? "",
    "Обновление склада №": change.revision ?? "",
    "Причина изменения склада": friendlyLedgerText(change.reason),
    "Кто изменил склад": inventoryActorLabel(change.actor),
    "Внутренний номер записи": `inventory:${change.id ?? ""}`,
  };
  return { sortAt: createdAt, values };
}

export function queryForLedgerFormat(query, format, limit) {
  return format === "csv" ? query : query.limit(limit);
}

/**
 * @param {{
 *   orders?: LedgerOrderRow[],
 *   events?: LedgerEventRow[],
 *   inventoryChanges?: LedgerInventoryRow[],
 *   resultHistory?: LedgerResultHistoryRow[],
 * }} [input]
 */
export function buildLedgerCsv({
  orders = [],
  events = [],
  inventoryChanges = [],
  resultHistory = [],
} = {}) {
  const ordersById = new Map(
    orders.map((order) => [textValue(order.id), order]),
  );
  const ordersWithHistory = new Set(
    resultHistory.map((history) => textValue(history.orderId)),
  );
  const records = [
    ...orders.flatMap((order) =>
      orderRecords(
        order,
        !ordersWithHistory.has(textValue(order.id)) || Boolean(order.sentAt),
      ),
    ),
    ...resultHistory.map((history) =>
      resultHistoryRecord(history, ordersById),
    ),
    ...events.map((event) => eventRecord(event, ordersById)),
    ...inventoryChanges.map(inventoryRecord),
  ]
    .sort(
      (left, right) =>
        timestampMillis(right.sortAt) - timestampMillis(left.sortAt),
    );
  const lines = [
    csvLine(LEDGER_CSV_HEADERS),
    ...records.map(({ values }) =>
      csvLine(
        LEDGER_CSV_HEADERS.map((header) => {
          if (
            [
              "Дата и время",
              "Время решения руководителя",
              "Время отправки",
            ].includes(header)
          ) {
            return ledgerDateTime(values[header]);
          }
          if (
            header === "Модель для заказов" ||
            header === "Модель для проверки"
          ) {
            return modelLabel(values[header]);
          }
          if (header === "Кто изменил склад") {
            return inventoryActorLabel(values[header]);
          }
          if (HUMAN_TEXT_HEADERS.has(header)) {
            return typeof values[header] === "string"
              ? friendlyLedgerText(values[header])
              : values[header];
          }
          return values[header];
        }),
      ),
    ),
  ];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
