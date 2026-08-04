import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildLedgerCsv,
  decodeStoredAgentResultForLedger,
  LEDGER_CSV_HEADERS,
  projectLedgerOrder,
  projectLedgerResultHistory,
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

test("fails closed for malformed and partial persisted results in JSON projections and CSV", () => {
  const leaked = "PARTIAL_PRIVATE_REPLY_SHOULD_NOT_ESCAPE";
  const partial = JSON.stringify({
    schemaVersion: 2,
    reply: { subject: "partial", body: leaked },
    options: [{ title: "partial option", reply: leaked }],
  });
  const order = {
    id: "malformed-order",
    subject: "Исходное письмо администратора",
    body: "Текст доступен только admin",
    status: "processing",
    resultJson: partial,
    conversationJson: "[]",
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
  };
  const history = {
    id: 1,
    orderId: order.id,
    roundNo: 1,
    zone: "red",
    route: "manager",
    status: "awaiting_approval",
    reason: "Решение рабочей модели",
    replySubject: leaked,
    replyBody: leaked,
    zoneReason: leaked,
    optionsJson: JSON.stringify([{ reply: leaked }]),
    resultJson: partial,
    createdAt: "2026-07-29T10:01:00.000Z",
  };

  const projectedOrder = projectLedgerOrder(order);
  const projectedHistory = projectLedgerResultHistory(history);
  assert.equal(
    decodeStoredAgentResultForLedger('{"schemaVersion":2,"reply":{'),
    null,
  );
  assert.doesNotMatch(
    JSON.stringify(projectedOrder.result),
    new RegExp(leaked, "u"),
  );
  assert.doesNotMatch(
    JSON.stringify(projectedHistory),
    new RegExp(leaked, "u"),
  );

  const csv = buildLedgerCsv({
    orders: [order],
    resultHistory: [history],
  });
  assert.doesNotMatch(csv, new RegExp(leaked, "u"));
});

