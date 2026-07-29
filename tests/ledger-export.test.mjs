import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildLedgerCsv,
  LEDGER_CSV_HEADERS,
  queryForLedgerFormat,
} from "../lib/ledger-export.mjs";

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = csv.replace(/^\uFEFF/, "");

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted && character === '"' && source[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  return rows.slice(1).map((values) =>
    Object.fromEntries(rows[0].map((header, index) => [header, values[index]])),
  );
}

test("renames the internal-number header without changing the CSV shape", () => {
  assert.equal(LEDGER_CSV_HEADERS.length, 30);
  assert.equal(
    LEDGER_CSV_HEADERS.at(-1),
    "Внутренний номер записи",
  );
  assert.equal(LEDGER_CSV_HEADERS.includes("Служебный ID"), false);
});

test("exports the incoming request and prepared agent email as separate full-text records", () => {
  const longBody = `Первая строка\n${"Подробность ".repeat(500)}`;
  const longReply = `Добрый день!\n\n${"Готовы поставить всю партию. ".repeat(1_500)}`;
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "order-1",
        company: "ООО «Спектр»",
        subject: "Запрос покрытия",
        body: longBody,
        status: "ready_to_send",
        resultJson: JSON.stringify({
          reply: {
            subject: "Предложение по покрытию",
            body: longReply,
          },
        }),
        attachmentJson: JSON.stringify({
          name: "забор.jpg",
          src: "/api/uploads?key=customer-images/demo.jpg",
        }),
        conversationJson: "[]",
        roundNo: 1,
        managerDecision: null,
        managerDecidedAt: null,
        sentAt: null,
        createdAt: "2026-07-29T08:00:00.000Z",
        updatedAt: "2026-07-29T08:02:00.000Z",
      },
    ],
    events: [],
    inventoryChanges: [],
  });
  const rows = parseCsv(csv);
  const incoming = rows.find(
    (row) => row["Тип записи"] === "Входящее письмо",
  );
  const agentEmail = rows.find(
    (row) => row["Тип записи"] === "Письмо агента",
  );

  assert.equal(rows.length, 2);
  assert.equal(incoming["Полный текст"], longBody);
  assert.equal(incoming["Состояние записи"], "Получено");
  assert.equal(incoming["Состояние карточки"], "Готово к отправке");
  assert.match(incoming["Номер записи"], /^№\d{4} · входящее письмо$/);
  assert.match(incoming["Заявка"], /^№\d{4}$/);
  assert.equal(
    incoming["Внутренний номер записи"],
    "№1986:входящее",
  );
  assert.doesNotMatch(incoming["Внутренний номер записи"], /order-1/);
  assert.equal(Object.hasOwn(incoming, "Служебный ID"), false);
  assert.match(incoming["Вложение"], /забор\.jpg/);
  assert.equal(agentEmail["Тема письма"], "Предложение по покрытию");
  assert.equal(agentEmail["Полный текст"], longReply);
  assert.equal(agentEmail["Состояние записи"], "Подготовлено");
  assert.equal(agentEmail["Время отправки"], "");
});

test("keeps the decision and reply before and after a live stock change", () => {
  const splitLetter =
    "Добрый день!\n\n40 кг отгрузим завтра, ещё 60 кг — через пять дней.";
  const productionLetter =
    "Добрый день!\n\nДобавим 60 кг в ближайший выпуск и закрепим срок.";
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "stock-order",
        company: "Столярная мастерская",
        subject: "Краска для деревянных конструкций",
        body: "Нужны 100 кг коричневой краски для улицы.",
        status: "ready_to_send",
        resultJson: null,
        conversationJson: "[]",
        roundNo: 1,
        createdAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T10:04:00.000Z",
      },
    ],
    resultHistory: [
      {
        id: 1,
        orderId: "stock-order",
        roundNo: 1,
        zone: "red",
        route: "manager",
        status: "awaiting_approval",
        reason: "Первое решение",
        replySubject: "Варианты поставки",
        replyBody: "40 кг сейчас, остаток после выпуска.",
        zoneReason: "На складе 40 кг.",
        optionsJson: JSON.stringify([
          {
            id: "split",
            title: "Разделить поставку",
            rationale: "Первая партия уже на складе.",
            tradeoff: "Вторую партию клиент получит через пять дней.",
            reply: splitLetter,
          },
          {
            id: "production",
            title: "Добавить в ближайший выпуск",
            rationale: "Производство готово принять объём.",
            tradeoff: "Руководитель закрепит срок.",
            reply: productionLetter,
          },
        ]),
        createdAt: "2026-07-29T10:01:00.000Z",
      },
      {
        id: 2,
        orderId: "stock-order",
        roundNo: 1,
        zone: "green",
        route: "ready",
        status: "ready_to_send",
        reason: "Склад перечитан",
        replySubject: "Весь объём готов",
        replyBody: "100 кг есть на складе.",
        zoneReason: "На складе 180 кг.",
        optionsJson: "[]",
        createdAt: "2026-07-29T10:04:00.000Z",
      },
    ],
  });
  const rows = parseCsv(csv).filter(
    (row) => row["Тип записи"] === "Решение агента",
  );

  assert.equal(rows.length, 2);
  assert.deepEqual(
    new Set(rows.map((row) => row["Решение агента"])),
    new Set(["Решает руководитель", "Готов ответить"]),
  );
  assert.ok(rows.some((row) => row["Полный текст"].includes("40 кг")));
  assert.ok(rows.some((row) => row["Полный текст"].includes("100 кг")));
  assert.ok(rows.every((row) => row["Компания"] === "Столярная мастерская"));
  const beforeStockChange = rows.find(
    (row) => row["Решение агента"] === "Решает руководитель",
  );
  assert.ok(beforeStockChange);
  assert.equal(
    beforeStockChange["Предложенные варианты"],
    [
      "Разделить поставку",
      "Основание: Первая партия уже на складе. Вторую партию клиент получит через пять дней.",
      `Письмо клиенту:\n${splitLetter}`,
      "",
      "Добавить в ближайший выпуск",
      "Основание: Производство готово принять объём. Руководитель закрепит срок.",
      `Письмо клиенту:\n${productionLetter}`,
    ].join("\n"),
  );
});

test("keeps every conversation message and manager decision on its own timed row", () => {
  const customerText = `Окрашиваем металл на улице.\n${"Дополнительные условия. ".repeat(500)}`;
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "order-2",
        company: "Завод «Маяк»",
        subject: "Нужна краска",
        body: "Подберите покрытие.",
        status: "ready_to_send",
        resultJson: null,
        conversationJson: JSON.stringify([
          {
            role: "agent",
            body: "Уточните условия эксплуатации.",
            createdAt: "2026-07-29T09:01:00.000Z",
          },
          {
            role: "customer",
            body: customerText,
            createdAt: "2026-07-29T09:03:00.000Z",
          },
        ]),
        roundNo: 2,
        managerDecision: "Разделить поставку на две партии",
        managerOptionId: "split",
        managerDecidedAt: "2026-07-29T09:05:00.000Z",
        sentAt: null,
        createdAt: "2026-07-29T09:00:00.000Z",
        updatedAt: "2026-07-29T09:05:00.000Z",
      },
    ],
  });
  const rows = parseCsv(csv);
  const sentQuestion = rows.find(
    (row) =>
      row["Тип записи"] === "Письмо агента" &&
      row["Полный текст"] === "Уточните условия эксплуатации.",
  );
  const customerReply = rows.find(
    (row) => row["Тип записи"] === "Ответ клиента",
  );
  const managerDecision = rows.find(
    (row) => row["Тип записи"] === "Решение руководителя",
  );

  assert.equal(rows.length, 4);
  assert.equal(sentQuestion["Состояние записи"], "Отправлено на стенде");
  assert.equal(sentQuestion["Этап переписки №"], "1");
  assert.equal(sentQuestion["Время отправки"], "29.07.2026 12:01:00");
  assert.equal(customerReply["Полный текст"], customerText);
  assert.equal(customerReply["Состояние записи"], "Получено");
  assert.equal(customerReply["Этап переписки №"], "2");
  assert.equal(
    managerDecision["Решение руководителя"],
    "Разделить поставку на две партии",
  );
  assert.equal(
    managerDecision["Время решения руководителя"],
    "29.07.2026 12:05:00",
  );
});