test("projects legacy stored results into the v2 ledger contract without turning missing into ambiguity", () => {
  const legacy = JSON.stringify({
    zone: "yellow",
    decision: "clarify",
    route: "needs_info",
    understood: ["Клиент приложил фотографию"],
    missing: ["Что требуется покрасить"],
    product: null,
    options: [],
    reply: { subject: "Нужна деталь", body: "Уточним сохранённую заявку." },
  });
  const order = {
    id: "legacy-order",
    subject: "Старая заявка",
    body: "Старый текст",
    status: "clarification_ready",
    resultJson: legacy,
    conversationJson: "[]",
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
  };
  const history = {
    id: 1,
    orderId: order.id,
    roundNo: 1,
    zone: "yellow",
    route: "needs_info",
    status: "clarification_ready",
    reason: "Старое решение",
    resultJson: legacy,
    replySubject: "",
    replyBody: "",
    zoneReason: "",
    optionsJson: "[]",
    createdAt: "2026-07-29T10:01:00.000Z",
  };

  const projectedOrder = projectLedgerOrder(order);
  const projectedHistory = projectLedgerResultHistory(history);

  for (const projected of [projectedOrder.result, projectedHistory.result]) {
    assert.equal(projected.schemaVersion, 2);
    assert.ok(projected.resolvedIntent);
    assert.equal(projected.resolvedIntent.blocker, null);
  }
  assert.deepEqual(projectedOrder.result.legacyBlocker, {
    kind: "legacy_missing",
    questions: ["Что требуется покрасить"],
  });
  assert.equal(projectedHistory.replySubject, "Нужна деталь");
  assert.equal(projectedHistory.replyBody, "Уточним сохранённую заявку.");
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
  assert.equal(incoming["Состояние записи"], "Клиент отправил письмо");
  assert.equal(
    incoming["Состояние заказа"],
    "Агент подготовил ответ · следующий шаг — резерв товара",
  );
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
  assert.equal(agentEmail["Состояние записи"], "Агент подготовил письмо");
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
  assert.equal(sentQuestion["Состояние записи"], "Система записала отправку");
  assert.equal(sentQuestion["Этап переписки №"], "1");
  assert.equal(sentQuestion["Время отправки"], "29.07.2026 · 12:01:00");
  assert.equal(customerReply["Полный текст"], customerText);
  assert.equal(customerReply["Состояние записи"], "Клиент ответил");
  assert.equal(customerReply["Этап переписки №"], "2");
  assert.equal(
    managerDecision["Решение руководителя"],
    "Разделить поставку на две партии",
  );
  assert.equal(
    managerDecision["Состояние записи"],
    "Руководитель принял решение",
  );
  assert.equal(
    managerDecision["Время решения руководителя"],
    "29.07.2026 · 12:05:00",
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

  assert.equal(agentEvent["Состояние записи"], "Система завершила шаг");
  assert.equal(agentEvent["Тип записи"], "Проверка ответа");
  assert.equal(agentEvent["Отправитель"], "Программа проверки");
  assert.equal(agentEvent["Этап агента"], "Проверка ответа");
  assert.equal(agentEvent["Название события"], "Ответ проверен");
  assert.equal(agentEvent["Полный текст"], "Цена и наличие подтверждены.");
  assert.equal(
    stockChange["Состояние записи"],
    "Склад показывает новый остаток",
  );
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

test("labels recorded sends without claiming external email delivery", () => {
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
    (row) => row["Тип записи"] === "Запись отправки",
  );

  assert.equal(incoming["Состояние заказа"], "Система записала отправку");
  assert.equal(agentEmail["Состояние записи"], "Система записала отправку");
  assert.equal(sentEvent["Этап агента"], "Запись отправки");
  assert.equal(sentEvent["Отправитель"], "Агент отдела продаж");
  assert.equal(sentEvent["Название события"], "Запись отправки");
  assert.equal(
    sentEvent["Полный текст"],
    "Отправка ответа записана в журнале демонстрации",
  );
  assert.doesNotMatch(csv, /(?:отправ|достав)\p{L}*\s+клиент\p{L}*/iu);
});

test("assigns a readable record type and sender to every known event stage", () => {
  const cases = [
    ["decision", "Решение агента", "Агент отдела продаж"],
    ["approve", "Решение руководителя", "Руководитель"],
    ["approved", "Решение руководителя", "Руководитель"],
    ["approval", "Решение руководителя", "Руководитель"],
    ["reserve", "Резерв товара", "Агент отдела продаж"],
    ["sent", "Запись отправки", "Агент отдела продаж"],
    ["clarification-sent", "Запись вопросов", "Агент отдела продаж"],
    ["customer-reply", "Ответ клиента", "Клиент"],
    ["inventory", "Проверка склада", "Агент отдела продаж"],
    ["recalculate", "Пересчёт заказа", "Программа расчёта"],
    ["market", "Сравнение цен других поставщиков", "Агент отдела продаж"],
    ["review", "Проверка ответа", "Программа проверки"],
    ["review-skipped", "Безопасное завершение", "Программа проверки"],
    ["understanding", "Анализ заявки", "Агент отдела продаж"],
    ["received", "Приём заявки", "Система"],
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

test("rewrites old internal phrases into clear ledger copy", () => {
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "legacy-copy",
        company: "ООО «Радуга»",
        subject: "Заказ",
        body: "Нужно 100 кг краски.",
        status: "reserved",
        resultJson: null,
        conversationJson: "[]",
        roundNo: 1,
        createdAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T10:04:00.000Z",
      },
    ],
    events: [
      {
        id: 31,
        orderId: "legacy-copy",
        stage: "approval",
        title: "Вариант руководителя согласован",
        detail:
          "Цена 296 ₽/кг выше нижней выгодной границы 278 ₽/кг — заказ приносит прибыль.",
        state: "done",
        createdAt: "2026-07-29T10:03:00.000Z",
      },
      {
        id: 32,
        orderId: "legacy-copy",
        stage: "partner-stock",
        title: "Агент нашёл, где собрать полный объём",
        detail: "Учебный источник проверен перед подготовкой вариантов.",
        state: "done",
        createdAt: "2026-07-29T10:03:30.000Z",
      },
    ],
    inventoryChanges: [
      {
        id: 9,
        sku: "КР-005",
        revision: 2,
        beforeStockKg: 180,
        afterStockKg: 40,
        reason: "40 кг осталось после резервов",
        actor: "Ведущий",
        createdAt: "2026-07-29T10:02:00.000Z",
      },
    ],
  });
  const rows = parseCsv(csv);
  const incoming = rows.find(
    (row) => row["Тип записи"] === "Входящее письмо",
  );
  const approval = rows.find(
    (row) =>
      row["Название события"] ===
      "Руководитель подтвердил выбранный вариант",
  );
  const stockChange = rows.find(
    (row) => row["Тип записи"] === "Изменение склада",
  );
  const supplier = rows.find(
    (row) =>
      row["Тип записи"] === "Проверка наличия у другого поставщика",
  );

  assert.equal(
    incoming["Состояние заказа"],
    "Агент подготовил резерв товара",
  );
  assert.equal(
    approval["Полный текст"],
    "Цена 296 ₽/кг. Завод зарабатывает при цене от 278 ₽/кг.",
  );
  assert.equal(
    stockChange["Причина изменения склада"],
    "40 кг осталось после других заказов",
  );
  assert.equal(
    supplier["Полный текст"],
    "Данные из таблицы поставщиков сверены перед подготовкой вариантов.",
  );
  assert.doesNotMatch(
    csv,
    /согласован|после резервов|выгодной границы|учебный источник/iu,
  );
});

test("exports Google-safe dates and readable model names", () => {
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "model-labels",
        company: "Посёлок «Сосны»",
        subject: "Заказ",
        body: "Нужно 100 кг краски.",
        status: "sent",
        zone: "green",
        resultJson: JSON.stringify({
          zone: "green",
          route: "ready",
          zoneReason: "Краска, объём и цена подтверждены.",
          options: [],
          reply: {
            subject: "Предложение",
            body: "Готовы поставить 100 кг.",
          },
        }),
        conversationJson: "[]",
        roundNo: 1,
        agentModel: "opencode/deepseek-v4-flash",
        reviewerModel: "opencode-go/deepseek-v4-pro",
        sentAt: "2026-07-29T21:26:42.260Z",
        createdAt: "2026-07-29T21:18:13.000Z",
        updatedAt: "2026-07-29T21:26:42.260Z",
      },
    ],
    resultHistory: [
      {
        id: 41,
        orderId: "model-labels",
        roundNo: 1,
        zone: "green",
        route: "ready",
        status: "ready_to_send",
        reason: "Решение рабочей модели",
        replySubject: "Предложение",
        replyBody: "Готовы поставить 100 кг.",
        zoneReason: "Краска, объём и цена подтверждены.",
        optionsJson: "[]",
        agentModel: "opencode-go/deepseek-v4-pro",
        reviewerModel: "opencode-go/deepseek-v4-pro",
        createdAt: "2026-07-29T21:25:24.000Z",
      },
    ],
  });
  const rows = parseCsv(csv);
  const finalLetter = rows.find(
    (row) => row["Внутренний номер записи"].endsWith(":итоговое-письмо"),
  );
  const savedDecision = rows.find(
    (row) => row["Внутренний номер записи"].includes(":решение:"),
  );

  assert.equal(finalLetter["Дата и время"], "30.07.2026 · 00:26:42");
  assert.equal(finalLetter["Время отправки"], "30.07.2026 · 00:26:42");
  assert.equal(finalLetter["Модель для заказов"], "DeepSeek V4 Flash");
  assert.equal(finalLetter["Модель для проверки"], "DeepSeek V4 Pro");
  assert.equal(savedDecision["Дата и время"], "30.07.2026 · 00:25:24");
  assert.equal(savedDecision["Модель для заказов"], "DeepSeek V4 Pro");
  assert.equal(savedDecision["Модель для проверки"], "DeepSeek V4 Pro");
  assert.equal(
    savedDecision["Состояние записи"],
    "Агент сохранил решение",
  );
  assert.doesNotMatch(csv, /\b46233[,.]\d+\b/u);
  assert.doesNotMatch(csv, /opencode(?:-go)?\//u);
});