test("uses readable agent and warehouse rows and keeps stock revision warehouse-only", () => {
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "order-3",
        company: "ООО «Радуга»",
        subject: "Заказ",
        body: "Нужно 200 кг.",
        status: "processing",
        resultJson: null,
        conversationJson: "[]",
        roundNo: 1,
        createdAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T10:00:00.000Z",
      },
    ],
    events: [
      {
        id: 17,
        orderId: "order-3",
        stage: "review",
        title: "Ответ проверен",
        detail: "Цена и наличие подтверждены.",
        state: "done",
        createdAt: "2026-07-29T10:02:00.000Z",
      },
    ],
    inventoryChanges: [
      {
        id: 8,
        sku: "КР-001",
        revision: 12,
        beforeStockKg: 300,
        afterStockKg: 520,
        reason: "Поступление партии",
        actor: "Начальник склада",
        createdAt: "2026-07-29T10:03:00.000Z",
      },
    ],
  });
  const rows = parseCsv(csv);
  const agentEvent = rows.find(
    (row) => row["Название события"] === "Ответ проверен",
  );
  const stockChange = rows.find(
    (row) => row["Тип записи"] === "Изменение склада",
  );

  assert.equal(agentEvent["Состояние записи"], "Завершено");
  assert.equal(agentEvent["Тип записи"], "Проверка ответа");
  assert.equal(agentEvent["Отправитель"], "Программа проверки");
  assert.equal(agentEvent["Этап агента"], "Проверка ответа");
  assert.equal(agentEvent["Название события"], "Ответ проверен");
  assert.equal(agentEvent["Полный текст"], "Цена и наличие подтверждены.");
  assert.equal(stockChange["Состояние записи"], "Остаток изменён");
  assert.equal(stockChange["Код краски"], "КР-001");
  assert.equal(stockChange["Было, кг"], "300");
  assert.equal(stockChange["Стало, кг"], "520");
  assert.equal(stockChange["Обновление склада №"], "12");
  assert.equal(stockChange["Причина изменения склада"], "Поступление партии");
  assert.equal(stockChange["Кто изменил склад"], "Начальник склада");
  assert.ok(
    rows
      .filter((row) => row["Тип записи"] !== "Изменение склада")
      .every((row) => row["Обновление склада №"] === ""),
  );
});

test("labels the saved company context as a separate agent step", () => {
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "company-order",
        company: "Тракторный завод",
        subject: "Пробная партия",
        body: "Нужны 40 кг краски.",
        status: "ready_to_send",
        conversationJson: "[]",
        createdAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T10:02:00.000Z",
      },
    ],
    events: [
      {
        id: 19,
        orderId: "company-order",
        stage: "company-context",
        title: "Сведения о компании учтены",
        detail: "Факты, ссылки и даты сохранены в карточке.",
        state: "done",
        createdAt: "2026-07-29T10:01:00.000Z",
      },
    ],
  });
  const row = parseCsv(csv).find(
    (item) => item["Название события"] === "Сведения о компании учтены",
  );

  assert.ok(row);
  assert.equal(row["Этап агента"], "Сведения о компании");
  assert.equal(
    row["Полный текст"],
    "Факты, ссылки и даты сохранены в карточке.",
  );
});

test("labels sent cards and sent events as stand-only actions", () => {
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "sent-order",
        company: "ООО «Спектр»",
        subject: "Заказ",
        body: "Нужно покрытие.",
        status: "sent",
        resultJson: JSON.stringify({
          reply: { subject: "Предложение", body: "Готовый ответ." },
        }),
        conversationJson: "[]",
        sentAt: "2026-07-29T10:05:00.000Z",
        createdAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T10:05:00.000Z",
      },
    ],
    events: [
      {
        id: 18,
        orderId: "sent-order",
        stage: "sent",
        title: "Ответ отправлен клиенту",
        detail: "Настоящее письмо доставлено клиенту.",
        state: "done",
        createdAt: "2026-07-29T10:05:00.000Z",
      },
    ],
  });
  const rows = parseCsv(csv);
  const incoming = rows.find(
    (row) => row["Тип записи"] === "Входящее письмо",
  );
  const agentEmail = rows.find(
    (row) => row["Тип записи"] === "Письмо агента",
  );
  const sentEvent = rows.find(
    (row) => row["Тип записи"] === "Отправка на стенде",
  );

  assert.equal(incoming["Состояние карточки"], "Отправка записана на стенде");
  assert.equal(agentEmail["Состояние записи"], "Отправлено на стенде");
  assert.equal(sentEvent["Этап агента"], "Отправка на стенде");
  assert.equal(sentEvent["Отправитель"], "Агент отдела продаж");
  assert.equal(sentEvent["Название события"], "Отправка на стенде");
  assert.equal(sentEvent["Полный текст"], "Отправка записана на стенде");
  assert.doesNotMatch(csv, /(?:отправ|достав)\p{L}*\s+клиент\p{L}*/iu);
});