test("humanizes every user and model text field and names stock writers", () => {
  const rawText =
    "Цена 349 ₽/кг в пределах minPricePerKg 332 ₽/кг — нарушений нет. Вариант split не обещает отгрузку сверх остатка. Снимок склада и рыночная позиция.";
  const expectedText =
    "Цена 349 ₽/кг. Завод зарабатывает при цене от 332 ₽/кг. Поставка двумя партиями опирается на подтверждённый остаток. Остаток на момент расчёта и сравнение с ценами других поставщиков.";
  const csv = buildLedgerCsv({
    orders: [
      {
        id: "friendly-fields",
        company: "Учебный заказчик",
        subject: "route ready",
        body: rawText,
        status: "ready_to_send",
        zone: "green",
        resultJson: JSON.stringify({
          zone: "green",
          route: "ready",
          zoneReason:
            "Снимок склада подтверждает рыночную позицию предложения.",
          options: [
            {
              title: "Вариант split",
              rationale: "Без нарушений",
              tradeoff: "route needs_info",
              reply: "Снимок склада сохранён.",
            },
          ],
          reply: {
            subject: "route manager",
            body: rawText,
          },
        }),
        conversationJson: JSON.stringify([
          {
            role: "agent",
            subject: "route ready",
            body: "Формат split. Нарушение передано руководителю.",
            createdAt: "2026-07-29T10:01:00.000Z",
          },
        ]),
        roundNo: 1,
        createdAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T10:02:00.000Z",
      },
    ],
    events: [
      {
        id: 51,
        orderId: "friendly-fields",
        stage: "decision",
        title: "route manager",
        detail: rawText,
        state: "done",
        createdAt: "2026-07-29T10:03:00.000Z",
      },
    ],
    inventoryChanges: [
      {
        id: 52,
        sku: "КР-005",
        revision: 2,
        beforeStockKg: 40,
        afterStockKg: 180,
        reason: "Снимок склада обновлён",
        actor: "admin",
        createdAt: "2026-07-29T10:04:00.000Z",
      },
      {
        id: 53,
        sku: "КР-005",
        revision: 3,
        beforeStockKg: 180,
        afterStockKg: 200,
        reason: "Рыночная позиция учтена",
        actor: "sheets-sync",
        createdAt: "2026-07-29T10:05:00.000Z",
      },
    ],
  });
  const rows = parseCsv(csv);
  const incoming = rows.find(
    (row) => row["Тип записи"] === "Входящее письмо",
  );
  const finalLetter = rows.find(
    (row) => row["Внутренний номер записи"].endsWith(":итоговое-письмо"),
  );
  const conversation = rows.find(
    (row) => row["Внутренний номер записи"].includes(":письмо:"),
  );
  const event = rows.find(
    (row) => row["Внутренний номер записи"] === "event:51",
  );
  const stockRows = rows.filter(
    (row) => row["Тип записи"] === "Изменение склада",
  );

  assert.equal(incoming["Тема письма"], "ответ готов");
  assert.equal(incoming["Полный текст"], expectedText);
  assert.equal(finalLetter["Тема письма"], "решает руководитель");
  assert.equal(finalLetter["Полный текст"], expectedText);
  assert.equal(
    finalLetter["Основание решения"],
    "Остаток на момент расчёта подтверждает сравнение с ценами других поставщиков предложения.",
  );
  assert.equal(conversation["Тема письма"], "ответ готов");
  assert.equal(
    conversation["Полный текст"],
    "Поставка двумя партиями. Особое условие передано руководителю.",
  );
  assert.equal(event["Название события"], "решает руководитель");
  assert.equal(event["Полный текст"], expectedText);
  assert.deepEqual(
    new Set(stockRows.map((row) => row["Кто изменил склад"])),
    new Set(["Администратор", "Таблица склада"]),
  );
  assert.ok(
    stockRows.some(
      (row) =>
        row["Причина изменения склада"] ===
        "Остаток на момент расчёта обновлён",
    ),
  );
  assert.ok(
    stockRows.some(
      (row) =>
        row["Причина изменения склада"] ===
        "Сравнение с ценами других поставщиков учтено",
    ),
  );
  assert.doesNotMatch(
    csv,
    /minPricePerKg|\bsplit\b|\broute\b|нарушени|снимок склада|рыночн\w*\s+позици/iu,
  );
});