test("assigns a readable record type and sender to every known event stage", () => {
  const cases = [
    ["decision", "Решение агента", "Агент отдела продаж"],
    ["approve", "Решение руководителя", "Руководитель"],
    ["approved", "Решение руководителя", "Руководитель"],
    ["approval", "Решение руководителя", "Руководитель"],
    ["sent", "Отправка на стенде", "Агент отдела продаж"],
    ["clarification-sent", "Отправка на стенде", "Агент отдела продаж"],
    ["customer-reply", "Ответ клиента", "Клиент"],
    ["inventory", "Проверка склада", "Агент отдела продаж"],
    ["recalculate", "Пересчёт заказа", "Программа расчёта"],
    ["market", "Проверка рынка", "Агент отдела продаж"],
    ["review", "Проверка ответа", "Программа проверки"],
    ["understanding", "Анализ заявки", "Агент отдела продаж"],
    ["received", "Приём заявки", "Программа стенда"],
  ];
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "event-order",
        subject: "Учебная заявка",
        body: "Нужно подобрать краску для учебного примера.",
        status: "processing",
        conversationJson: "[]",
        createdAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T10:00:00.000Z",
      },
    ],
    events: cases.map(([stage], index) => ({
      id: index + 1,
      orderId: "event-order",
      stage,
      title: `Событие ${stage}`,
      detail: `Описание ${stage}`,
      state: "done",
      createdAt: `2026-07-29T10:${String(index + 1).padStart(2, "0")}:00.000Z`,
    })),
  });
  const rows = parseCsv(csv);

  for (const [stage, recordType, sender] of cases) {
    const eventId = cases.findIndex(([candidate]) => candidate === stage) + 1;
    const row = rows.find(
      (item) => item["Внутренний номер записи"] === `event:${eventId}`,
    );
    assert.ok(row, `missing CSV row for ${stage}`);
    assert.equal(row["Тип записи"], recordType, stage);
    assert.equal(row["Отправитель"], sender, stage);
  }
});

test("gives every OpenCode step a specific Russian presentation", () => {
  const cases = [
    [
      "model",
      "Выбор модели",
      "Выбор модели для заявки",
      "OpenCode",
      "Агент отдела продаж",
      "Завершено",
    ],
    [
      "research",
      "Поиск сведений",
      "Поиск сведений в открытых источниках",
      "Агент отдела продаж",
      "Открытый источник",
      "Завершено",
    ],
    [
      "research-result",
      "Результат поиска",
      "Сведения для решения собраны",
      "Агент отдела продаж",
      "Карточка заказа",
      "Завершено",
    ],
    [
      "review-result",
      "Результат проверки",
      "Проверка сильной моделью завершена",
      "Сильная модель",
      "Агент отдела продаж",
      "Завершено",
    ],
    [
      "review-fallback",
      "Передача руководителю",
      "Передача решения руководителю",
      "Программа проверки",
      "Руководитель",
      "Передано руководителю",
    ],
    [
      "vision",
      "Осмотр фотографии",
      "Осмотр фотографии",
      "Модель для фотографий",
      "Вложение клиента",
      "Завершено",
    ],
    [
      "vision-result",
      "Результат осмотра фотографии",
      "Признаки на фотографии собраны",
      "Модель для фотографий",
      "Агент отдела продаж",
      "Завершено",
    ],
    [
      "vision-fallback",
      "Вопросы по фотографии",
      "Подготовка вопросов по фотографии",
      "Программа стенда",
      "Агент отдела продаж",
      "Продолжено с уточняющими вопросами",
    ],
  ];
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "opencode-order",
        company: "Частный покупатель",
        subject: "Фото забора",
        body: "Хочу покрасить забор.",
        status: "processing",
        conversationJson: "[]",
        createdAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T10:00:00.000Z",
      },
    ],
    events: cases.map(([stage], index) => ({
      id: index + 101,
      orderId: "opencode-order",
      stage,
      title: `Событие ${stage}`,
      detail: `Подробное описание шага ${stage}`,
      state:
        stage === "review-fallback" || stage === "vision-fallback"
          ? "error"
          : "done",
      createdAt: `2026-07-29T10:${String(index + 1).padStart(2, "0")}:00.000Z`,
    })),
  });
  const rows = parseCsv(csv);

  for (const [
    stage,
    recordType,
    stageLabel,
    sender,
    recipient,
    state,
  ] of cases) {
    const eventId =
      cases.findIndex(([candidate]) => candidate === stage) + 101;
    const row = rows.find(
      (item) => item["Внутренний номер записи"] === `event:${eventId}`,
    );
    assert.ok(row, `missing CSV row for ${stage}`);
    assert.equal(row["Тип записи"], recordType, stage);
    assert.equal(row["Этап агента"], stageLabel, stage);
    assert.equal(row["Отправитель"], sender, stage);
    assert.equal(row["Получатель"], recipient, stage);
    assert.equal(row["Состояние записи"], state, stage);
    assert.equal(
      row["Полный текст"],
      `Подробное описание шага ${stage}`,
      stage,
    );
    assert.notEqual(row["Тип записи"], "Событие агента", stage);
    assert.notEqual(row["Этап агента"], "Работа агента", stage);
  }
});

test("exports the exact sent letter with its subject, body and send time after recalculation", () => {
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "sent-after-stock",
        company: "Посёлок «Сосны»",
        subject: "Краска для деревянных конструкций",
        body: "Нужны 100 кг краски.",
        status: "sent",
        zone: "green",
        resultJson: JSON.stringify({
          zone: "green",
          route: "ready",
          zoneReason: "Весь объём подтверждён складом.",
          options: [],
          reply: {
            subject: "Весь объём готов",
            body: "100 кг есть на складе. Готовы зарезервировать партию.",
          },
        }),
        conversationJson: "[]",
        roundNo: 1,
        agentModel: "Готовая инструкция",
        reviewerModel: "Проверка программы",
        sentAt: "2026-07-29T11:08:00.000Z",
        createdAt: "2026-07-29T11:00:00.000Z",
        updatedAt: "2026-07-29T11:08:00.000Z",
      },
    ],
    resultHistory: [
      {
        id: 21,
        orderId: "sent-after-stock",
        roundNo: 1,
        zone: "red",
        route: "manager",
        status: "awaiting_approval",
        reason: "Первое решение",
        replySubject: "Варианты поставки",
        replyBody: "40 кг сейчас, остаток после выпуска.",
        zoneReason: "На складе 40 кг.",
        optionsJson: "[]",
        createdAt: "2026-07-29T11:01:00.000Z",
      },
      {
        id: 22,
        orderId: "sent-after-stock",
        roundNo: 1,
        zone: "green",
        route: "ready",
        status: "ready_to_send",
        reason: "Склад перечитан",
        replySubject: "Весь объём готов",
        replyBody: "100 кг есть на складе. Готовы зарезервировать партию.",
        zoneReason: "На складе 180 кг.",
        optionsJson: "[]",
        agentModel: "Готовая инструкция",
        reviewerModel: "Проверка программы",
        createdAt: "2026-07-29T11:06:00.000Z",
      },
    ],
  });
  const rows = parseCsv(csv);
  const sentLetter = rows.find(
    (row) =>
      row["Тип записи"] === "Письмо агента" &&
      row["Состояние записи"] === "Отправлено на стенде",
  );

  assert.ok(sentLetter);
  assert.equal(sentLetter["Тема письма"], "Весь объём готов");
  assert.equal(
    sentLetter["Полный текст"],
    "100 кг есть на складе. Готовы зарезервировать партию.",
  );
  assert.equal(sentLetter["Время отправки"], "29.07.2026 14:08:00");
  assert.equal(sentLetter["Модель для заказов"], "Готовая инструкция");
  assert.equal(sentLetter["Модель для проверки"], "Проверка программы");
  assert.ok(
    rows.some(
      (row) =>
        row["Тип записи"] === "Решение агента" &&
        row["Полный текст"].includes("40 кг"),
    ),
  );
});