test("gives every model step a specific Russian presentation", () => {
  const cases = [
    [
      "model",
      "Выбор модели",
      "Выбор модели для заявки",
      "Программа запуска моделей",
      "Агент отдела продаж",
      "Система завершила шаг",
    ],
    [
      "research",
      "Поиск сведений",
      "Поиск сведений в открытых источниках",
      "Агент отдела продаж",
      "Открытый источник",
      "Система завершила шаг",
    ],
    [
      "source-plan",
      "Выбор данных",
      "Выбор данных для решения",
      "Агент отдела продаж",
      "Страница заказа",
      "Система завершила шаг",
    ],
    [
      "research-fallback",
      "Продолжение работы",
      "Продолжение по данным заказа",
      "Программа запуска моделей",
      "Агент отдела продаж",
      "Программа продолжила обработку по данным заказа",
    ],
    [
      "primary-retry",
      "Продолжение работы",
      "Продолжение по данным заказа",
      "Программа запуска моделей",
      "Агент отдела продаж",
      "Программа продолжила обработку по данным заказа",
    ],
    [
      "research-result",
      "Результат поиска",
      "Сведения для решения собраны",
      "Агент отдела продаж",
      "Страница заказа",
      "Система завершила шаг",
    ],
    [
      "review-result",
      "Результат проверки",
      "Проверка ответа завершена",
      "Модель проверки",
      "Агент отдела продаж",
      "Система завершила шаг",
    ],
    [
      "review-fallback",
      "Передача руководителю",
      "Передача решения руководителю",
      "Программа проверки",
      "Руководитель",
      "Программа передала решение руководителю",
    ],
    [
      "review-skipped",
      "Безопасное завершение",
      "Безопасное завершение без повторной проверки",
      "Программа проверки",
      "Руководитель",
      "Fail-closed результат передан руководителю",
    ],
    [
      "vision",
      "Осмотр фотографии",
      "Осмотр фотографии",
      "Модель для фотографий",
      "Вложение клиента",
      "Система завершила шаг",
    ],
    [
      "vision-result",
      "Результат осмотра фотографии",
      "Признаки на фотографии собраны",
      "Модель для фотографий",
      "Агент отдела продаж",
      "Система завершила шаг",
    ],
    [
      "vision-fallback",
      "Вопросы по фотографии",
      "Подготовка вопросов по фотографии",
      "Система",
      "Агент отдела продаж",
      "Агент подготовил уточняющие вопросы",
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
      row["Состояние записи"] === "Система записала отправку",
  );

  assert.ok(sentLetter);
  assert.equal(sentLetter["Тема письма"], "Весь объём готов");
  assert.equal(
    sentLetter["Полный текст"],
    "100 кг есть на складе. Готовы зарезервировать партию.",
  );
  assert.equal(sentLetter["Время отправки"], "29.07.2026 · 14:08:00");
  assert.equal(
    sentLetter["Модель для заказов"],
    "Автоматическая обработка по правилам",
  );
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
  assert.ok((route.match(/queryForLedgerFormat\(/g) ?? []).length >= 4);
  assert.doesNotMatch(route, /MAX_CSV_ROWS_PER_SOURCE|sourceLimit/);
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