test("does not apply the 100-row screen limit to a CSV export", () => {
  const query = {
    rows: Array.from({ length: 150 }, (_, index) => index + 1),
    limit(size) {
      return { ...this, rows: this.rows.slice(0, size) };
    },
  };

  assert.equal(queryForLedgerFormat(query, "json", 100).rows.length, 100);
  assert.equal(queryForLedgerFormat(query, "csv", 100).rows.length, 150);
});

test("shows today's rows on the stand while keeping the CSV as full history", async () => {
  const route = await readFile(
    new URL("../app/api/ledger/route.ts", import.meta.url),
    "utf8",
  );

  assert.ok((route.match(/format === "csv"/g) ?? []).length >= 3);
  assert.ok(
    (
      route.match(
        /date\(\$\{(?:orders|orderEvents|inventoryChanges)\.createdAt\}, '\+3 hours'\) = date\('now', '\+3 hours'\)/g,
      ) ?? []
    ).length >= 3,
  );
  assert.match(route, /format === "csv"[\s\S]*?orderBy\(desc\(orders\.createdAt\)/);
  assert.match(route, /export async function HEAD\(request: Request\)/);
  assert.match(route, /"Content-Type":[\s\S]*?"text\/csv; charset=utf-8"/);
});

test("keeps legacy URL-encoded correspondence in the full export", () => {
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "legacy-order",
        subject: "Старый запрос",
        body: "Исходное письмо",
        status: "awaiting_customer",
        resultJson: encodeURIComponent(
          JSON.stringify({
            reply: {
              subject: "Уточнение",
              body: "Подготовленный вопрос из старой записи",
            },
          }),
        ),
        conversationJson: encodeURIComponent(
          JSON.stringify([
            {
              role: "agent",
              body: "Ранее отправленный вопрос",
              createdAt: "2026-07-20T08:01:00.000Z",
            },
          ]),
        ),
        createdAt: "2026-07-20T08:00:00.000Z",
        updatedAt: "2026-07-20T08:02:00.000Z",
      },
    ],
  });
  const rows = parseCsv(csv);

  assert.ok(
    rows.some(
      (row) =>
        row["Полный текст"] === "Подготовленный вопрос из старой записи",
    ),
  );
  assert.ok(
    rows.some(
      (row) => row["Полный текст"] === "Ранее отправленный вопрос",
    ),
  );
});

test("keeps spreadsheet formula protection after renaming the internal-number column", () => {
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "formula-order",
        company: "@опасная компания",
        subject: "=IMPORTDATA(\"https://example.test\")",
        body: " +SUM(1,2)",
        status: "processing",
        conversationJson: "[]",
        createdAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T10:00:00.000Z",
      },
    ],
  });
  const [incoming] = parseCsv(csv);

  assert.equal(incoming["Компания"], "'@опасная компания");
  assert.equal(
    incoming["Тема письма"],
    "'=IMPORTDATA(\"https://example.test\")",
  );
  assert.equal(incoming["Полный текст"], "' +SUM(1,2)");
  assert.equal(
    incoming["Внутренний номер записи"],
    `${incoming["Заявка"]}:входящее`,
  );
  assert.equal(Object.hasOwn(incoming, "Служебный ID"), false);
});

test("protects formulas after line breaks and uncommon spaces", () => {
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "formula-whitespace-order",
        company: "\u00a0=HYPERLINK(\"https://example.test\")",
        subject: "\n=IMPORTDATA(\"https://example.test\")",
        body: "\ufeff@SUM(1,2)",
        status: "processing",
        conversationJson: "[]",
        createdAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T10:00:00.000Z",
      },
    ],
  });
  const [incoming] = parseCsv(csv);

  assert.ok(incoming["Компания"].startsWith("'"));
  assert.ok(incoming["Тема письма"].startsWith("'"));
  assert.ok(incoming["Полный текст"].startsWith("'"));
});
