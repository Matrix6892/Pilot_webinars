"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import demoData from "@/data/paint-demo.json";
import modelCatalog from "@/data/models.json";
import {
  scenarioGroups,
  type DemoScenario,
  type ScenarioZone,
} from "@/data/order-scenarios";
import type { AgentResult } from "@/lib/demo-engine";
import {
  asksCompatibility,
  calculatedSurfaceQuantityFromText,
  explicitSkuFromText,
  hasColor,
  hasSpecialTerms,
  hasUsableEnvironment,
  matchProduct,
  orderFactsFromText,
  quantityFromText,
} from "@/lib/order-facts.mjs";
import {
  changedProductInventory,
  resultInventorySkus,
} from "@/lib/inventory-freshness.mjs";

type Draft = DemoScenario;

type EventRow = {
  id: number;
  stage: string;
  title: string;
  detail: string;
  state: string;
  createdAt: string;
};

type Attachment = {
  name: string;
  src: string;
  alt: string;
};

type UploadResponse = {
  attachment?: Attachment;
  upload?: {
    contentType?: string;
    size?: number;
  };
  error?: string;
};

type ConversationEntry = {
  role?: string;
  from?: string;
  direction?: string;
  kind?: string;
  subject?: string;
  body?: string;
  text?: string;
  createdAt?: string;
  at?: string;
};

type InventorySnapshotItem = {
  sku: string;
  name?: string;
  stockKg: number;
  revision?: number;
  stockRevision?: number;
  updatedAt?: string;
  stockUpdatedAt?: string;
};

type InventorySnapshot = {
  version?: string | number;
  stockRevision?: string | number;
  capturedAt?: string;
  items?: InventorySnapshotItem[];
  products?: InventorySnapshotItem[];
};

type OrderRecord = {
  id: string;
  subject: string;
  body: string;
  company: string;
  website: string;
  status: string;
  zone: ScenarioZone | null;
  mode: string;
  managerDecision?: string | null;
  agentModel?: string | null;
  reviewerModel?: string | null;
  requestedModel?: string | null;
  sentAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  attachment?: Attachment | null;
  conversation?: ConversationEntry[] | null;
  roundNo?: number;
  inventorySnapshot?: InventorySnapshot | InventorySnapshotItem[] | null;
  result: AgentResult | null;
};

type InventoryItem = {
  sku: string;
  name: string;
  stockKg: number;
  revision: number;
  updatedAt: string;
};

type MarketOffer = {
  id: string;
  competitor: string;
  category: string;
  stockKg: number;
  pricePerKg: number;
  deliveryDays: number;
  stockCheckedAt?: string;
  checkedAt?: string;
  updatedAt?: string;
};

type MarketChange = {
  id: string;
  from: number;
  to: number;
};

type LedgerOrder = {
  id: string;
  company: string;
  subject: string;
  status: string;
  zone: ScenarioZone | null;
  roundNo?: number;
  createdAt: string;
  updatedAt?: string;
};

type LedgerResponse = {
  generatedAt?: string;
  orders?: LedgerOrder[];
  events?: Array<{
    id: number;
    orderId: string;
    stage: string;
    title: string;
    detail: string;
    state: string;
    createdAt: string;
  }>;
  inventoryChanges?: Array<{
    id: number;
    sku: string;
    beforeStockKg: number;
    afterStockKg: number;
    revision: number;
    reason: string;
    actor?: string;
    createdAt: string;
  }>;
  resultHistory?: Array<{
    id: number;
    orderId: string;
    roundNo: number;
    zone: ScenarioZone;
    route: "ready" | "needs_info" | "manager";
    status: string;
    reason: string;
    replySubject: string;
    createdAt: string;
  }>;
};

type ResultHistoryEntry = {
  id: number;
  orderId: string;
  roundNo: number;
  zone: ScenarioZone;
  route: "ready" | "needs_info" | "manager";
  status: string;
  reason: string;
  replySubject: string;
  replyBody: string;
  zoneReason: string;
  result?: AgentResult | null;
  inventorySnapshot?: InventorySnapshot | InventorySnapshotItem[] | null;
  createdAt: string;
};

const floorReplyPresets = [
  {
    label: "Медицинский склад",
    answer:
      "Медицинский склад. Пол бетонный. Моют каждый день нейтральным средством. По полу ездят гидравлические тележки. Для поставки нужен паспорт качества на партию.",
  },
  {
    label: "Обычный склад",
    answer:
      "Обычный сухой склад. Пол бетонный. Влажная уборка раз в неделю. По полу ездят погрузчики. Для поставки достаточно паспорта качества на партию.",
  },
  {
    label: "Другое помещение",
    answer:
      "Помещение будет мастерской. Пол бетонный. Влажная уборка раз в неделю. По полу ездят тележки. Моторное масло попадает на пол несколько раз в неделю.",
  },
] as const;

type DailyStats = {
  total: number;
  completed: number;
  awaitingApproval: number;
  awaitingCustomer: number;
  sent: number;
  zones: Record<ScenarioZone, number>;
};

type ModalName = "catalog" | "instructions" | "order" | null;

const sheetUrl =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vR7jeOl2r8s8mHvuFEkhJgG9F9kRiUknVTDG_Qt7RwX3nzj8AtVJihpdhX1kxxXCULV3d5D1xhUNBmU/pubhtml";
const publicSiteUrl = "https://koler-agent-demo.odinmaniac.chatgpt.site";
const liveStockDemoSku = "КР-005";
const floorStockDemoSku = "КР-003";
const maxPhotoSizeMb = 8;
const orderActionKeyStoragePrefix = "koler-order-key:";
const latestOrderStorageKey = "koler-latest-order";
const fenceDemoAnswer =
  "Забор деревянный, длина 25 м, высота 1,8 м. Красим с двух сторон, цвет коричневый.";
const emptyOrderDraft: Draft = {
  company: "",
  website: "",
  subject: "Заявка на подбор краски",
  body: "",
};

function answerForScenario(scenario: DemoScenario) {
  return scenario.demoKind === "fence-photo" ? fenceDemoAnswer : "";
}

const zoneCopy = {
  green: {
    name: "Готов ответить",
    color: "Зелёный",
    short: "Агент готовит письмо",
    description:
      "Товар подобран, склад подтверждает весь объём, по этой цене завод зарабатывает на заказе.",
    next: "Проверьте письмо, подготовьте резерв товара и запишите отправку.",
  },
  yellow: {
    name: "Нужны детали",
    color: "Жёлтый",
    short: "Агент задаёт точные вопросы",
    description:
      "Агент собрал известное и просит только те данные, которые меняют подбор или расчёт.",
    next: "Отправьте вопросы и продолжите ту же карточку после ответа.",
  },
  red: {
    name: "Решает руководитель",
    color: "Красный",
    short: "Агент приносит варианты",
    description:
      "Склад подтверждает часть объёма или клиент просит особую цену, оплату после поставки либо срочный срок. Агент готовит выполнимые варианты.",
    next:
      "Выберите вариант. Если нужен ответ клиента, продолжите карточку; готовое письмо пройдёт резерв и запись отправки.",
  },
} satisfies Record<
  ScenarioZone,
  {
    name: string;
    color: string;
    short: string;
    description: string;
    next: string;
  }
>;

const emptyStats: DailyStats = {
  total: 0,
  completed: 0,
  awaitingApproval: 0,
  awaitingCustomer: 0,
  sent: 0,
  zones: { green: 0, yellow: 0, red: 0 },
};

function formatMoney(value: number) {
  return new Intl.NumberFormat("ru-RU").format(value);
}

function formatEventTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(date);
}

function formatDateTime(value?: string | null) {
  if (!value) return "время сохранено в журнале";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function humanizeText(value: string) {
  return value
    .replace(
      /(\d[\d\s]*)\s*кг\s+остал(?:ось|ись)\s+после\s+резервов/giu,
      (_, quantity: string) =>
        `${quantity.trim()} кг осталось после других заказов`,
    )
    .replace(/после резервов/gi, "после других заказов")
    .replace(
      /вариант руководителя согласован/gi,
      "Руководитель подтвердил выбранный вариант",
    )
    .replace(
      /после согласования руководителя/gi,
      "после подтверждения руководителя",
    )
    .replace(
      /жд[её]т согласования руководителя/gi,
      "ждёт подтверждения руководителя",
    )
    .replace(
      /согласование руководителя/gi,
      "подтверждение руководителя",
    )
    .replace(/руководитель согласует/gi, "руководитель подтверждает")
    .replace(
      /цена\s+([\d\s]+)\s*₽\/кг\s+выше\s+(?:нижней\s+)?выгодной\s+границы\s+([\d\s]+)\s*₽\/кг\s*[—-]\s*заказ\s+приносит\s+прибыль\.?/giu,
      (_, price: string, floor: string) =>
        `Цена ${price.trim()} ₽/кг. Завод зарабатывает при цене от ${floor.trim()} ₽/кг.`,
    )
    .replace(
      /цена\s+([\d\s]+)\s*₽\/кг\s+в\s+пределах\s+minPricePerKg\s+([\d\s]+)\s*₽\/кг\s*[—-]\s*нарушени[яй]\s+нет/giu,
      (_, price: string, floor: string) =>
        `Цена ${price.trim()} ₽/кг. Завод зарабатывает при цене от ${floor.trim()} ₽/кг.`,
    )
    .replaceAll(
      "minPricePerKg",
      "цена, от которой завод зарабатывает на заказе",
    )
    .replace(
      /вариант\s+split\s+не обещает отгрузку сверх остатка/gi,
      "Поставка двумя партиями опирается на подтверждённый остаток",
    )
    .replace(/\bформат split\b/gi, "поставка двумя партиями")
    .replace(/\bsplit\b/gi, "поставка двумя партиями")
    .replace(
      /не обещает отгрузку сверх остатка/gi,
      "опирается на подтверждённый остаток",
    )
    .replace(/срез цен сопоставимых предложений/gi, "цены других поставщиков")
    .replace(/демонстрационный срез рынка/gi, "цены других поставщиков")
    .replace(
      /позиция цены понятна/gi,
      "Агент сравнил нашу цену с ценами других поставщиков",
    )
    .replace(
      /рыночн(?:ая|ой|ую)\s+позици[яию]/gi,
      "сравнение с ценами других поставщиков",
    )
    .replace(
      /средн(?:ий|его|ему) ориентир(?:а|у|ом)?/gi,
      "среднюю цену других поставщиков",
    )
    .replace(/снимок склада/gi, "остаток на момент расчёта")
    .replace(/рабочая гипотеза/gi, "предположение агента")
    .replace(/итоговый контекст/gi, "данные для решения")
    .replace(/(?<![\p{L}\p{N}_])кейс(?![\p{L}\p{N}_])/giu, "пример")
    .replace(/\bstock snapshot\b/gi, "остаток на момент расчёта")
    .replace(
      /\bmarket position\b/gi,
      "сравнение с ценами других поставщиков",
    )
    .replace(/\bdecision basis\b/gi, "основание решения")
    .replace(/\broute ready\b/gi, "ответ готов")
    .replace(/\broute manager\b/gi, "решает руководитель")
    .replace(/\bneeds_info\b/gi, "нужны детали")
    .replace(/версия склада/gi, "обновление склада")
    .replace(/склад №/gi, "обновление склада №")
    .replace(
      /(?<![\p{L}\p{N}_])маршрут(?![\p{L}\p{N}_])/giu,
      "следующий шаг",
    )
    .replace(
      /(?<![\p{L}\p{N}_])круг(?![\p{L}\p{N}_])/giu,
      "этап переписки",
    )
    .replace(/нарушени[яй]\s+нет/gi, "условия подходят")
    .replace(/без нарушений/gi, "по правилам завода")
    .replace(/нарушени[ея]/gi, "условие для решения руководителя")
    .replace(
      /минимальн(?:ая|ой|ую)\s+(?:границ[аы]|цен[аы])(?:\s+с\s+прибылью)?/gi,
      "цена, от которой завод зарабатывает на заказе",
    )
    .replace(/обнаружены пробелы/gi, "собраны вопросы клиенту")
    .replace(
      /цена сохраняет нужную прибыль/gi,
      "по этой цене завод зарабатывает на заказе",
    )
    .replace(
      /(?<![\p{L}\p{N}_])компромисс[а-яё]*/giu,
      "условия для клиента и завода",
    )
    .replace(
      /сохран[её]нн[а-яё]*\s+экономик[а-яё]*/gi,
      "заработком завода",
    )
    .replace(
      /(?<![\p{L}\p{N}_])экономик[а-яё]*/giu,
      "заработок завода",
    )
    .replace(/влияние на прибыль/gi, "заработок завода")
    .replace(
      /(?<![\p{L}\p{N}_])артикул[а-яё]*/giu,
      "код краски",
    )
    .replace(
      /(?<![\p{L}\p{N}_])прайс[а-яё]*/giu,
      "обычные цены",
    )
    .replace(/OpenCode разбирает письмо/gi, "Модель для заказов разбирает письмо")
    .replace(
      /ответ отправлен в демонстрации/gi,
      "Отправка ответа записана в журнале демонстрации",
    )
    .replace(
      /руководитель выбрал следующий ход/gi,
      "Руководитель определил, что делать дальше",
    )
    .replace(/следующий шаг:\s*/gi, "Что делать дальше: ")
    .replace(/красная зона/gi, "решает руководитель")
    .replace(/ж[её]лтая зона/gi, "нужны детали")
    .replace(/зел[её]ная зона/gi, "готов ответить");
}

function researchHypothesis(result: AgentResult) {
  const context = humanizeText(result.businessContext);
  const summary = humanizeText(result.research?.summary ?? "");
  if (!summary) return context;
  const checkedFacts = summary.split(" Агент сохранил ссылки")[0].trim();
  return checkedFacts && context.startsWith(checkedFacts)
    ? context.slice(checkedFacts.length).trim()
    : context;
}

function positiveChecks(result: AgentResult) {
  const checks = result.checks.map(humanizeText);
  if (result.route === "ready") {
    return [
      "По этой цене завод зарабатывает на заказе",
      "Весь объём подтверждён складом",
      "Письмо собрано по правилам завода",
      ...checks,
    ].filter((item, index, rows) => rows.indexOf(item) === index);
  }
  if (result.route === "needs_info") {
    return [
      result.calculation
        ? "Расход и число упаковок рассчитаны"
        : "Агент собрал вопросы для точного расчёта",
      "Карточка продолжится под тем же номером",
      ...checks,
    ].filter((item, index, rows) => rows.indexOf(item) === index);
  }
  return [
    result.product &&
    result.product.requestedKg > result.product.stockKg
      ? "Склад подтвердил доступную первую партию"
      : "Весь объём подтверждён складом",
    "Агент подготовил варианты для руководителя",
    ...checks,
  ].filter((item, index, rows) => rows.indexOf(item) === index);
}

function customerLetterForTransition(
  result: AgentResult | null | undefined,
  fallback: string,
) {
  const approvedOption =
    result?.route === "manager"
      ? result.options.find(
          (option) => option.reply.trim() === result.reply.body.trim(),
        )
      : null;
  const option =
    result?.route === "manager"
      ? approvedOption ?? result.options[0]
      : null;
  return {
    body: option?.reply || result?.reply.body || fallback,
    optionTitle: option?.title || "",
  };
}

function optionBusinessResult(
  option: AgentResult["options"][number],
  result: AgentResult,
) {
  const suppliedResult = humanizeText(option.businessResult ?? "").trim();
  if (suppliedResult) return suppliedResult;

  const key = `${option.id} ${option.title}`.toLocaleLowerCase("ru-RU");
  if (/оплата-до-отгрузки/.test(key)) {
    return "Завод получает оплату до отгрузки и зарабатывает на заказе.";
  }
  if (/оплата-за-план/.test(key)) {
    return "Завод получает план закупок и заранее готовит нужный объём.";
  }
  if (/оплата-поэтапно/.test(key)) {
    return "Завод получает часть денег до отгрузки и быстрее получает остальную оплату.";
  }
  if (/замен|alternative|аналог/.test(key)) {
    return "Завод выполняет весь заказ товаром, который уже есть на складе.";
  }
  if (/две-постав|раздел|первая партия/.test(key)) {
    return "Завод продаёт доступную партию сейчас и сохраняет заказ на остаток.";
  }
  if (/выпуск|производств|contract/.test(key)) {
    return "Завод сохраняет полный заказ и заранее планирует ближайший выпуск.";
  }
  if (/план закуп|условие-за|volume/.test(key)) {
    return "Завод получает предсказуемый объём следующих заказов.";
  }
  if (/график|что важнее|уточн|clarify/.test(key)) {
    return "Завод узнаёт главный приоритет клиента и готовит выполнимые условия.";
  }
  return result.product
    ? `Завод продаёт по цене ${formatMoney(
        result.product.pricePerKg,
      )} ₽/кг и зарабатывает на заказе.`
    : "Завод получает данные для точного и выполнимого предложения.";
}

function snapshotItems(
  snapshot?: OrderRecord["inventorySnapshot"],
): InventorySnapshotItem[] {
  if (!snapshot) return [];
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot.items)) return snapshot.items;
  if (Array.isArray(snapshot.products)) return snapshot.products;
  return [];
}

function attachmentFromOrder(order: OrderRecord) {
  return order.attachment ?? null;
}

function inferZone(draft: Draft, inventory: InventoryItem[] = []) {
  const text = `${draft.subject}\n${draft.body}`.trim();
  if (text.length < 20) {
    return {
      zone: null,
      label: "Оценка появится по мере ввода",
      reason: "Добавьте задачу клиента обычными словами.",
    } as const;
  }

  const quantity = quantityFromText(text);
  const fence = orderFactsFromText(text).fence;
  const product =
    matchProduct(text, demoData.products) ??
    (fence && fence.material !== "неясно"
      ? matchProduct(`${fence.material} забор на улице`, demoData.products)
      : null);
  const calculatedQuantity = calculatedSurfaceQuantityFromText(
    text,
    product,
    demoData.rules.calculationReservePercent,
  );
  const routeQuantity = quantity || calculatedQuantity;
  const photoNeedsPickup =
    Boolean(draft.attachment) && (!product || !routeQuantity);

  if (fence) {
    const missingFenceFacts = [
      fence.material === "неясно" ? "материал" : "",
      !fence.areaPerSideM2 ? "размеры" : "",
      !fence.sides ? "стороны покраски" : "",
      !hasColor(text) ? "цвет" : "",
    ].filter(Boolean);
    if (missingFenceFacts.length) {
      return {
        zone: "yellow",
        label: "Жёлтый · нужны детали",
        reason: `Агент уточнит ${missingFenceFacts.slice(0, 2).join(" и ")}, затем сам рассчитает количество.`,
      } as const;
    }
  } else if (photoNeedsPickup) {
    return {
      zone: "yellow",
      label: "Жёлтый · нужны детали",
      reason:
        "Фото помогает начать подбор. Агент спросит материал и размеры, затем сам рассчитает килограммы.",
    } as const;
  }

  const liveProduct = product
    ? inventory.find((item) => item.sku === product.sku)
    : null;
  const availableKg = liveProduct?.stockKg ?? product?.stockKg ?? 0;
  const hasUnknownSku = Boolean(explicitSkuFromText(text)) && !product;
  const special = hasSpecialTerms(text);

  if (special || (product && routeQuantity > availableKg)) {
    return {
      zone: "red",
      label: "Красный · решает руководитель",
      reason: special
        ? "Цена, оплата, срок или условия поставки требуют решения руководителя. Агент подготовит варианты."
        : `Склад подтверждает ${formatMoney(availableKg)} кг сейчас. Агент предложит способ поставить остальной объём.`,
    } as const;
  }

  const missing: string[] = [];
  if (!product) {
    missing.push(
      hasUnknownSku
        ? "код краски нужно сверить с каталогом"
        : "агент подберёт краску по задаче",
    );
  }
  if (!routeQuantity) missing.push("агент рассчитает или уточнит количество");
  if (!fence && !hasUsableEnvironment(text)) {
    missing.push("уточним: улица или помещение");
  }
  if (!hasColor(text)) {
    missing.push("уточним цвет");
  }
  if (asksCompatibility(text)) {
    missing.push("уточним нагрузку на покрытие");
  }

  if (missing.length) {
    return {
      zone: "yellow",
      label: "Жёлтый · нужны детали",
      reason: missing.slice(0, 2).join(" · "),
    } as const;
  }

  return {
    zone: "green",
    label: "Зелёный · готов ответить",
    reason: calculatedQuantity
      ? `Агент рассчитает ${formatMoney(calculatedQuantity)} кг по площади и проверит этот объём по складу.`
      : draft.attachment
      ? "Краска, объём, место работ и цвет уже указаны. Фотография останется в карточке."
      : "Краска, объём, место работ и цвет уже указаны.",
  } as const;
}

function modelLabel(id?: string | null) {
  if (
    id === "Готовая инструкция" ||
    id === "Расчёт по готовой инструкции"
  ) {
    return "Автоматическая обработка по правилам";
  }
  return (
    modelCatalog.options.find((model) => model.id === id)?.label ??
    (id ? "Подключённая модель" : "—")
  );
}

function usesOpenCode(mode?: string | null) {
  return Boolean(mode?.startsWith("opencode-"));
}

function orderNumber(id: string) {
  let hash = 0;
  for (const character of id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `№${String(1000 + (hash % 9000))}`;
}

function statusLabel(status: string) {
  return (
    {
      queued: "Заявка принята",
      processing: "Готовим решение",
      clarification_ready: "Вопросы готовы",
      awaiting_customer: "Ждём ответ клиента",
      awaiting_approval: "Руководитель выбирает вариант",
      ready_to_send: "Ответ готов · подготовьте резерв товара",
      reserved: "Резерв товара подготовлен · можно записать отправку",
      completed: "Ответ готов",
      sent: "Отправка ответа записана",
      error: "Можно запустить снова",
    }[status] ?? "Состояние обновлено"
  );
}

function countNoun(value: number, one: string, few: string, many: string) {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  const last = value % 10;
  if (last === 1) return one;
  return last >= 2 && last <= 4 ? few : many;
}

export function OrderStand() {
  const initialScenario = scenarioGroups[0].examples[0];
  const [draft, setDraft] = useState<Draft>(initialScenario);
  const [scenarioGroup, setScenarioGroup] = useState<ScenarioZone>("green");
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [customDraft, setCustomDraft] = useState(false);
  const [selectedModel, setSelectedModel] = useState(modelCatalog.default);
  const [orderId, setOrderId] = useState("");
  const [orderActionKey, setOrderActionKey] = useState("");
  const [order, setOrder] = useState<OrderRecord | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [orderResultHistory, setOrderResultHistory] = useState<
    ResultHistoryEntry[]
  >([]);
  const [stats, setStats] = useState<DailyStats>(emptyStats);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [market, setMarket] = useState<MarketOffer[]>([]);
  const [ledger, setLedger] = useState<LedgerResponse>({});
  const [bridgeOnline, setBridgeOnline] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState("");
  const [reserving, setReserving] = useState(false);
  const [sending, setSending] = useState(false);
  const [clarifying, setClarifying] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [supplierRefreshNeeded, setSupplierRefreshNeeded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [customerAnswer, setCustomerAnswer] = useState("");
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoMessage, setPhotoMessage] = useState("");
  const [photoError, setPhotoError] = useState("");
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [adminCode, setAdminCode] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const initialInventoryProduct =
    demoData.products.find((product) => product.sku === liveStockDemoSku) ??
    demoData.products[0];
  const [inventorySku, setInventorySku] = useState(
    initialInventoryProduct?.sku ?? "",
  );
  const [inventoryStock, setInventoryStock] = useState(
    String(initialInventoryProduct?.stockKg ?? ""),
  );
  const [inventoryReason, setInventoryReason] = useState(
    "Поступление на склад",
  );
  const [inventoryMessage, setInventoryMessage] = useState("");
  const [inventoryError, setInventoryError] = useState("");
  const [marketOfferId, setMarketOfferId] = useState("");
  const [marketStock, setMarketStock] = useState("");
  const [marketBusy, setMarketBusy] = useState(false);
  const [marketMessage, setMarketMessage] = useState("");
  const [marketError, setMarketError] = useState("");
  const [modal, setModal] = useState<ModalName>(null);
  const [error, setError] = useState("");
  const inventoryLoadedRef = useRef(false);
  const selectedMarketIdRef = useRef("");
  const lastOrderStatusRef = useRef<string | null>(null);
  const mailBodyRef = useRef<HTMLTextAreaElement>(null);
  const isComparativeStrongModel =
    selectedModel === "opencode/gpt-5.6-sol";
  const closeModal = useCallback(() => setModal(null), []);
  const orderActionHeaders = useCallback(
    () => ({
      "content-type": "application/json",
      ...(orderActionKey ? { "x-order-key": orderActionKey } : {}),
    }),
    [orderActionKey],
  );

  const loadSystem = useCallback(async () => {
    try {
      const response = await fetch("/api/orders?system=1", { cache: "no-store" });
      const data = (await response.json()) as { bridgeOnline?: boolean };
      setBridgeOnline(Boolean(data.bridgeOnline));
    } catch {
      setBridgeOnline(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const response = await fetch("/api/orders?stats=1", { cache: "no-store" });
      if (response.ok) setStats((await response.json()) as DailyStats);
    } catch {
      // The active order remains usable when the aggregate is temporarily unavailable.
    }
  }, []);

  const loadInventory = useCallback(async () => {
    try {
      const response = await fetch("/api/inventory", { cache: "no-store" });
      const data = (await response.json()) as {
        items?: InventoryItem[];
        error?: string;
      };
      if (response.ok && Array.isArray(data.items)) {
        setInventory(data.items);
        if (!inventoryLoadedRef.current) {
          const featured = data.items.find(
            (item) => item.sku === liveStockDemoSku,
          );
          if (featured) setInventoryStock(String(featured.stockKg));
          inventoryLoadedRef.current = true;
        }
      }
    } catch {
      // The current card keeps its saved warehouse snapshot.
    }
  }, []);

  const loadMarket = useCallback(async () => {
    try {
      const response = await fetch("/api/market", { cache: "no-store" });
      const data = (await response.json()) as {
        market?: MarketOffer[];
      };
      if (response.ok && Array.isArray(data.market)) {
        setMarket(data.market);
        if (
          !data.market.some(
            (offer) => offer.id === selectedMarketIdRef.current,
          )
        ) {
          const preferred =
            data.market.find(
              (offer) =>
                offer.competitor === "Индустрия Покрытий" &&
                offer.category === "краска для бетонного пола",
            ) ?? data.market[0];
          if (preferred) {
            selectedMarketIdRef.current = preferred.id;
            setMarketOfferId(preferred.id);
            setMarketStock(String(preferred.stockKg));
          }
        }
      }
    } catch {
      // The current card keeps the supplier data saved during its calculation.
    }
  }, []);

  const loadLedger = useCallback(async () => {
    try {
      const response = await fetch("/api/ledger?limit=30", {
        cache: "no-store",
      });
      if (response.ok) setLedger((await response.json()) as LedgerResponse);
    } catch {
      // The active order remains available when the shared ledger is refreshing.
    }
  }, []);

  const loadAdmin = useCallback(async () => {
    try {
      const response = await fetch("/api/admin", { cache: "no-store" });
      const data = (await response.json()) as { authenticated?: boolean };
      if (response.ok) setAdminAuthenticated(Boolean(data.authenticated));
    } catch {
      setAdminAuthenticated(false);
    }
  }, []);

  const loadOrder = useCallback(
    async (id: string) => {
      const response = await fetch(`/api/orders?id=${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = (await response.json()) as {
        order: OrderRecord;
        events: EventRow[];
        resultHistory?: ResultHistoryEntry[];
      };
      const previousStatus = lastOrderStatusRef.current;
      lastOrderStatusRef.current = data.order.status;
      setOrder(data.order);
      setEvents(data.events);
      setOrderResultHistory(data.resultHistory ?? []);

      if (
        previousStatus &&
        ["queued", "processing"].includes(previousStatus) &&
        !["queued", "processing"].includes(data.order.status)
      ) {
        void loadStats();
        void loadLedger();
      }
    },
    [loadLedger, loadStats],
  );

  const rememberOrder = useCallback((id: string) => {
    sessionStorage.setItem(latestOrderStorageKey, id);
    const url = new URL(window.location.href);
    url.searchParams.set("order", id);
    window.history.replaceState(null, "", url);
  }, []);

  useEffect(() => {
    const queryOrderId = new URLSearchParams(window.location.search)
      .get("order")
      ?.trim();
    const savedOrderId =
      queryOrderId || sessionStorage.getItem(latestOrderStorageKey)?.trim();
    if (!savedOrderId) return;

    const initial = window.setTimeout(() => {
      setOrderActionKey(
        sessionStorage.getItem(
          `${orderActionKeyStoragePrefix}${savedOrderId}`,
        ) ?? "",
      );
      setOrderId(savedOrderId);
      void loadOrder(savedOrderId);
    }, 0);
    return () => window.clearTimeout(initial);
  }, [loadOrder]);

  useEffect(() => {
    const refreshSharedState = () => {
      if (document.visibilityState !== "visible") return;
      void loadSystem();
      void loadStats();
      void loadInventory();
      void loadMarket();
      void loadLedger();
    };
    const initial = window.setTimeout(() => {
      refreshSharedState();
      void loadAdmin();
    }, 0);
    const interval = window.setInterval(refreshSharedState, 20_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [
    loadAdmin,
    loadInventory,
    loadLedger,
    loadMarket,
    loadStats,
    loadSystem,
  ]);

  useEffect(() => {
    if (!orderId) return;
    const refreshOrder = () => {
      if (document.visibilityState === "visible") void loadOrder(orderId);
    };
    const initial = window.setTimeout(refreshOrder, 0);
    const shouldPoll = ["queued", "processing"].includes(order?.status ?? "");
    const interval = shouldPoll
      ? window.setInterval(refreshOrder, 3_000)
      : undefined;
    return () => {
      window.clearTimeout(initial);
      if (interval) window.clearInterval(interval);
    };
  }, [loadOrder, order?.status, orderId]);

  const selectScenarioGroup = (zone: ScenarioZone) => {
    const group = scenarioGroups.find((item) => item.id === zone);
    if (!group) return;
    setScenarioGroup(zone);
    setScenarioIndex(0);
    setCustomDraft(false);
    setDraft(group.examples[0]);
    setCustomerAnswer(answerForScenario(group.examples[0]));
    setPhotoMessage("");
    setPhotoError("");
    setError("");
    setSupplierRefreshNeeded(false);
  };

  const focusMailBody = () => {
    window.setTimeout(() => {
      mailBodyRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      mailBodyRef.current?.focus();
    }, 0);
  };

  const startFenceExample = () => {
    selectScenarioGroup("yellow");
    focusMailBody();
  };

  const startSupplierRescueExample = () => {
    const group = scenarioGroups.find((item) => item.id === "yellow");
    const scenario = group?.examples[1];
    if (!scenario) return;
    setScenarioGroup("yellow");
    setScenarioIndex(1);
    setCustomDraft(false);
    setDraft(scenario);
    setCustomerAnswer(answerForScenario(scenario));
    setPhotoMessage("");
    setPhotoError("");
    setError("");
    setSupplierRefreshNeeded(false);
    focusMailBody();
  };

  const startCustomOrder = () => {
    setScenarioGroup("yellow");
    setScenarioIndex(0);
    setCustomDraft(true);
    setDraft(emptyOrderDraft);
    setCustomerAnswer("");
    setPhotoMessage("");
    setPhotoError("");
    setError("");
    setSupplierRefreshNeeded(false);
    focusMailBody();
  };

  const nextScenario = () => {
    const group = scenarioGroups.find((item) => item.id === scenarioGroup);
    if (!group) return;
    const next = (scenarioIndex + 1) % group.examples.length;
    setScenarioIndex(next);
    setCustomDraft(false);
    setDraft(group.examples[next]);
    setCustomerAnswer(answerForScenario(group.examples[next]));
    setPhotoMessage("");
    setPhotoError("");
    setError("");
    setSupplierRefreshNeeded(false);
  };

  const uploadPhoto = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    setPhotoMessage("");
    setPhotoError("");

    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setPhotoError("Выберите фотографию в формате JPEG, PNG или WebP.");
      return;
    }
    if (file.size > maxPhotoSizeMb * 1024 * 1024) {
      setPhotoError(`Фотография должна занимать до ${maxPhotoSizeMb} МБ.`);
      return;
    }

    setUploadingPhoto(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/uploads", {
        method: "POST",
        body: form,
      });
      const data = (await response.json()) as UploadResponse;
      if (!response.ok || !data.attachment) {
        throw new Error(
          data.error ?? "Выберите другую фотографию и повторите загрузку.",
        );
      }

      setDraft((current) => ({
        ...current,
        demoKind: undefined,
        attachment: data.attachment,
      }));
      setCustomerAnswer("");
      setPhotoMessage(
        `Фотография «${data.attachment.name}» добавлена к заявке.`,
      );
    } catch (uploadError) {
      setPhotoError(
        uploadError instanceof Error
          ? uploadError.message
          : "Выберите другую фотографию и повторите загрузку.",
      );
    } finally {
      setUploadingPhoto(false);
    }
  };

  const removePhoto = () => {
    setDraft((current) => ({
      ...current,
      attachment: undefined,
    }));
    setPhotoMessage("Фотография убрана из заявки.");
    setPhotoError("");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setSupplierRefreshNeeded(false);
    setOrder(null);
    setEvents([]);
    setOrderResultHistory([]);

    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draft, model: selectedModel }),
      });
      const data = (await response.json()) as {
        id?: string;
        actionKey?: string;
        error?: string;
      };
      if (!response.ok || !data.id || !data.actionKey) {
        throw new Error(
          data.error ?? "Проверьте тему и текст письма, затем повторите.",
        );
      }
      sessionStorage.setItem(
        `${orderActionKeyStoragePrefix}${data.id}`,
        data.actionKey,
      );
      rememberOrder(data.id);
      setOrderActionKey(data.actionKey);
      setOrderId(data.id);
      await loadOrder(data.id);
      await Promise.all([loadStats(), loadLedger(), loadInventory()]);
      window.setTimeout(() => {
        document
          .getElementById("agent-work")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 120);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Проверьте тему и текст письма, затем повторите.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const approve = async (optionId: string) => {
    if (!orderId) return;
    setApproving(optionId);
    setError("");
    try {
      const response = await fetch("/api/orders", {
        method: "PATCH",
        headers: orderActionHeaders(),
        body: JSON.stringify({ id: orderId, action: "approve", optionId }),
      });
      const data = (await response.json()) as {
        error?: string;
        recalculate?: boolean;
      };
      if (!response.ok) {
        if (data.recalculate) setSupplierRefreshNeeded(true);
        throw new Error(
          data.error ?? "Обновите карточку и выберите вариант снова.",
        );
      }
      setSupplierRefreshNeeded(false);
      await loadOrder(orderId);
      await Promise.all([loadStats(), loadLedger()]);
    } catch (approvalError) {
      setError(
        approvalError instanceof Error
          ? approvalError.message
          : "Обновите карточку и выберите вариант снова.",
      );
    } finally {
      setApproving("");
    }
  };

  const prepareReserve = async () => {
    if (!orderId) return;
    setReserving(true);
    setError("");
    try {
      const response = await fetch("/api/orders", {
        method: "PATCH",
        headers: orderActionHeaders(),
        body: JSON.stringify({ id: orderId, action: "reserve" }),
      });
      const data = (await response.json()) as {
        error?: string;
        recalculate?: boolean;
      };
      if (!response.ok) {
        if (data.recalculate) setSupplierRefreshNeeded(true);
        throw new Error(
          data.error ?? "Обновите карточку и подготовьте резерв товара снова.",
        );
      }
      setSupplierRefreshNeeded(false);
      await loadOrder(orderId);
      await Promise.all([loadStats(), loadLedger()]);
    } catch (reserveError) {
      setError(
        reserveError instanceof Error
          ? reserveError.message
          : "Обновите карточку и подготовьте резерв товара снова.",
      );
    } finally {
      setReserving(false);
    }
  };

  const sendReply = async () => {
    if (!orderId) return;
    setSending(true);
    setError("");
    try {
      const response = await fetch("/api/orders", {
        method: "PATCH",
        headers: orderActionHeaders(),
        body: JSON.stringify({ id: orderId, action: "send" }),
      });
      const data = (await response.json()) as {
        error?: string;
        recalculate?: boolean;
      };
      if (!response.ok) {
        if (data.recalculate) setSupplierRefreshNeeded(true);
        throw new Error(
          data.error ?? "Обновите карточку и повторите отправку на стенде.",
        );
      }
      setSupplierRefreshNeeded(false);
      await loadOrder(orderId);
      await Promise.all([loadStats(), loadLedger()]);
    } catch (sendError) {
      setError(
        sendError instanceof Error
          ? sendError.message
          : "Обновите карточку и повторите отправку на стенде.",
      );
    } finally {
      setSending(false);
    }
  };

  const sendClarification = async () => {
    if (!orderId) return;
    setClarifying(true);
    setError("");
    try {
      const response = await fetch("/api/orders", {
        method: "PATCH",
        headers: orderActionHeaders(),
        body: JSON.stringify({
          id: orderId,
          action: "send_clarification",
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(
          data.error ?? "Обновите карточку и отправьте вопросы снова.",
        );
      }
      await loadOrder(orderId);
      await Promise.all([loadStats(), loadLedger()]);
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "Обновите карточку и отправьте вопросы снова.",
      );
    } finally {
      setClarifying(false);
    }
  };

  const continueOrder = async () => {
    if (!orderId || customerAnswer.trim().length < 3) return;
    setContinuing(true);
    setError("");
    try {
      const response = await fetch("/api/orders", {
        method: "PATCH",
        headers: orderActionHeaders(),
        body: JSON.stringify({
          id: orderId,
          action: "customer_reply",
          answer: customerAnswer.trim(),
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(
          data.error ?? "Проверьте ответ клиента и продолжите карточку.",
        );
      }
      setCustomerAnswer("");
      await loadOrder(orderId);
      await Promise.all([loadStats(), loadLedger()]);
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "Проверьте ответ клиента и продолжите карточку.",
      );
    } finally {
      setContinuing(false);
    }
  };

  const requestRecalculation = async (id: string) => {
    const response = await fetch("/api/orders", {
      method: "PATCH",
      headers: orderActionHeaders(),
      body: JSON.stringify({ id, action: "recalculate" }),
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(
        data.error ?? "Обновите склад и пересчитайте карточку снова.",
      );
    }
  };

  const recalculateOrder = async () => {
    if (!orderId) return;
    setRecalculating(true);
    setError("");
    try {
      await requestRecalculation(orderId);
      setSupplierRefreshNeeded(false);
      await loadOrder(orderId);
      await Promise.all([
        loadStats(),
        loadLedger(),
        loadInventory(),
        loadMarket(),
      ]);
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "Обновите склад и пересчитайте карточку снова.",
      );
    } finally {
      setRecalculating(false);
    }
  };

  const retryOrder = async () => {
    if (!orderId || order?.status !== "error") return;
    setRetrying(true);
    setError("");
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: orderActionHeaders(),
        body: JSON.stringify({
          id: orderId,
          action: "retry",
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(
          data.error ?? "Обновите карточку и повторите запуск.",
        );
      }
      await loadOrder(orderId);
      await Promise.all([loadStats(), loadLedger()]);
    } catch (retryError) {
      setError(
        retryError instanceof Error
          ? retryError.message
          : "Обновите карточку и повторите запуск.",
      );
    } finally {
      setRetrying(false);
    }
  };

  const signInAdmin = async (event: React.FormEvent) => {
    event.preventDefault();
    setAdminBusy(true);
    setInventoryError("");
    setInventoryMessage("");
    setMarketError("");
    setMarketMessage("");
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: adminCode }),
      });
      const data = (await response.json()) as {
        authenticated?: boolean;
        error?: string;
      };
      if (!response.ok || !data.authenticated) {
        throw new Error(
          data.error ?? "Проверьте код ведущего и повторите вход.",
        );
      }
      setAdminAuthenticated(true);
      setAdminCode("");
      const selected = inventory.find((item) => item.sku === inventorySku);
      if (selected) setInventoryStock(String(selected.stockKg));
      const selectedOffer = market.find(
        (offer) => offer.id === marketOfferId,
      );
      if (selectedOffer) setMarketStock(String(selectedOffer.stockKg));
      setInventoryMessage("Пульт ведущего открыт.");
    } catch (adminError) {
      setInventoryError(
        adminError instanceof Error
          ? adminError.message
          : "Проверьте код ведущего и повторите вход.",
      );
    } finally {
      setAdminBusy(false);
    }
  };

  const signOutAdmin = async () => {
    setAdminBusy(true);
    setInventoryError("");
    setMarketError("");
    try {
      await fetch("/api/admin", { method: "DELETE" });
      setAdminAuthenticated(false);
      setInventoryMessage("Пульт ведущего закрыт.");
      setMarketMessage("");
    } finally {
      setAdminBusy(false);
    }
  };

  const selectInventoryItem = (sku: string) => {
    setInventorySku(sku);
    const item = inventory.find((candidate) => candidate.sku === sku);
    if (item) setInventoryStock(String(item.stockKg));
    setInventoryMessage("");
    setInventoryError("");
  };

  const selectMarketOffer = (id: string) => {
    selectedMarketIdRef.current = id;
    setMarketOfferId(id);
    const offer = market.find((candidate) => candidate.id === id);
    if (offer) setMarketStock(String(offer.stockKg));
    setMarketMessage("");
    setMarketError("");
  };

  const updateInventory = async (event: React.FormEvent) => {
    event.preventDefault();
    const item = inventory.find(
      (candidate) => candidate.sku === inventorySku,
    );
    const nextStock = Number(inventoryStock);
    if (!item) {
      setInventoryError("Выберите краску из живого склада.");
      return;
    }
    if (!Number.isSafeInteger(nextStock) || nextStock < 0) {
      setInventoryError("Укажите целое число килограммов от нуля.");
      return;
    }

    setAdminBusy(true);
    setInventoryError("");
    setInventoryMessage("");
    try {
      const response = await fetch("/api/inventory", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sku: item.sku,
          stockKg: nextStock,
          expectedRevision: item.revision,
          reason: inventoryReason.trim() || "Поступление на склад",
        }),
      });
      const data = (await response.json()) as {
        item?: InventoryItem;
        current?: InventoryItem;
        error?: string;
      };
      if (!response.ok || !data.item) {
        if (data.current) {
          setInventory((current) =>
            current.map((candidate) =>
              candidate.sku === data.current?.sku
                ? data.current
                : candidate,
            ),
          );
          setInventoryStock(String(data.current.stockKg));
        }
        throw new Error(
          data.error ?? "Обновите данные склада и повторите изменение.",
        );
      }

      setInventory((current) =>
        current.map((candidate) =>
          candidate.sku === data.item?.sku ? data.item : candidate,
        ),
      );
      setInventoryStock(String(data.item.stockKg));
      const activeOrderUsesPaint =
        Boolean(orderId) &&
        order?.status !== "sent" &&
        resultInventorySkus(
          order?.inventorySnapshot,
          order?.result,
          demoData.products,
        ).includes(item.sku);

      if (activeOrderUsesPaint && orderId) {
        setInventoryMessage(
          `Остаток изменился: ${formatMoney(item.stockKg)} → ${formatMoney(data.item.stockKg)} кг. Агент уже заново сверяет заказ и письмо.`,
        );
        setRecalculating(true);
        await requestRecalculation(orderId);
        await Promise.all([
          loadOrder(orderId),
          loadInventory(),
          loadLedger(),
          loadStats(),
        ]);
        setInventoryMessage(
          bridgeOnline
            ? `Остаток изменился: ${formatMoney(item.stockKg)} → ${formatMoney(data.item.stockKg)} кг. Агент пересчитывает ту же карточку; новое решение и письмо появятся здесь.`
            : `Остаток изменился: ${formatMoney(item.stockKg)} → ${formatMoney(data.item.stockKg)} кг. Новое решение и письмо сохранились в той же карточке.`,
        );
      } else {
        setInventoryMessage(
          `Остаток изменился: ${formatMoney(item.stockKg)} → ${formatMoney(data.item.stockKg)} кг. Следующий расчёт возьмёт свежие данные.`,
        );
        await Promise.all([
          loadInventory(),
          loadLedger(),
          orderId
            ? loadOrder(orderId).catch(() => undefined)
            : Promise.resolve(),
        ]);
      }
      if (orderId) {
        window.setTimeout(() => {
          const target =
            document.getElementById("decision-transition") ??
            document.getElementById("current-order-refresh") ??
            document.getElementById("agent-work");
          target?.scrollIntoView({
            behavior: "smooth",
            block: target.id === "current-order-refresh" ? "center" : "start",
          });
          if (target instanceof HTMLElement) {
            target.focus({ preventScroll: true });
          }
        }, 160);
      }
    } catch (inventoryUpdateError) {
      setInventoryError(
        inventoryUpdateError instanceof Error
          ? inventoryUpdateError.message
          : "Обновите данные склада и повторите изменение.",
      );
    } finally {
      setRecalculating(false);
      setAdminBusy(false);
    }
  };

  const updateMarket = async (event: React.FormEvent) => {
    event.preventDefault();
    const offer = market.find(
      (candidate) => candidate.id === marketOfferId,
    );
    const nextStock = Number(marketStock);
    if (!offer) {
      setMarketError("Выберите партнёра из списка.");
      return;
    }
    if (!Number.isSafeInteger(nextStock) || nextStock < 0) {
      setMarketError("Укажите целое число килограммов от нуля.");
      return;
    }

    setMarketBusy(true);
    setMarketError("");
    setMarketMessage("");
    let savedChangeText = "";
    try {
      const response = await fetch("/api/market", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: offer.id,
          stockKg: nextStock,
        }),
      });
      const data = (await response.json()) as {
        market?: MarketOffer[];
        changed?: MarketChange;
        error?: string;
      };
      if (
        !response.ok ||
        !Array.isArray(data.market) ||
        !data.changed
      ) {
        throw new Error(
          data.error ?? "Обновите данные партнёров и повторите изменение.",
        );
      }

      setMarket(data.market);
      const changedOffer =
        data.market.find((candidate) => candidate.id === data.changed?.id) ??
        offer;
      selectedMarketIdRef.current = changedOffer.id;
      setMarketOfferId(changedOffer.id);
      setMarketStock(String(changedOffer.stockKg));

      const changeText = `${humanizeText(changedOffer.competitor)}: ${formatMoney(
        data.changed.from,
      )} → ${formatMoney(data.changed.to)} кг.`;
      savedChangeText = changeText;
      const activeOrder =
        Boolean(orderId) && Boolean(order) && order?.status !== "sent";

      if (activeOrder && orderId) {
        let orderRecalculated = true;
        setMarketMessage(
          `${changeText} Агент пересобирает вариант и письмо по свежему остатку.`,
        );
        setRecalculating(true);
        setSupplierRefreshNeeded(false);
        try {
          await requestRecalculation(orderId);
        } catch (recalculationError) {
          const recalculationMessage =
            recalculationError instanceof Error
              ? recalculationError.message
              : "";
          if (!/уже рассчитана по свежим данным/iu.test(recalculationMessage)) {
            throw recalculationError;
          }
          orderRecalculated = false;
        }
        await Promise.all([
          loadOrder(orderId),
          loadLedger(),
          loadInventory(),
          loadMarket(),
          loadStats(),
        ]);
        setMarketMessage(
          !orderRecalculated
            ? `${changeText} Текущий вариант уже опирается на свежие данные; карточка сохранилась без изменений.`
            : bridgeOnline
            ? `${changeText} Агент пересчитывает ту же карточку; обновлённый вариант появится в ней.`
            : `${changeText} Обновлённый вариант и письмо сохранены в той же карточке.`,
        );
      } else {
        setMarketMessage(
          `${changeText} Следующий расчёт возьмёт свежий остаток партнёра.`,
        );
        await Promise.all([
          loadMarket(),
          loadLedger(),
          loadInventory(),
          orderId
            ? loadOrder(orderId).catch(() => undefined)
            : Promise.resolve(),
        ]);
      }

      if (orderId) {
        window.setTimeout(() => {
          const target =
            document.getElementById("manager-decision") ??
            document.getElementById("supplier-help") ??
            document.getElementById("agent-work");
          target?.scrollIntoView({ behavior: "smooth", block: "start" });
          if (target instanceof HTMLElement) {
            target.focus({ preventScroll: true });
          }
        }, 160);
      }
    } catch (marketUpdateError) {
      const detail =
        marketUpdateError instanceof Error
          ? marketUpdateError.message
          : "Обновите данные партнёров и повторите изменение.";
      setMarketError(
        savedChangeText
          ? `${savedChangeText} Остаток сохранён. ${detail}`
          : detail,
      );
      if (savedChangeText) {
        await Promise.all([
          loadMarket(),
          loadLedger(),
          orderId
            ? loadOrder(orderId).catch(() => undefined)
            : Promise.resolve(),
        ]);
      }
    } finally {
      setRecalculating(false);
      setMarketBusy(false);
    }
  };

  const openLedgerOrder = (id: string) => {
    rememberOrder(id);
    setOrderActionKey(
      sessionStorage.getItem(`${orderActionKeyStoragePrefix}${id}`) ?? "",
    );
    setOrderId(id);
    setError("");
    void loadOrder(id);
    window.setTimeout(() => {
      document
        .getElementById("agent-work")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  };

  const reset = () => {
    sessionStorage.removeItem(latestOrderStorageKey);
    const url = new URL(window.location.href);
    url.searchParams.delete("order");
    window.history.replaceState(null, "", url);
    setOrderId("");
    setOrderActionKey("");
    setOrder(null);
    setEvents([]);
    lastOrderStatusRef.current = null;
    setError("");
    document
      .getElementById("compose")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const result = order?.result;
  const currentZone = result?.zone ?? order?.zone;
  const hint = useMemo(() => inferZone(draft, inventory), [draft, inventory]);
  const progress = useMemo(() => {
    if (!orderId) return 0;
    if (order?.status === "sent") return 100;
    if (order?.status === "reserved") return 98;
    if (order?.status === "ready_to_send") return 94;
    if (order?.status === "awaiting_customer") return 72;
    if (order?.status === "clarification_ready") return 64;
    if (order?.status === "awaiting_approval") return 88;
    if (order?.status === "error") {
      return Math.min(82, 12 + events.length * 13);
    }
    return Math.min(82, 12 + events.length * 13);
  }, [events.length, order?.status, orderId]);

  return (
    <div className="site-shell">
      <a className="skip-link" href="#compose">
        К заявке
      </a>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Колер — начало">
          <span className="brand-mark" aria-hidden="true">
            К
          </span>
          <span>
            <strong>Колер</strong>
            <small>Агент отдела продаж</small>
          </span>
        </a>
        <div
          className={`connection ${bridgeOnline ? "is-live" : ""}`}
          role="status"
          aria-live="polite"
          aria-label={
            bridgeOnline
              ? "Режим: обработка моделью"
              : "Режим: обработка по правилам"
          }
        >
          <span className="connection-dot" aria-hidden="true" />
          <span aria-hidden="true">
            {bridgeOnline
              ? "Режим: обработка моделью"
              : "Режим: обработка по правилам"}
          </span>
        </div>
        <a
          className="topbar-link"
          href="#compose"
          aria-label="Создать заявку"
        >
          Создать заявку
        </a>
      </header>

      <main id="top">
        <section className="story-hero" aria-labelledby="main-title">
          <div className="hero-intro">
            <p className="eyebrow">Живой путь одного заказа</p>
            <h1 id="main-title">
              Клиент пишет своими словами. Агент ведёт заказ до письма клиенту
            </h1>
            <p className="hero-lead">
              На стенде форму отправляют в тот же рабочий путь, который в
              компании запускает входящее письмо. Агент понимает задачу,
              сверяет каталог, живой склад и предложения поставщиков, а когда
              это помогает продаже —{" "}
              {bridgeOnline
                ? "изучает открытые сведения о компании"
                : "использует подготовленные сведения о компании"}
              , готовит следующий шаг и сохраняет всю историю в общей таблице.
            </p>
          </div>

          <aside className="agent-difference">
            <span>Где начинается агентная работа</span>
            <p>
              Чат помогает подготовить текст. Здесь агент ждёт ответ клиента,
              перечитывает склад, пересчитывает план и продолжает ту же
              карточку. Заявка «Хочу покрасить этот забор» с фотографией
              превращается в точные вопросы, подбор краски, расчёт килограммов и
              проверку наличия.
            </p>
          </aside>

          <div className="system-map" aria-label="Путь заказа">
            <article>
              <span>01</span>
              <strong>Описание заказа и фото</strong>
              <small>Клиент пишет своими словами и при желании добавляет снимок</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>02</span>
              <strong>Понимание задачи</strong>
              <small>
                {bridgeOnline
                  ? "Текст и фото превращаются в факты и вопросы"
                  : "Текст превращается в факты и вопросы, фото остаётся в карточке"}
              </small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>03</span>
              <strong>Проверенные данные</strong>
              <small>Каталог, остаток и учебные цены поставщиков</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>04</span>
              <strong>Сведения о клиенте</strong>
              <small>Когда это помогает продаже: чем занимается компания</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>05</span>
              <strong>Выбор следующего действия</strong>
              <small>Ответ, один вопрос или три варианта руководителю</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>06</span>
              <strong>Выполнение</strong>
              <small>Переписка, резерв товара и запись отправки</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>07</span>
              <strong>Общая память</strong>
              <small>Карточка, журнал и таблица за день</small>
            </article>
          </div>
          <ol className="system-map-mobile" aria-label="Путь заказа">
            <li>
              <span>1</span>
              <div>
                <strong>Задача</strong>
                <small>Текст клиента и фото по желанию</small>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Подбор и проверка</strong>
                <small>Каталог, склад, поставщики и сведения о клиенте</small>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Решение</strong>
                <small>Ответ, точный вопрос или варианты руководителю</small>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <strong>Действие и история</strong>
                <small>Резерв, запись отправки и общий журнал</small>
              </div>
            </li>
          </ol>

          <div className="hero-status">
            <span>Кто ведёт заказ</span>
            <ul className="hero-roles">
              <li>
                <strong>
                  {bridgeOnline
                    ? isComparativeStrongModel
                      ? "GPT-5.6 Sol обрабатывает заказ для сравнения"
                      : "Рабочая модель ведёт каждый заказ"
                    : "Система работает по готовым правилам"}
                </strong>
                <small>
                  {bridgeOnline
                    ? isComparativeStrongModel
                      ? "Та же модель отдельно ведёт заказ и отдельно проверяет готовое решение."
                      : `${modelLabel(selectedModel)} читает письмо, выбирает источники и готовит ответ по заданным правилам.`
                    : "Стенд читает заявку, проверяет текущий склад и показывает весь путь заказа."}
                </small>
              </li>
              <li>
                <strong>
                  {bridgeOnline
                    ? "Модель для фото описывает видимое"
                    : "Фото сохраняется в карточке"}
                </strong>
                <small>
                  {bridgeOnline
                    ? "Описывает видимые детали. Материал и размеры подтверждает клиент."
                    : "Система задаёт вопросы о материале, размерах и окрашиваемых сторонах по тексту заявки."}
                </small>
              </li>
              <li>
                <strong>
                  {bridgeOnline
                    ? "Отдельная модель проверяет решение"
                    : "Правила и критерии подготовлены заранее"}
                </strong>
                <small>
                  {bridgeOnline
                    ? "По умолчанию GPT-5.6 Sol проверяет факты, числа и обещания отдельным запуском."
                    : "GPT-5.6 Sol заранее подготовила правила и критерии. Ведущий подключает модели для отдельной проверки решения."}
                </small>
              </li>
              <li>
                <strong>Программа сверяет цены и остатки</strong>
                <small>
                  Сверяет цены и остатки перед каждым обещанием клиенту.
                </small>
              </li>
              <li>
                <strong>Руководитель выбирает условия сделки</strong>
                <small>
                  Подтверждает скидку, оплату после поставки, срочную отгрузку
                  или частичную поставку.
                </small>
              </li>
            </ul>
            <details className="technical-layer">
              <summary>Как работает демонстрация</summary>
              <p>
                {bridgeOnline
                  ? "Компьютер ведущего запускает выбранную модель. Сайт хранит карточки и журнал."
                  : "Сайт обрабатывает заявки по тем же правилам и живым данным склада."}{" "}
                В рабочей системе письмо из почтового ящика создаёт заявку, а
                готовый ответ уходит с корпоративной почты.
              </p>
            </details>
          </div>

          <div className="source-dock" aria-label="Источники и правила стенда">
            <a href={sheetUrl} target="_blank" rel="noreferrer">
              <span>Общая таблица вебинара</span>
              Заказы, действия и результат дня
            </a>
            <a href="#live-inventory">
              <span>Живой склад и партнёры</span>
              Изменить остаток и сразу пересчитать заказ
            </a>
            <button type="button" onClick={() => setModal("catalog")}>
              <span>Каталог</span>
              Посмотреть товары, цены и поставщиков
            </button>
            <button type="button" onClick={() => setModal("instructions")}>
              <span>Три правила</span>
              Правила работы агента
            </button>
            <a href="#day-result">
              <span>Результат дня</span>
              Заявки, решения и отправки
            </a>
          </div>

          <details className="zone-guide" open>
            <summary>
              <span>Как агент выбирает следующий шаг</span>
              <small>Три понятных состояния заявки</small>
            </summary>
            <div className="zone-explainer">
              {(Object.keys(zoneCopy) as ScenarioZone[]).map((zone) => (
                <article className={`zone-explain zone-${zone}`} key={zone}>
                  <div>
                    <span className="zone-light" aria-hidden="true" />
                    <span className="zone-name">{zoneCopy[zone].color}</span>
                  </div>
                  <strong>{zoneCopy[zone].name}</strong>
                  <p>{zoneCopy[zone].description}</p>
                  <small>{zoneCopy[zone].next}</small>
                </article>
              ))}
            </div>
          </details>
        </section>

        <section className="demo-heading" id="compose">
          <div>
            <p className="eyebrow">Попробуйте путь руками</p>
            <h2>Опишите задачу своими словами</h2>
          </div>
          <div className="demo-heading-copy">
            <p>
              Например: «Хочу покрасить забор». Добавьте фото — агент уточнит
              материал и размеры, подберёт краску и рассчитает заказ. В рабочей
              системе карточку создаёт письмо из ящика компании.
            </p>
            <div className="demo-start-actions">
              <button type="button" onClick={startFenceExample}>
                Попробовать с фото забора
              </button>
              <button type="button" onClick={startSupplierRescueExample}>
                Показать, как агент сохраняет большой заказ
              </button>
              <button type="button" onClick={startCustomOrder}>
                Заполнить свой заказ
              </button>
            </div>
          </div>
        </section>

        <section className={`workbench ${orderId ? "has-order" : ""}`}>
          <div className="compose-column">
            <div className="section-label">
              <span>Ввод</span>
              Входящее письмо
            </div>

            <div className="preset-controls">
              <label>
                <span>Набор примеров</span>
                <select
                  value={customDraft ? "" : scenarioGroup}
                  onChange={(event) =>
                    selectScenarioGroup(event.target.value as ScenarioZone)
                  }
                >
                  <option value="" disabled>
                    Свой заказ
                  </option>
                  {scenarioGroups.map((group) => (
                    <option value={group.id} key={group.id}>
                      {group.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={nextScenario}>
                Другой пример
                <small>{scenarioIndex + 1} из 10</small>
              </button>
            </div>

            <form className="mail-card" onSubmit={submit}>
              <div className="mail-toolbar">
                <div className="window-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
                <strong>Заявка для агента</strong>
                <span>{customDraft ? "Ваш заказ" : "Готовый пример"}</span>
              </div>

              <div className="mail-line">
                <span>Кому</span>
                <strong>Отдел продаж «Колер»</strong>
              </div>
              <label className="mail-field">
                <span>Компания · по желанию</span>
                <input
                  value={draft.company}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      company: event.target.value,
                    }))
                  }
                  placeholder="Название компании"
                />
              </label>
              <label className="mail-field">
                <span>Сайт · по желанию</span>
                <input
                  value={draft.website}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      website: event.target.value,
                    }))
                  }
                  placeholder="Адрес сайта, если есть"
                />
              </label>
              <label className="mail-field">
                <span>Тема</span>
                <input
                  value={draft.subject}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      subject: event.target.value,
                    }))
                  }
                  placeholder="Заказ краски"
                  required
                />
              </label>
              <label className="mail-body">
                <span className="sr-only">Текст письма</span>
                <textarea
                  ref={mailBodyRef}
                  value={draft.body}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      body: event.target.value,
                    }))
                  }
                  placeholder="Опишите заказ обычными словами…"
                  rows={11}
                  required
                />
              </label>

              <div className="photo-upload-row">
                <div>
                  <strong>Покажите, что хотите покрасить</strong>
                  <small>
                    {bridgeOnline
                      ? "Добавьте фото забора, стены или пола. Модель для фото опишет видимые детали, агент уточнит материал, размеры, стороны покраски и желаемый цвет, подберёт краску и посчитает килограммы."
                      : "Добавьте фото забора, стены или пола. Агент сохранит его в карточке, уточнит материал, размеры, стороны покраски и желаемый цвет, подберёт краску и посчитает килограммы."}
                  </small>
                </div>
                <label className="photo-upload-button">
                  <span>
                    {uploadingPhoto
                      ? "Добавляем фотографию…"
                      : draft.attachment
                        ? "Заменить фотографию"
                        : "Добавить фотографию"}
                  </span>
                  <small>
                    До {maxPhotoSizeMb} МБ · оставьте в кадре объект и
                    поверхность
                  </small>
                  <input
                    className="sr-only"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(event) => void uploadPhoto(event)}
                    disabled={uploadingPhoto}
                  />
                </label>
              </div>

              {draft.attachment && (
                <figure className="mail-attachment">
                  <Image
                    src={draft.attachment.src}
                    alt={draft.attachment.alt}
                    width={1200}
                    height={800}
                    sizes="(max-width: 720px) 100vw, 520px"
                    priority={scenarioGroup === "yellow"}
                    unoptimized
                  />
                  <figcaption>
                    <span aria-hidden="true">↳</span>
                    <div>
                      <strong>{draft.attachment.name}</strong>
                      <small>
                        {bridgeOnline
                          ? "Модель для фото опишет видимые детали. Материал, размеры, стороны покраски и желаемый цвет подтвердит клиент."
                          : "Фото сохранится в карточке. Агент задаст вопросы о материале, размерах, сторонах покраски и желаемом цвете."}
                      </small>
                      <button
                        className="photo-remove-button"
                        type="button"
                        onClick={removePhoto}
                      >
                        Убрать фотографию
                      </button>
                    </div>
                  </figcaption>
                </figure>
              )}

              {photoMessage && (
                <div className="photo-status" role="status">
                  {photoMessage}
                </div>
              )}
              {photoError && (
                <div className="photo-status is-error" role="alert">
                  {photoError}
                </div>
              )}

              <div className="mail-model">
                {bridgeOnline ? (
                  <label>
                    <span>Модель для ежедневных заказов</span>
                    <select
                      value={selectedModel}
                      onChange={(event) => setSelectedModel(event.target.value)}
                    >
                      {modelCatalog.options.map((model) => (
                        <option value={model.id} key={model.id}>
                          {model.label} · {model.note}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div className="mail-model-status">
                    <span>Обработка заявки</span>
                    <strong>Подготовленные правила и живой склад</strong>
                  </div>
                )}
                <small>
                  {bridgeOnline
                    ? isComparativeStrongModel
                      ? "GPT-5.6 Sol ведёт заказ для сравнения. Затем отдельный запуск проверяет факты, числа и условия."
                      : `${modelLabel(selectedModel)} обрабатывает ежедневный заказ. GPT-5.6 Sol отдельно проверяет факты, числа и условия.`
                    : "Ведущий подключает ежедневную модель и отдельную проверку для демонстрации с моделями."}
                </small>
              </div>

              <div className={`zone-hint ${hint.zone ? `zone-${hint.zone}` : ""}`}>
                <span className="zone-light" aria-hidden="true" />
                <div>
                  <strong>{hint.label}</strong>
                  <small>{hint.reason}</small>
                </div>
              </div>

              <div className="public-journal-note" role="note">
                <strong>
                  {draft.attachment
                    ? "Заявка и фотография войдут в открытый журнал вебинара"
                    : "Заявка войдёт в открытый журнал вебинара"}
                </strong>
                <span>
                  Используйте учебные названия и открытые данные. Личные и
                  коммерческие сведения оставьте за пределами стенда.
                </span>
              </div>

              <div className="mail-actions">
                <button className="send-button" type="submit" disabled={submitting}>
                  <span>{submitting ? "Создаём карточку…" : "Отправить агенту"}</span>
                  <span aria-hidden="true">→</span>
                </button>
                <small>
                  Агент покажет, что делать дальше, по заявке, живому складу и
                  трём правилам продаж.
                </small>
              </div>
            </form>
          </div>

          <div className="process-column" id="agent-work">
            <div className="section-label">
              <span>Работа</span>
              Ход работы
              {orderId && (
                <button className="text-button" type="button" onClick={reset}>
                  Новый заказ
                </button>
              )}
            </div>

            {!orderId ? (
              <div className="empty-process">
                <div>
                  <p className="eyebrow">После отправки</p>
                  <h2>Здесь появится карточка заказа</h2>
                  <p>
                    Номер карточки, исходное письмо, найденные факты, решение и
                    готовый ответ останутся в одной карточке.
                  </p>
                </div>
                <ol className="process-preview">
                  <li>
                    <span aria-hidden="true">•</span>
                    <strong>Разбор письма</strong>
                    <small>Что красить, сколько нужно и к какому сроку</small>
                  </li>
                  <li>
                    <span aria-hidden="true">•</span>
                    <strong>Проверка фактов</strong>
                    <small>Каталог, живой остаток и учебные цены поставщиков</small>
                  </li>
                  <li>
                    <span aria-hidden="true">•</span>
                    <strong>Сведения о клиенте</strong>
                    <small>
                      {bridgeOnline
                        ? "Модель ищет сведения по сайту, ИНН и названию; ссылки остаются для проверки"
                        : "Некоторые примеры показывают подготовленные сведения и ссылки"}
                    </small>
                  </li>
                  <li>
                    <span aria-hidden="true">•</span>
                    <strong>Проверка решения</strong>
                    <small>
                      {bridgeOnline
                        ? "Модель проверки сверяет факты, обещания и решения для руководителя"
                        : "Программа проверяет числа, условия и правила"}
                    </small>
                  </li>
                  <li>
                    <span aria-hidden="true">•</span>
                    <strong>Что делать дальше</strong>
                    <small>Ответ, вопросы или варианты руководителю</small>
                  </li>
                </ol>
              </div>
            ) : (
              <div className="run-panel">
                <div className="run-head">
                  <div>
                    <button
                      className="order-card-link"
                      type="button"
                      onClick={() => setModal("order")}
                    >
                      Исходное письмо · заявка {orderNumber(orderId)} ↗
                    </button>
                    <h2>{order?.subject ?? "Принимаем заказ…"}</h2>
                    <small>
                      {order?.company || "Частный клиент"} ·{" "}
                      этап переписки {order?.roundNo ?? 1} ·{" "}
                      {usesOpenCode(order?.mode)
                        ? modelLabel(
                            order?.agentModel ??
                              order?.requestedModel ??
                              selectedModel,
                          )
                        : "Автоматическая обработка по правилам"}
                    </small>
                    {order?.body && (
                      <p className="order-card-preview">
                        {order.body.length > 180
                          ? `${order.body.slice(0, 177)}…`
                          : order.body}
                      </p>
                    )}
                  </div>
                  <div
                    className={`zone-badge ${
                      currentZone ? `zone-${currentZone}` : "is-processing"
                    }`}
                  >
                    <span />
                    {currentZone
                      ? zoneCopy[currentZone].name
                      : "Агент работает"}
                  </div>
                </div>

                <div
                  className="progress-track"
                  role="progressbar"
                  aria-label="Ход обработки заявки"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                >
                  <span style={{ width: `${progress}%` }} />
                </div>

                <div
                  className="event-list"
                  role="log"
                  aria-live="polite"
                  aria-relevant="additions text"
                >
                  {events.map((item, index) => (
                    <article
                      className={`event-item ${
                        item.state === "error" ? "is-error" : ""
                      }`}
                      key={item.id}
                      style={{ animationDelay: `${Math.min(index * 70, 350)}ms` }}
                    >
                      <div className="event-index">
                        {String(index + 1).padStart(2, "0")}
                      </div>
                      <div>
                        <h3>{humanizeText(item.title)}</h3>
                        <p>{humanizeText(item.detail)}</p>
                      </div>
                      <time>{formatEventTime(item.createdAt)}</time>
                    </article>
                  ))}
                  {["queued", "processing"].includes(order?.status ?? "") && (
                    <article className="event-item is-active">
                      <div className="event-index">··</div>
                      <div>
                        <h3>Агент продолжает работу</h3>
                        <p>Новый результат появится в этой карточке.</p>
                      </div>
                      <span className="event-pulse" />
                    </article>
                  )}
                </div>

                {order?.status === "error" && (
                  <div className="error-state">
                    <div>
                      <strong>Работу можно продолжить</strong>
                      <p>
                        Письмо, номер карточки, переписка и история сохранены.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void retryOrder()}
                      disabled={
                        retrying ||
                        (!orderActionKey && !adminAuthenticated)
                      }
                    >
                      {retrying
                        ? "Запускаем карточку снова…"
                        : "Повторить эту карточку"}
                    </button>
                  </div>
                )}

                {result && order && (
                  <ResultPanel
                    key={order.id}
                    result={result}
                    order={order}
                    approving={approving}
                    reserving={reserving}
                    sending={sending}
                    clarifying={clarifying}
                    continuing={continuing}
                    recalculating={recalculating}
                    supplierRefreshNeeded={supplierRefreshNeeded}
                    customerAnswer={customerAnswer}
                    inventory={inventory}
                    resultHistory={orderResultHistory}
                    canManageOrder={
                      Boolean(orderActionKey) || adminAuthenticated
                    }
                    onApprove={approve}
                    onReserve={prepareReserve}
                    onSend={sendReply}
                    onSendClarification={sendClarification}
                    onContinue={continueOrder}
                    onRecalculate={recalculateOrder}
                    onCustomerAnswerChange={setCustomerAnswer}
                    onOpenCatalog={() => setModal("catalog")}
                  />
                )}
              </div>
            )}

            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
          </div>
        </section>

        <section className="control-story">
          <div className="control-intro">
            <p className="eyebrow">
              {bridgeOnline
                ? isComparativeStrongModel
                  ? "Сравнение моделей"
                  : "Ежедневная модель и отдельная проверка"
                : "Автоматическая обработка по правилам"}
            </p>
            <h2>
              {bridgeOnline
                ? "Рабочая модель действует по правилам, модель проверки сверяет решение"
                : "Готовые правила, точные факты и журнал отвечают за качество"}
            </h2>
            <p>
              {bridgeOnline
                ? isComparativeStrongModel
                  ? "GPT-5.6 Sol сначала обрабатывает заказ, затем новым запуском проверяет готовое решение. Программа подтверждает цены и остатки перед каждым действием."
                  : `${modelLabel(selectedModel)} обрабатывает заказ по готовым правилам. GPT-5.6 Sol отдельно проверяет факты и обещания. Программа подтверждает цены и остатки перед каждым действием.`
                : "Система читает заявку, сверяет склад и собирает ответ по подготовленным правилам. При подключении моделей сохраняется тот же путь и те же проверки."}
            </p>
          </div>
          <div className="control-grid">
            <article>
              <span>
                {bridgeOnline && isComparativeStrongModel
                  ? "Сравнительный запуск"
                  : "Ежедневная работа"}
              </span>
              <strong>
                {bridgeOnline
                  ? isComparativeStrongModel
                    ? "GPT-5.6 Sol обрабатывает заказ"
                    : `${modelLabel(selectedModel)} обрабатывает заказ`
                  : "Система обрабатывает заказ по правилам"}
              </strong>
              <p>
                {bridgeOnline
                  ? `Модель для фото описывает видимые детали. ${modelLabel(
                      selectedModel,
                    )} читает письмо, обращается к источникам и собирает ответ по шагам.`
                  : "Стенд читает заявку, обращается к живому складу, считает заказ и показывает решение. В живом режиме те же шаги выполняют выбранные модели."}
              </p>
            </article>
            <article>
              <span>Подготовка и контроль</span>
              <strong>
                {bridgeOnline
                  ? "Модель проверки отдельно сверяет решение"
                  : "GPT-5.6 Sol подготовила правила"}
              </strong>
              <p>
                {bridgeOnline
                  ? "GPT-5.6 Sol подготовила правила и критерии. По умолчанию она же отдельным запуском проверяет факты и обещания каждого ответа. Команда может передать журнал модели и получить предложения; руководитель выбирает правки."
                  : "GPT-5.6 Sol заранее подготовила правила и критерии. Команда может передать журнал модели и получить предложения; руководитель выбирает правки."}
              </p>
              <button type="button" onClick={() => setModal("instructions")}>
                Открыть три правила
              </button>
            </article>
            <article>
              <span>Точные факты</span>
              <strong>Программа проверяет условия</strong>
              <p>
                {bridgeOnline
                  ? "Перед каждым ответом программа сверяет цену, остаток и правила. Модель выбирает: ответить, уточнить или передать решение руководителю."
                  : "При каждом расчёте программа сверяет цену, остаток и правила. Готовые правила определяют следующий шаг: ответить, уточнить или передать решение руководителю."}
              </p>
              <button
                type="button"
                onClick={() =>
                  document
                    .getElementById("live-inventory")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
              >
                Посмотреть живой склад
              </button>
            </article>
          </div>
        </section>

        <LiveInventoryPanel
          inventory={inventory}
          market={market}
          selectedSku={inventorySku}
          stockValue={inventoryStock}
          reason={inventoryReason}
          selectedMarketId={marketOfferId}
          marketStockValue={marketStock}
          authenticated={adminAuthenticated}
          adminCode={adminCode}
          busy={adminBusy}
          marketBusy={marketBusy}
          message={inventoryMessage}
          error={inventoryError}
          marketMessage={marketMessage}
          marketError={marketError}
          onOpenCatalog={() => setModal("catalog")}
          onSelectSku={selectInventoryItem}
          onStockChange={setInventoryStock}
          onReasonChange={setInventoryReason}
          onSelectMarket={selectMarketOffer}
          onMarketStockChange={setMarketStock}
          onAdminCodeChange={setAdminCode}
          onSignIn={signInAdmin}
          onSignOut={signOutAdmin}
          onUpdate={updateInventory}
          onMarketUpdate={updateMarket}
        />

        <section className="day-result" id="day-result">
          <div className="day-heading">
            <div>
              <p className="eyebrow">Общий результат за сегодня</p>
              <h2>Стенд запоминает работу участников</h2>
            </div>
            <p>
              Заявки, уточнения, решения, отправки и изменения склада собираются
              автоматически.
            </p>
          </div>
          <div className="metric-grid">
            <article>
              <span>Карточек</span>
              <strong>{stats.total}</strong>
              <small>создано сегодня</small>
            </article>
            <article>
              <span>С готовым ответом</span>
              <strong>{stats.completed}</strong>
              <small>подготовлен, зарезервирован или отправлен</small>
            </article>
            <article>
              <span>Ждут руководителя</span>
              <strong>{stats.awaitingApproval}</strong>
              <small>ждут решения</small>
            </article>
            <article>
              <span>Ждут клиента</span>
              <strong>{stats.awaitingCustomer}</strong>
              <small>вопросы уже готовы или отправлены</small>
            </article>
            <article>
              <span>Записано отправок</span>
              <strong>{stats.sent}</strong>
              <small>зафиксировано в журнале</small>
            </article>
          </div>
          <div className="zone-totals">
            <span>
              <i className="zone-green" /> Зелёный · готовы ответить:{" "}
              {stats.zones.green}
            </span>
            <span>
              <i className="zone-yellow" /> Жёлтый · нужны детали:{" "}
              {stats.zones.yellow}
            </span>
            <span>
              <i className="zone-red" /> Красный · решает руководитель:{" "}
              {stats.zones.red}
            </span>
          </div>

          <LedgerTable
            orders={ledger.orders ?? []}
            events={ledger.events ?? []}
            inventoryChanges={ledger.inventoryChanges ?? []}
            resultHistory={ledger.resultHistory ?? []}
            inventory={inventory}
            onOpenOrder={openLedgerOrder}
          />
        </section>
      </main>

      <footer>
        <strong>Колер</strong>
        <span>
          Данные о красках и запасах, сгенерированные для демонстрации на
          вебинаре. Примеры цен других поставщиков и учебные заявки подготовлены
          для показа.
        </span>
        <span>Модель для заказов · живой склад · журнал всех заказов</span>
      </footer>

      {modal && (
        <Modal
          name={modal}
          order={order}
          events={events}
          inventory={inventory}
          market={market}
          onClose={closeModal}
        />
      )}
    </div>
  );
}

function ResultPanel({
  result,
  order,
  approving,
  reserving,
  sending,
  clarifying,
  continuing,
  recalculating,
  supplierRefreshNeeded,
  customerAnswer,
  inventory,
  resultHistory,
  canManageOrder,
  onApprove,
  onReserve,
  onSend,
  onSendClarification,
  onContinue,
  onRecalculate,
  onCustomerAnswerChange,
  onOpenCatalog,
}: {
  result: AgentResult;
  order: OrderRecord;
  approving: string;
  reserving: boolean;
  sending: boolean;
  clarifying: boolean;
  continuing: boolean;
  recalculating: boolean;
  supplierRefreshNeeded: boolean;
  customerAnswer: string;
  inventory: InventoryItem[];
  resultHistory: ResultHistoryEntry[];
  canManageOrder: boolean;
  onApprove: (id: string) => Promise<void>;
  onReserve: () => Promise<void>;
  onSend: () => Promise<void>;
  onSendClarification: () => Promise<void>;
  onContinue: () => Promise<void>;
  onRecalculate: () => Promise<void>;
  onCustomerAnswerChange: (value: string) => void;
  onOpenCatalog: () => void;
}) {
  const [selectedOption, setSelectedOption] = useState({
    key: "",
    id: "",
  });
  const [inventoryTransition, setInventoryTransition] = useState<{
    sku: string;
    paintName: string;
    beforeStockKg: number;
    afterStockKg: number;
    beforeZone: ScenarioZone;
    beforeReason: string;
    beforeReply: string;
    beforeOptionTitle?: string;
    afterRevision: number;
  } | null>(null);
  const zone = zoneCopy[result.zone];
  const sent = order.status === "sent";
  const reserved = order.status === "reserved";
  const productSavedItem = result.product
    ? snapshotItems(order.inventorySnapshot).find(
        (item) => item.sku === result.product?.sku,
      )
    : null;
  const inventoryChange =
    inventory.length > 0
      ? changedProductInventory(
          order.inventorySnapshot,
          result,
          inventory,
          demoData.products,
        )
      : null;
  const changedSavedItem = inventoryChange?.saved ?? null;
  const changedLiveItem = inventoryChange?.live ?? null;
  const inventoryChanged = Boolean(inventoryChange);
  const actionableInventoryChange = inventoryChanged && !sent;
  const actionableSupplierRefresh =
    supplierRefreshNeeded && !inventoryChanged && !sent;
  const canClarify =
    canManageOrder &&
    result.route === "needs_info" &&
    order.status === "clarification_ready";
  const waitingForCustomer = order.status === "awaiting_customer";
  const showFloorReplyPresets =
    waitingForCustomer &&
    /ПРОТЕК/iu.test(order.company) &&
    /краск\p{L}*\s+для\s+пол\p{L}*|покрасить\s+пол/iu.test(
      `${order.subject} ${order.body}`,
    );
  const canReserve =
    canManageOrder &&
    order.status === "ready_to_send" &&
    result.route !== "needs_info" &&
    !inventoryChanged;
  const canSend = canManageOrder && reserved && !inventoryChanged;
  const supplierPlan = result.supplierPlan ?? null;
  const comparedSupplierOffers = Array.isArray(supplierPlan?.comparedOffers)
    ? supplierPlan.comparedOffers
    : [];
  const supplierDaysSaved =
    supplierPlan && result.product
      ? Math.max(
          0,
          result.product.replenishmentDays - supplierPlan.deliveryDays,
        )
      : 0;
  const supplierSaving =
    supplierPlan && result.product
      ? Math.max(0, result.product.total - supplierPlan.total)
      : 0;
  const supplierPlanConfirmed = Boolean(supplierPlan?.confirmedAt);
  const primaryAction =
    result.options.length > 0 && !order.managerDecision
      ? {
          href: "#manager-decision",
          label: "Перейти к выбору решения",
        }
      : canClarify
        ? {
            href: "#reply-card",
            label: "Перейти к вопросам клиенту",
          }
        : canReserve || canSend
          ? {
              href: "#reply-card",
              label: canSend
                ? "Перейти к записи отправки"
                : "Перейти к резерву товара",
            }
          : null;
  const responsePrepared = ["ready_to_send", "reserved", "sent"].includes(
    order.status,
  );
  const reservePrepared = ["reserved", "sent"].includes(order.status);
  const optionSetKey = `${order.id}:${order.roundNo ?? 1}:${
    order.managerDecision ?? ""
  }:${result.options.map((option) => option.id).join("|")}`;
  const selectedOptionId =
    selectedOption.key === optionSetKey ? selectedOption.id : "";
  const selectedManagerOption =
    result.options.find((option) => option.id === selectedOptionId) ?? null;
  const checks = positiveChecks(result);
  const insights = [
    result.market.checked
      ? result.market.position
      : "Ответ клиента даст точный подбор и расчёт",
    result.market.profitOpportunity,
    ...checks,
  ]
    .map((item) => humanizeText(item ?? ""))
    .filter((item, index, rows) => item && rows.indexOf(item) === index)
    .slice(0, 4);
  const conversation = Array.isArray(order.conversation)
    ? order.conversation
    : [];
  const earlierConversation = conversation.slice(
    0,
    Math.max(0, conversation.length - 4),
  );
  const latestConversation = conversation.slice(-4);
  const renderConversationMessage = (
    message: ConversationEntry,
    index: number,
  ) => {
    const body = message.body ?? message.text ?? "";
    const isCustomer =
      message.role === "customer" ||
      message.from === "customer" ||
      message.direction === "incoming";
    return (
      <article
        className={isCustomer ? "is-customer" : "is-agent"}
        key={`${message.createdAt ?? message.at ?? "message"}-${index}`}
      >
        <span>{isCustomer ? "Клиент" : "Агент"}</span>
        <p>{humanizeText(body)}</p>
        <time>{formatDateTime(message.createdAt ?? message.at)}</time>
      </article>
    );
  };
  const transitionComplete = Boolean(
    inventoryTransition &&
      snapshotItems(order.inventorySnapshot).some(
        (item) =>
          item.sku === inventoryTransition.sku &&
          item.stockKg === inventoryTransition.afterStockKg &&
          Number(item.revision ?? item.stockRevision) ===
            inventoryTransition.afterRevision,
      ),
  );
  const savedRecalculation = (() => {
    for (let index = resultHistory.length - 1; index > 0; index -= 1) {
      if (
        [
          "Склад перечитан",
          "Поставщик перечитан",
          "Поставщик и склад перечитаны",
        ].includes(resultHistory[index].reason)
      ) {
        return {
          before: resultHistory[index - 1],
          after: resultHistory[index],
        };
      }
    }
    return null;
  })();
  const stockFromReason = (value: string) => {
    const match = value.match(/(\d[\d\s]*)\s*кг/iu);
    return match ? `${match[1].replace(/\s+/g, " ").trim()} кг` : "";
  };
  const savedBeforeLetter = savedRecalculation
    ? customerLetterForTransition(
        savedRecalculation.before.result,
        savedRecalculation.before.replyBody,
      )
    : null;
  const savedAfterLetter = savedRecalculation
    ? customerLetterForTransition(
        savedRecalculation.after.result,
        savedRecalculation.after.replyBody,
      )
    : null;
  const savedInventoryChange = savedRecalculation
    ? changedProductInventory(
        savedRecalculation.before.inventorySnapshot,
        savedRecalculation.before.result,
        snapshotItems(savedRecalculation.after.inventorySnapshot),
        demoData.products,
      )
    : null;
  const currentLetter = customerLetterForTransition(result, result.reply.body);
  const persistedTransition =
    savedRecalculation &&
    savedRecalculation.after.id === resultHistory.at(-1)?.id
      ? {
          beforeStock:
            savedInventoryChange?.saved?.stockKg != null
              ? `${formatMoney(savedInventoryChange.saved.stockKg)} кг`
              : savedRecalculation.before.result?.product?.stockKg != null
                ? `${formatMoney(
                    savedRecalculation.before.result.product.stockKg,
                  )} кг`
                : stockFromReason(savedRecalculation.before.zoneReason) ||
                  "остаток сохранён в журнале",
          afterStock:
            savedInventoryChange?.live?.stockKg != null
              ? `${formatMoney(savedInventoryChange.live.stockKg)} кг`
              : savedRecalculation.after.result?.product?.stockKg != null
                ? `${formatMoney(
                    savedRecalculation.after.result.product.stockKg,
                  )} кг`
                : result.product
                  ? `${formatMoney(result.product.stockKg)} кг`
                  : zoneCopy[savedRecalculation.after.zone].name,
          beforeZone: savedRecalculation.before.zone,
          afterZone: savedRecalculation.after.zone,
          beforeReason: savedRecalculation.before.zoneReason,
          afterReason: savedRecalculation.after.zoneReason,
          beforeReply:
            savedBeforeLetter?.body ?? savedRecalculation.before.replyBody,
          afterReply:
            savedAfterLetter?.body ?? savedRecalculation.after.replyBody,
          beforeOptionTitle: savedBeforeLetter?.optionTitle ?? "",
          afterOptionTitle: savedAfterLetter?.optionTitle ?? "",
          paintName:
            savedInventoryChange?.live?.name ??
            savedInventoryChange?.saved?.name ??
            savedInventoryChange?.sku ??
            result.product?.name ??
            "",
        }
      : null;
  const visibleTransition =
    persistedTransition ??
    (transitionComplete && inventoryTransition
      ? {
          beforeStock: `${formatMoney(
            inventoryTransition.beforeStockKg,
          )} кг`,
          afterStock: `${formatMoney(inventoryTransition.afterStockKg)} кг`,
          beforeZone: inventoryTransition.beforeZone,
          afterZone: result.zone,
          beforeReason: inventoryTransition.beforeReason,
          afterReason: result.zoneReason,
          beforeReply: inventoryTransition.beforeReply,
          afterReply: currentLetter.body,
          beforeOptionTitle: inventoryTransition.beforeOptionTitle ?? "",
          afterOptionTitle: currentLetter.optionTitle,
          paintName: inventoryTransition.paintName,
        }
      : null);
  const changedPaintName =
    changedLiveItem?.name ??
    changedSavedItem?.name ??
    inventoryChange?.sku ??
    "";
  const recalculateWithComparison = async () => {
    if (inventoryChange && changedSavedItem && changedLiveItem) {
      const beforeLetter = customerLetterForTransition(
        result,
        result.reply.body,
      );
      setInventoryTransition({
        sku: inventoryChange.sku,
        paintName: changedPaintName,
        beforeStockKg: changedSavedItem.stockKg,
        afterStockKg: changedLiveItem.stockKg,
        beforeZone: result.zone,
        beforeReason: result.zoneReason,
        beforeReply: beforeLetter.body,
        beforeOptionTitle: beforeLetter.optionTitle,
        afterRevision: changedLiveItem.revision,
      });
    }
    await onRecalculate();
  };
  const managerDecisionBlock =
    result.options.length > 0 && !order.managerDecision ? (
      <div className="manager-block" id="manager-decision" tabIndex={-1}>
        <div className="manager-heading">
          <span>Решение</span>
          <div>
            <small>Решение руководителя на стенде</small>
            <h3>Выберите подходящий вариант для клиента и завода</h3>
          </div>
        </div>
        <p className="manager-note">
          Сначала выберите следующий шаг. Сведения о клиенте, расчёты и
          источники остаются ниже для проверки.
        </p>
        <p className="manager-role-note">
          На стенде участник на минуту принимает роль руководителя и выбирает
          один вариант. В рабочей системе такое решение получает сотрудник с
          полномочиями.
        </p>
        <fieldset
          className="option-grid"
          disabled={
            Boolean(approving) || inventoryChanged || !canManageOrder
          }
        >
          <legend className="sr-only">Вариант решения</legend>
          {result.options.map((option, index) => (
            <label
              className={`option-card ${
                selectedOptionId === option.id ? "is-selected" : ""
              }`}
              key={option.id}
            >
              <input
                type="radio"
                name={`decision-${order.id}`}
                value={option.id}
                checked={selectedOptionId === option.id}
                onChange={() =>
                  setSelectedOption({ key: optionSetKey, id: option.id })
                }
              />
              <span className="option-number">0{index + 1}</span>
              <h4>{humanizeText(option.title)}</h4>
              <span className="option-label">Польза клиенту</span>
              <p>{humanizeText(option.rationale)}</p>
              <span className="option-label">Результат для завода</span>
              <p className="option-business-result">
                {optionBusinessResult(option, result)}
              </p>
              <span className="option-label">Что учесть</span>
              <small>{humanizeText(option.tradeoff)}</small>
            </label>
          ))}
        </fieldset>
        {selectedManagerOption && (
          <div className="selected-option-letter" role="status">
            <span>Письмо по выбранному варианту</span>
            <strong>{humanizeText(selectedManagerOption.title)}</strong>
            <p>{humanizeText(selectedManagerOption.reply)}</p>
          </div>
        )}
        <button
          className="approve-button"
          type="button"
          onClick={() => onApprove(selectedManagerOption?.id ?? "")}
          disabled={
            !selectedManagerOption ||
            Boolean(approving) ||
            inventoryChanged ||
            !canManageOrder
          }
        >
          {approving
            ? "Подтверждаем решение…"
            : "Подтвердить выбранный вариант"}
        </button>
      </div>
    ) : null;

  return (
    <div className="result-panel">
      {actionableInventoryChange &&
        inventoryChange &&
        changedSavedItem &&
        changedLiveItem && (
          <section
            className="freshness-banner"
            id="current-order-refresh"
            role="status"
            tabIndex={-1}
          >
            <div>
              <span>Живой склад обновлён</span>
              <strong>
                «{changedPaintName}»: было{" "}
                {formatMoney(changedSavedItem.stockKg)} кг. Сейчас на складе{" "}
                {formatMoney(changedLiveItem.stockKg)} кг.
              </strong>
              <small>
                Заказ собран по прежнему остатку. Агент перечитает склад,
                соберёт новое письмо и покажет обе версии рядом.
              </small>
            </div>
            <button
              type="button"
              onClick={() => void recalculateWithComparison()}
              disabled={recalculating || !canManageOrder}
            >
              {recalculating
                ? "Агент пересчитывает заказ…"
                : "Пересчитать заказ по новому остатку"}
            </button>
          </section>
        )}

      {actionableSupplierRefresh && (
        <section
          className="freshness-banner"
          id="current-order-refresh"
          role="status"
          tabIndex={-1}
        >
          <div>
            <span>Данные поставщика обновились</span>
            <strong>
              Агент перечитает цену, доступный объём, срок и дату проверки.
            </strong>
            <small>
              После пересчёта карточка покажет выполнимый вариант и сохранит
              прежнее решение в журнале.
            </small>
          </div>
          <button
            type="button"
            onClick={() => void onRecalculate()}
            disabled={recalculating || !canManageOrder}
          >
            {recalculating
              ? "Агент пересчитывает заказ…"
              : "Пересчитать по свежим данным"}
          </button>
        </section>
      )}

      {visibleTransition && (
        <section
          className="decision-transition"
          id="decision-transition"
          role="status"
          tabIndex={-1}
        >
          <div className="transition-heading">
            <span>Склад изменил решение</span>
            <strong>
              Остаток краски «{visibleTransition.paintName}» —{" "}
              {visibleTransition.afterStock} вместо{" "}
              {visibleTransition.beforeStock} — изменил следующий шаг и письмо
            </strong>
          </div>
          <div className="transition-comparison">
            <article>
              <span>Было</span>
              <strong>{visibleTransition.beforeStock}</strong>
              <small>{zoneCopy[visibleTransition.beforeZone].name}</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>Стало</span>
              <strong>{visibleTransition.afterStock}</strong>
              <small>{zoneCopy[visibleTransition.afterZone].name}</small>
            </article>
          </div>
          <div className="transition-details">
            <p>
              <strong>Раньше:</strong>{" "}
              {humanizeText(visibleTransition.beforeReason)}
            </p>
            <p>
              <strong>Теперь:</strong>{" "}
              {humanizeText(visibleTransition.afterReason)}
            </p>
          </div>
          <div
            className="transition-letter-grid"
            aria-label="Как изменилось письмо клиенту"
          >
            <article>
              <span>
                Письмо до обновления склада
                {visibleTransition.beforeOptionTitle
                  ? ` · вариант «${visibleTransition.beforeOptionTitle}»`
                  : ""}
              </span>
              <p>{humanizeText(visibleTransition.beforeReply)}</p>
            </article>
            <article>
              <span>
                Письмо после обновления склада
                {visibleTransition.afterOptionTitle
                  ? ` · вариант «${visibleTransition.afterOptionTitle}»`
                  : ""}
              </span>
              <p>{humanizeText(visibleTransition.afterReply)}</p>
            </article>
          </div>
          <small>
            Обе версии сохранились в карточке и журнале. Свежее письмо ждёт
            вашего подтверждения.
          </small>
        </section>
      )}

      {!canManageOrder && (
        <div className="read-only-note" role="note">
          Карточка открыта для просмотра. Действия доступны участнику, который
          создал её, и ведущему вебинара.
        </div>
      )}

      <div className="result-summary">
        <div className={`decision-poster zone-${result.zone}`}>
          <span>{zone.name}</span>
          <strong>{humanizeText(result.zoneReason)}</strong>
          {primaryAction && (
            <a className="decision-next-link" href={primaryAction.href}>
              {primaryAction.label} ↓
            </a>
          )}
          <small>
            {result.sources.length}{" "}
            {countNoun(
              result.sources.length,
              "источник",
              "источника",
              "источников",
            )}{" "}
            · {result.checks.length}{" "}
            {countNoun(
              result.checks.length,
              "проверка",
              "проверки",
              "проверок",
            )}
          </small>
        </div>

        <div className="facts-grid">
          <article>
            <span>Что понял агент</span>
            {result.understood.map((item) => (
              <strong key={item}>{humanizeText(item)}</strong>
            ))}
          </article>
          <article>
            <span>Что делать дальше</span>
            <p>
              {humanizeText(
                result.route === "manager"
                  ? order.managerDecision
                    ? order.status === "sent"
                      ? "Решение выполнено, отправка ответа записана в журнал."
                      : order.status === "reserved"
                        ? "Резерв товара подготовлен. Запишите отправку согласованного письма."
                        : "Решение подтверждено. Подготовьте резерв товара."
                    : "Выберите один вариант ниже. Агент покажет готовое письмо и последствия для клиента и завода."
                  : result.route === "ready" && !result.research?.checked
                    ? "Проверьте готовое письмо и подготовьте резерв товара."
                    : result.managerNote,
              )}
            </p>
          </article>
          <article>
            <span>Что получает завод</span>
            <p>
              {humanizeText(
                result.market.profitOpportunity || result.market.summary,
              )}
            </p>
          </article>
          <article>
            <span>Проверка перед действием</span>
            <strong>{humanizeText(result.review.verdict)}</strong>
            <p>{result.review.notes.map(humanizeText).join(" · ")}</p>
          </article>
          {!result.research?.checked && (
            <article className="facts-wide">
              <span>Как это помогает продать</span>
              <p>{humanizeText(result.businessContext)}</p>
            </article>
          )}
        </div>
      </div>

      {managerDecisionBlock}

      <DecisionProofs
        insights={insights}
        bases={result.decisionBasis ?? []}
      />

      {result.research &&
        (result.research.checked || result.research.sources.length > 0) && (
          <div className="research-card">
            <div className="research-confirmed">
              <span>
                {result.research.checked
                  ? "Проверено по источникам"
                  : "Источники для проверки"}
              </span>
              <p>{humanizeText(result.research.summary)}</p>
            </div>
            {result.research.sources.length > 0 ? (
              <div className="research-links">
                {result.research.sources.map((source) => (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    key={source.url}
                  >
                    <strong>{humanizeText(source.title)}</strong>
                    <small>
                      {humanizeText(source.fact)} · {source.checkedAt}
                    </small>
                  </a>
                ))}
              </div>
            ) : (
              <small>
                Агент завершил поиск и оставил в карточке только проверяемые
                факты.
              </small>
            )}
            {researchHypothesis(result) && (
              <div className="research-hypothesis">
                <span>Предположение агента</span>
                <p>{researchHypothesis(result)}</p>
                <small>
                  Агент проверяет предположение одним вопросом. Руководитель
                  принимает решение по фактам и ответу клиента.
                </small>
              </div>
            )}
            {!usesOpenCode(order.mode) && (
              <small className="research-mode-note">
                Карточка использует подготовленные источники. При подключении
                модель для заказов может проверить сайт, ИНН или условия
                заказа, открыть нужные страницы и сохранить факты со ссылками.
              </small>
            )}
          </div>
        )}

      {result.calculation && (
        <section className="calculation-card">
          <div className="calculation-heading">
            <span>
              Расчёт для{" "}
              {result.calculation.surface === "стена"
                ? "стен"
                : result.calculation.surface === "пол"
                  ? "пола"
                  : "забора"}{" "}
              ·{" "}
              {result.calculation.source === "распознанное фото"
                ? "сведения с фотографии"
                : order.roundNo && order.roundNo > 1
                  ? "данные из переписки"
                  : "данные из письма"}
            </span>
            <strong>
              {formatMoney(result.calculation.packages)}{" "}
              {countNoun(
                result.calculation.packages,
                "упаковка",
                "упаковки",
                "упаковок",
              )}{" "}
              по {formatMoney(result.calculation.packageKg)} кг
            </strong>
          </div>
          <div className="calculation-steps">
            {result.calculation.kind === "fence-area" ? (
              <>
                <span>
                  {result.calculation.lengthM} ×{" "}
                  {result.calculation.heightM} м
                </span>
                <i aria-hidden="true">→</i>
                <span>
                  {result.calculation.sides === 2
                    ? "две стороны"
                    : "одна сторона"}
                </span>
                <i aria-hidden="true">→</i>
              </>
            ) : (
              <>
                <span>{formatMoney(result.calculation.paintAreaM2)} м²</span>
                <i aria-hidden="true">→</i>
                <span>
                  {formatMoney(result.calculation.coats)}{" "}
                  {countNoun(
                    result.calculation.coats,
                    "слой",
                    "слоя",
                    "слоёв",
                  )}
                </span>
                <i aria-hidden="true">→</i>
                <span>
                  {result.calculation.reservePercent}% технологического запаса
                </span>
                <i aria-hidden="true">→</i>
              </>
            )}
            {result.calculation.kind === "fence-area" && (
              <>
                <span>{formatMoney(result.calculation.paintAreaM2)} м²</span>
                <i aria-hidden="true">→</i>
              </>
            )}
            <span>{formatMoney(result.calculation.roundedKg)} кг</span>
          </div>
          <p>{humanizeText(result.calculation.explanation)}</p>
        </section>
      )}

      {result.product && (
        <div className="numbers-row">
          <button type="button" onClick={onOpenCatalog}>
            <span>Подобранная краска ↗</span>
            <strong>{humanizeText(result.product.name)}</strong>
            <small>Открыть живой склад</small>
          </button>
          <div>
            <span>Нужно клиенту</span>
            <strong>
              {result.product.requestedKg
                ? `${formatMoney(result.product.requestedKg)} кг`
                : "После уточнения"}
            </strong>
          </div>
          <div>
            <span>Доступно у «Колера»</span>
            <strong>{formatMoney(result.product.stockKg)} кг</strong>
            <small>
              Склад проверен {formatDateTime(productSavedItem?.updatedAt)}
            </small>
          </div>
          <div>
            <span>Наша цена</span>
            <strong>{formatMoney(result.product.pricePerKg)} ₽/кг</strong>
          </div>
          <div>
            <span>
              {supplierPlan
                ? `${formatMoney(result.product.requestedKg)} кг по цене «Колера»`
                : "Сумма"}
            </span>
            <strong>
              {result.product.requestedKg
                ? `${formatMoney(result.product.total)} ₽`
                : "После уточнения"}
            </strong>
            {supplierPlan && (
              <small>
                Расчёт для сравнения; сейчас у «Колера» доступно{" "}
                {formatMoney(supplierPlan.ourKg)} кг
              </small>
            )}
          </div>
        </div>
      )}

      {supplierPlan && (
        <section
          className="supplier-help-card"
          id="supplier-help"
          aria-labelledby="supplier-help-title"
          tabIndex={-1}
        >
          <div>
            <span>
              {supplierPlanConfirmed
                ? "Руководитель одобрил запрос · ждём подтверждений"
                : "Расчёт варианта с другим поставщиком · ждёт решения руководителя"}
            </span>
            <h3 id="supplier-help-title">
              Агент нашёл, как собрать все{" "}
              {formatMoney(result.product?.requestedKg ?? 0)} кг
            </h3>
            <p className="supplier-benefit-copy">
              Клиент получает один понятный план и общается с одним менеджером,
              даже когда на складе «Колера» мало краски.
            </p>
            <div
              className="supplier-rescue-summary"
              aria-label="Как партнёр помогает выполнить заказ"
            >
              <article>
                <span>01</span>
                <strong>
                  «Колер» даёт {formatMoney(supplierPlan.ourKg)} кг
                </strong>
                <small>
                  Наша часть · из{" "}
                  {formatMoney(result.product?.requestedKg ?? 0)} кг
                </small>
              </article>
              <article>
                <span>02</span>
                <strong>
                  Нужно запросить у партнёра{" "}
                  {formatMoney(supplierPlan.supplierKg)} кг
                </strong>
                <small>
                  К своим {formatMoney(supplierPlan.ourKg)} кг до полного
                  заказа · в строке партнёра видно{" "}
                  {formatMoney(supplierPlan.supplierStockKg)} кг ·{" "}
                  {humanizeText(supplierPlan.supplierName)}
                </small>
              </article>
              <article>
                <span>03</span>
                <strong>
                  {supplierDaysSaved > 0
                    ? `После подтверждений весь объём будет доступен на ${formatMoney(
                        supplierDaysSaved,
                      )} ${countNoun(
                        supplierDaysSaved,
                        "день",
                        "дня",
                        "дней",
                      )} раньше, чем после пополнения «Колера»`
                    : "После подтверждений соберём весь объём"}
                </strong>
                <small>
                  По строке партнёра —{" "}
                  {formatMoney(supplierPlan.deliveryDays)}{" "}
                  {countNoun(
                    supplierPlan.deliveryDays,
                    "день",
                    "дня",
                    "дней",
                  )}{" "}
                  на его часть
                </small>
              </article>
            </div>
            <p className="supplier-price-copy">
              Предварительный расчёт: {formatMoney(supplierPlan.ourKg)} кг
              «Колера» по{" "}
              {formatMoney(supplierPlan.ourPricePerKg)} ₽/кг, «
              {humanizeText(supplierPlan.supplierName)}» —{" "}
              {formatMoney(supplierPlan.supplierKg)} кг по{" "}
              {formatMoney(supplierPlan.supplierPricePerKg)} ₽/кг. Стоимость
              по текущим строкам — {formatMoney(supplierPlan.total)} ₽
              {supplierSaving > 0
                ? `. После подтверждения цены экономия составит ${formatMoney(
                    supplierSaving,
                  )} ₽ по сравнению с расчётом всех ${formatMoney(
                    result.product?.requestedKg ?? 0,
                  )} кг по текущей цене «Колера»`
                : ""}
              .
            </p>
          </div>
          {comparedSupplierOffers.length > 0 && (
            <details className="supplier-comparison">
              <summary>
                Агент сравнил {formatMoney(supplierPlan.offersChecked)}{" "}
                {countNoun(
                  supplierPlan.offersChecked,
                  "предложение",
                  "предложения",
                  "предложений",
                )}. {formatMoney(supplierPlan.eligibleOffers)}{" "}
                {countNoun(
                  supplierPlan.eligibleOffers,
                  "может",
                  "могут",
                  "могут",
                )} привезти недостающие {formatMoney(
                  supplierPlan.supplierKg,
                )} кг
              </summary>
              <p>{humanizeText(supplierPlan.selectionRule)}</p>
              <ul>
                {comparedSupplierOffers.map((offer) => (
                  <li
                    className={offer.selected ? "is-selected" : ""}
                    key={`${offer.supplierName}-${offer.stockCheckedAt}`}
                  >
                    <strong>{humanizeText(offer.supplierName)}</strong>
                    <span>
                      {offer.selected
                        ? `Выбран: ${formatMoney(
                            supplierPlan.supplierKg,
                          )} кг за ${formatMoney(
                            offer.deliveryDays,
                          )} ${countNoun(
                            offer.deliveryDays,
                            "день",
                            "дня",
                            "дней",
                          )} по ${formatMoney(offer.pricePerKg)} ₽/кг`
                        : offer.canCover
                          ? `Может поставить ${formatMoney(
                              supplierPlan.supplierKg,
                            )} кг за ${formatMoney(
                              offer.deliveryDays,
                            )} ${countNoun(
                              offer.deliveryDays,
                              "день",
                              "дня",
                              "дней",
                            )} по ${formatMoney(offer.pricePerKg)} ₽/кг`
                          : `Доступно ${formatMoney(
                              offer.stockKg,
                            )} из нужных ${formatMoney(
                              supplierPlan.supplierKg,
                            )} кг`}
                    </span>
                    <small>Проверено {offer.stockCheckedAt}</small>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="supplier-condition">
            <strong>Что подтверждаем перед итоговым письмом</strong>
            <span>
              {supplierPlanConfirmed
                ? `Руководитель одобрил запрос. Поставщик подтверждает ${formatMoney(
                    supplierPlan.supplierKg,
                  )} кг, цену и срок. Технолог проверяет цвет и совместимость.`
                : `После решения руководителя поставщик подтвердит ${formatMoney(
                    supplierPlan.supplierKg,
                  )} кг, цену и срок. Технолог проверит цвет и совместимость.`}{" "}
              Перед итоговым письмом агент ещё раз сверит остаток.
            </span>
          </div>
          <small className="supplier-source-note">
            В учебной строке от {supplierPlan.stockCheckedAt} указано{" "}
            {formatMoney(supplierPlan.supplierStockKg)} кг. Рабочая система
            получит эти данные из подключённого прайса, кабинета поставщика
            или открытой страницы.
          </small>
        </section>
      )}

      {conversation.length > 0 && (
        <section className="conversation-flow" aria-labelledby="conversation-title">
          <div className="conversation-heading">
            <span>Этап переписки {order.roundNo ?? 1}</span>
            <h3 id="conversation-title">Переписка в одной карточке</h3>
          </div>
          <div>
            {earlierConversation.length > 0 && (
              <details className="conversation-archive">
                <summary>
                  Показать предыдущие {earlierConversation.length}{" "}
                  {countNoun(
                    earlierConversation.length,
                    "сообщение",
                    "сообщения",
                    "сообщений",
                  )}
                </summary>
                <div>
                  {earlierConversation.map((message, index) =>
                    renderConversationMessage(message, index),
                  )}
                </div>
              </details>
            )}
            {latestConversation.map((message, index) =>
              renderConversationMessage(
                message,
                index + earlierConversation.length,
              ),
            )}
          </div>
        </section>
      )}

      {order.managerDecision && (
        <div className="approval-stamp">
          <span>✓</span>
          <div>
            <small>Подтверждённый вариант</small>
            <strong>{humanizeText(order.managerDecision)}</strong>
          </div>
        </div>
      )}

      <div className="reply-card" id="reply-card">
        <div className="reply-head">
          <div>
            <span>
              {order.status === "awaiting_approval"
                ? "Следующий шаг"
                : "Ответ клиенту"}
            </span>
            <small>
              {order.status === "awaiting_approval"
                ? "Выбор руководителя"
                : "Запись в общий журнал"}
            </small>
          </div>
          <div
            className={`reply-status ${
              sent || (reserved && !inventoryChanged) ? "is-sent" : ""
            }`}
          >
            {sent
              ? "Отправка ответа записана"
              : inventoryChanged
                ? "Склад обновился · обновите черновик"
              : reserved
                ? "Резерв товара подготовлен"
              : waitingForCustomer
                ? "Вопросы записаны · ждём ответ клиента"
                : order.status === "clarification_ready"
                  ? "Вопросы готовы"
                : order.status === "awaiting_approval"
                ? "Руководитель выбирает вариант"
                : order.managerDecision
                  ? "Вариант подтверждён · подготовьте резерв товара"
                  : "Ответ проверен · подготовьте резерв товара"}
          </div>
        </div>
        {responsePrepared && (
          <ol className="reply-steps" aria-label="Путь ответа клиенту">
            <li
              className={responsePrepared ? "is-done" : "is-current"}
              aria-current={!responsePrepared ? "step" : undefined}
            >
              <span>1</span>
              <strong>Ответ готов</strong>
            </li>
            <li
              className={
                reservePrepared
                  ? "is-done"
                  : order.status === "ready_to_send"
                    ? "is-current"
                    : ""
              }
              aria-current={
                order.status === "ready_to_send" ? "step" : undefined
              }
            >
              <span>2</span>
              <strong>Резерв товара</strong>
            </li>
            <li
              className={sent ? "is-done" : reserved ? "is-current" : ""}
              aria-current={reserved ? "step" : undefined}
            >
              <span>3</span>
              <strong>Отправка</strong>
            </li>
          </ol>
        )}
        <strong className="reply-subject">
          {humanizeText(result.reply.subject)}
        </strong>
        <p>{humanizeText(result.reply.body)}</p>
        {canClarify && (
          <div className="reply-action">
            <button
              type="button"
              onClick={onSendClarification}
              disabled={clarifying}
            >
              {clarifying
                ? "Записываем вопросы…"
                : "Записать отправку вопросов"}
            </button>
            <small>
              Кнопка добавляет вопросы в общий журнал. В рабочей системе письмо
              уйдёт через почту компании.
            </small>
          </div>
        )}
        {canReserve && (
          <div className="reply-action">
            <button type="button" onClick={onReserve} disabled={reserving}>
              {reserving
                ? "Готовим резерв товара…"
                : "Подготовить резерв товара"}
            </button>
            <small>
              Стенд сохранит подготовленный резерв в журнале. Рабочая система
              передаст его в учётную систему компании.
            </small>
          </div>
        )}
        {canSend && (
          <div className="reply-action">
            <button type="button" onClick={onSend} disabled={sending}>
              {sending
                ? "Записываем отправку ответа…"
                : "Записать отправку ответа"}
            </button>
            <small>
              Кнопка добавляет письмо в общий журнал. В рабочей системе оно
              уйдёт через почту компании.
            </small>
          </div>
        )}
        {sent && (
          <div className="sent-note">
            Отправка ответа записана. Карточка вошла в результат дня.
          </div>
        )}
      </div>

      {waitingForCustomer && canManageOrder && (
        <form
          className="customer-reply-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onContinue();
          }}
        >
          <div className="customer-reply-intro">
            <span>Ответ клиента</span>
            <h3>Добавьте детали и продолжите ту же карточку</h3>
            <p>
              Агент объединит письмо, фото и ответ, рассчитает расход и снова
              проверит живой склад.
            </p>
          </div>
          <div className="customer-reply-editor">
            {showFloorReplyPresets && (
              <div className="customer-reply-presets">
                <span>Как используют помещение?</span>
                <div>
                  {floorReplyPresets.map((preset) => (
                    <button
                      type="button"
                      key={preset.label}
                      aria-pressed={customerAnswer === preset.answer}
                      onClick={() => onCustomerAnswerChange(preset.answer)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <small>
                  Текст появится ниже. Его можно дополнить перед продолжением
                  карточки.
                </small>
              </div>
            )}
            <label>
              <span className="sr-only">Текст ответа клиента</span>
              <textarea
                value={customerAnswer}
                onChange={(event) =>
                  onCustomerAnswerChange(event.target.value)
                }
                placeholder="Ответьте на вопрос агента своими словами — карточка продолжится под тем же номером."
                rows={4}
                required
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={continuing || customerAnswer.trim().length < 3}
          >
            {continuing
              ? "Агент дополняет карточку…"
              : "Передать ответ агенту"}
          </button>
        </form>
      )}

      <div className="checks-row">
        {checks.slice(0, 5).map((check) => (
          <span key={check}>✓ {check}</span>
        ))}
      </div>

      <div className="source-line">
        <span>Источники</span>
        {result.sources.map((source) => (
          <strong key={source}>{humanizeText(source)}</strong>
        ))}
        <small>
          {usesOpenCode(order.mode)
            ? `Заявку обрабатывает: ${modelLabel(order.agentModel)} · проверяет: ${modelLabel(order.reviewerModel)}`
            : "Автоматическая обработка по правилам и живому складу"}
        </small>
      </div>
    </div>
  );
}

function DecisionProofs({
  insights,
  bases,
}: {
  insights: string[];
  bases: AgentResult["decisionBasis"];
}) {
  const [activeProof, setActiveProof] = useState<string | null>(null);
  if (insights.length === 0) return null;

  const basisFor = (insight: string) => {
    if (/карточк[аи].*продолж|тем же номером/iu.test(insight)) {
      return (
        bases.find((basis) =>
          /карточк|истори.*переписк/iu.test(
            `${basis.fact} ${basis.source}`,
          ),
        ) ?? {
          fact:
            "Исходное письмо, вопросы и ответы клиента сохраняются под одним номером заявки.",
          source: "Карточка и история переписки",
          checkedAt: "во время этого расчёта",
        }
      );
    }

    const patterns =
      /ответ клиент|вопрос|подбор|расч[её]т|детал/i.test(insight)
          ? [/письмо клиента|расч[её]т|заявк/i]
          : /поставщик|рын|средн.*цен|цен.*(?:выше|ниже|близк)/i.test(insight)
            ? [/поставщик/i, /похож|рын|предложен/i]
            : /склад|остат|объ[её]м|поставк/i.test(insight)
              ? [/склад|остат|объ[её]м|поставк/i]
              : /цен|зарабатывает|прибыл/i.test(insight)
                ? [
                    /завод зарабатывает|карточк[аи] товара/i,
                    /цен/i,
                  ]
                : /правил|инструк|письм/i.test(insight)
                  ? [/три правила продаж/i, /правил|инструк|письм/i]
                  : [];

    for (const pattern of patterns) {
      const match = bases.find((basis) =>
        pattern.test(`${basis.fact} ${basis.source}`),
      );
      if (match) return match;
    }
    return undefined;
  };

  return (
    <section className="decision-proofs" aria-labelledby="proofs-title">
      <div className="proofs-heading">
        <div>
          <span>Решение можно проверить</span>
          <h3 id="proofs-title">Почему агент так решил</h3>
        </div>
        <p>
          Нажмите на пунктирную фразу. На компьютере её также можно открыть
          наведением — появятся факт, источник и время проверки.
        </p>
      </div>
      <div className="proofs-grid">
        {insights.map((insight) => {
          const basis = basisFor(insight);
          return (
            <details
              className="decision-proof"
              key={insight}
              open={activeProof === insight}
              onMouseEnter={() => setActiveProof(insight)}
              onMouseLeave={() => setActiveProof(null)}
              onFocus={() => setActiveProof(insight)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setActiveProof(null);
                }
              }}
              onToggle={(event) => {
                const isOpen = event.currentTarget.open;
                setActiveProof((current) =>
                  isOpen
                    ? insight
                    : current === insight
                      ? null
                      : current,
                );
              }}
            >
              <summary>
                <strong>{insight}</strong>
                <small>
                  Факт и источник <span aria-hidden="true">+</span>
                </small>
              </summary>
              <div>
                <p>
                  <span>Что подтверждает вывод</span>
                  {basis
                    ? humanizeText(basis.fact)
                    : "Агент сопоставил заявку, текущий остаток и правила продаж."}
                </p>
                <p>
                  <span>Откуда данные</span>
                  {basis?.source?.startsWith("http") ? (
                    <a href={basis.source} target="_blank" rel="noreferrer">
                      Открыть источник ↗
                    </a>
                  ) : basis && /поставщик/i.test(basis.source) ? (
                    <a href={sheetUrl} target="_blank" rel="noreferrer">
                      Открыть учебную таблицу цен ↗
                    </a>
                  ) : (
                    humanizeText(
                      basis?.source ??
                        "Заявка, живой склад и правила продаж",
                    )
                  )}
                </p>
                <small>
                  Когда проверено: {basis?.checkedAt || "во время этого расчёта"}
                  {basis?.stockVersion
                    ? ` · ${humanizeText(basis.stockVersion)}`
                    : ""}
                </small>
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function LiveInventoryPanel({
  inventory,
  market,
  selectedSku,
  stockValue,
  reason,
  selectedMarketId,
  marketStockValue,
  authenticated,
  adminCode,
  busy,
  marketBusy,
  message,
  error,
  marketMessage,
  marketError,
  onOpenCatalog,
  onSelectSku,
  onStockChange,
  onReasonChange,
  onSelectMarket,
  onMarketStockChange,
  onAdminCodeChange,
  onSignIn,
  onSignOut,
  onUpdate,
  onMarketUpdate,
}: {
  inventory: InventoryItem[];
  market: MarketOffer[];
  selectedSku: string;
  stockValue: string;
  reason: string;
  selectedMarketId: string;
  marketStockValue: string;
  authenticated: boolean;
  adminCode: string;
  busy: boolean;
  marketBusy: boolean;
  message: string;
  error: string;
  marketMessage: string;
  marketError: string;
  onOpenCatalog: () => void;
  onSelectSku: (sku: string) => void;
  onStockChange: (value: string) => void;
  onReasonChange: (value: string) => void;
  onSelectMarket: (id: string) => void;
  onMarketStockChange: (value: string) => void;
  onAdminCodeChange: (value: string) => void;
  onSignIn: (event: React.FormEvent) => Promise<void>;
  onSignOut: () => Promise<void>;
  onUpdate: (event: React.FormEvent) => Promise<void>;
  onMarketUpdate: (event: React.FormEvent) => Promise<void>;
}) {
  const selected = inventory.find((item) => item.sku === selectedSku);
  const selectedMarketOffer = market.find(
    (offer) => offer.id === selectedMarketId,
  );

  return (
    <section
      className="live-inventory"
      id="live-inventory"
      aria-labelledby="live-inventory-title"
    >
      <div className="live-inventory-intro">
        <p className="eyebrow">
          Ведущий меняет склад и остаток партнёра
        </p>
        <h2 id="live-inventory-title">
          Новый остаток сразу меняет решение по заказу
        </h2>
        <p>
          Новый остаток сразу появляется в открытой карточке. У ведущего
          пересчёт запускается сам, в другой вкладке участник запускает его
          одной кнопкой. Уменьшите остаток — агент принесёт руководителю
          готовые варианты и проверит недостающий объём у других поставщиков.
          Пополните склад — агент обновит решение и письмо. Обе версии
          сохранятся рядом.
        </p>
        <button type="button" onClick={onOpenCatalog}>
          Открыть каталог и весь склад
        </button>
      </div>

      <div className="live-stock-side">
        <div className="live-stock-strip" aria-label="Текущие остатки">
          {inventory.map((item) => (
            <button
              className={item.sku === selectedSku ? "is-selected" : ""}
              type="button"
              key={item.sku}
              onClick={() => onSelectSku(item.sku)}
              aria-pressed={item.sku === selectedSku}
            >
              <span>{item.name}</span>
              <strong>{formatMoney(item.stockKg)} кг</strong>
              <small>обновлено {formatDateTime(item.updatedAt)}</small>
            </button>
          ))}
          {inventory.length === 0 && (
            <div className="inventory-loading" role="status">
              Загружаем живой склад…
            </div>
          )}
        </div>

        <div className="presenter-console">
          <div className="console-head">
            <div>
              <span>Пульт ведущего</span>
              <strong>
                {authenticated
                  ? "Можно менять остаток"
                  : "Войдите по коду ведущего"}
              </strong>
            </div>
            {authenticated && (
              <button
                className="console-signout"
                type="button"
                onClick={() => void onSignOut()}
                disabled={busy || marketBusy}
              >
                Закрыть пульт
              </button>
            )}
          </div>

          {authenticated ? (
            <>
              <form className="inventory-form" onSubmit={onUpdate}>
                <label>
                  <span>Краска</span>
                  <select
                    value={selectedSku}
                    onChange={(event) => onSelectSku(event.target.value)}
                  >
                    {inventory.map((item) => (
                      <option key={item.sku} value={item.sku}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  {selected && (
                    <small>
                      Сейчас {formatMoney(selected.stockKg)} кг · обновлено{" "}
                      {formatDateTime(selected.updatedAt)}
                    </small>
                  )}
                </label>
                <label>
                  <span>Новый остаток, кг</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    inputMode="numeric"
                    value={stockValue}
                    onChange={(event) => onStockChange(event.target.value)}
                    required
                  />
                </label>
                {selectedSku === floorStockDemoSku && (
                  <div className="inventory-presets">
                    <span>После расчёта заказа ПРОТЕК нужно 620 кг</span>
                    <div>
                      <button
                        type="button"
                        onClick={() => {
                          onStockChange("420");
                          onReasonChange(
                            "Стартовый остаток для сценария ПРОТЕК",
                          );
                        }}
                      >
                        420 кг · агент принесёт варианты
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onStockChange("700");
                          onReasonChange(
                            "Поступила партия для большого заказа",
                          );
                        }}
                      >
                        700 кг · агент подготовит письмо
                      </button>
                    </div>
                  </div>
                )}
                {selectedSku === liveStockDemoSku && (
                  <div className="inventory-presets">
                    <span>Для первой заявки нужно 100 кг</span>
                    <div>
                      <button
                        type="button"
                        onClick={() => {
                          onStockChange("40");
                          onReasonChange(
                            "40 кг осталось после других заказов",
                          );
                        }}
                      >
                        40 кг · агент принесёт варианты
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onStockChange("180");
                          onReasonChange("Поступила новая партия");
                        }}
                      >
                        180 кг · агент подготовит письмо
                      </button>
                    </div>
                  </div>
                )}
                <label className="inventory-reason">
                  <span>Что произошло</span>
                  <input
                    value={reason}
                    onChange={(event) => onReasonChange(event.target.value)}
                    maxLength={180}
                    placeholder="Например: поступление на склад"
                    required
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy || inventory.length === 0}
                >
                  {busy ? "Обновляем склад…" : "Обновить остаток"}
                </button>
              </form>

              <section
                className="partner-console"
                aria-labelledby="partner-console-title"
              >
                <div className="partner-console-heading">
                  <div>
                    <span>Сценарий «Партнёр спасает заказ»</span>
                    <h3 id="partner-console-title">
                      Измените доступный объём у партнёра
                    </h3>
                  </div>
                  <p>
                    Агент пересоберёт вариант и письмо. Решение по поставке
                    останется за руководителем.
                  </p>
                </div>
                <form className="market-form" onSubmit={onMarketUpdate}>
                  <label>
                    <span>Партнёр</span>
                    <select
                      value={selectedMarketId}
                      onChange={(event) =>
                        onSelectMarket(event.target.value)
                      }
                    >
                      {market.map((offer) => (
                        <option key={offer.id} value={offer.id}>
                          {offer.competitor} · {offer.category}
                        </option>
                      ))}
                    </select>
                    {selectedMarketOffer && (
                      <small>
                        Сейчас{" "}
                        {formatMoney(selectedMarketOffer.stockKg)} кг ·
                        проверено{" "}
                        {selectedMarketOffer.stockCheckedAt ??
                          selectedMarketOffer.updatedAt ??
                          selectedMarketOffer.checkedAt ??
                          "в учебной таблице"}
                      </small>
                    )}
                  </label>
                  <label>
                    <span>Новый остаток, кг</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="numeric"
                      value={marketStockValue}
                      onChange={(event) =>
                        onMarketStockChange(event.target.value)
                      }
                      required
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={marketBusy || market.length === 0}
                  >
                    {marketBusy
                      ? "Пересчитываем заказ…"
                      : "Обновить партнёра"}
                  </button>
                  <div className="market-presets">
                    <span>
                      Для заказа ПРОТЕК партнёр добавляет 200 кг
                    </span>
                    <div>
                      <button
                        type="button"
                        onClick={() => onMarketStockChange("150")}
                      >
                        150 кг · объёма мало
                      </button>
                      <button
                        type="button"
                        onClick={() => onMarketStockChange("260")}
                      >
                        260 кг · объёма хватает
                      </button>
                    </div>
                  </div>
                </form>
                {market.length === 0 && (
                  <div className="market-loading" role="status">
                    Загружаем учебную таблицу партнёров…
                  </div>
                )}
                {marketMessage && (
                  <div className="inventory-message" role="status">
                    {marketMessage}
                  </div>
                )}
                {marketError && (
                  <div className="inventory-error" role="alert">
                    {marketError}
                  </div>
                )}
              </section>
            </>
          ) : (
            <form className="admin-login" onSubmit={onSignIn}>
              <label>
                <span>Код ведущего</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={adminCode}
                  onChange={(event) => onAdminCodeChange(event.target.value)}
                  required
                />
              </label>
              <button type="submit" disabled={busy || !adminCode.trim()}>
                {busy ? "Открываем пульт…" : "Открыть пульт"}
              </button>
            </form>
          )}

          {message && (
            <div className="inventory-message" role="status">
              {message}
            </div>
          )}
          {error && (
            <div className="inventory-error" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function LedgerTable({
  orders,
  events,
  inventoryChanges,
  resultHistory,
  inventory,
  onOpenOrder,
}: {
  orders: LedgerOrder[];
  events: NonNullable<LedgerResponse["events"]>;
  inventoryChanges: LedgerResponse["inventoryChanges"];
  resultHistory: NonNullable<LedgerResponse["resultHistory"]>;
  inventory: InventoryItem[];
  onOpenOrder: (id: string) => void;
}) {
  const [sheetCopyState, setSheetCopyState] = useState("");
  const ledgerSummary = useMemo(
    () => ({
      companies: new Set(
        orders.map((item) => item.company.trim()).filter(Boolean),
      ).size,
      orders: orders.length,
      inventoryChanges: inventoryChanges?.length ?? 0,
    }),
    [inventoryChanges, orders],
  );
  const activityRows = useMemo(() => {
    const companiesByOrderId = new Map(
      orders.map((item) => [
        item.id,
        item.company || "Частный покупатель",
      ]),
    );
    const eventActor = (stage: string, title: string) => {
      if (stage === "customer-reply") return "Клиент";
      if (["approval", "approve", "approved"].includes(stage)) {
        return "Руководитель";
      }
      if (["vision", "vision-result"].includes(stage)) {
        return "Модель для фотографий";
      }
      if (stage === "review-result") return "Модель проверки";
      if (stage === "review") {
        return /модел/iu.test(title)
          ? "Модель проверки"
          : "Программа проверки";
      }
      if (stage === "review-fallback") return "Программа проверки";
      if (
        [
          "received",
          "fallback",
          "retry",
          "error",
          "recalculate",
          "vision-fallback",
          "research-fallback",
          "primary-retry",
          "model",
        ].includes(stage)
      ) {
        return "Программа стенда";
      }
      return "Агент отдела продаж";
    };
    const eventKind = (stage: string) => {
      if (stage === "customer-reply") return "Ответ клиента";
      if (["approval", "approve", "approved"].includes(stage)) {
        return "Решение руководителя";
      }
      if (stage === "reserve") return "Резерв товара";
      if (stage === "sent" || stage === "clarification-sent") {
        return "Запись отправки";
      }
      if (stage === "recalculate") return "Пересчёт заказа";
      if (stage === "inventory") return "Проверка склада";
      if (stage === "market") return "Проверка цены";
      if (stage === "partner-stock") {
        return "Наличие у другого поставщика";
      }
      if (stage === "company-context") return "Сведения о компании";
      if (stage === "source-plan") return "Выбор данных";
      if (stage === "model") return "Выбор модели";
      if (["vision", "vision-result"].includes(stage)) {
        return "Осмотр фотографии";
      }
      if (stage === "vision-fallback") return "Вопросы по фотографии";
      if (["review", "review-result", "review-fallback"].includes(stage)) {
        return "Проверка ответа";
      }
      if (["research-fallback", "primary-retry"].includes(stage)) {
        return "Продолжение работы";
      }
      if (["research", "research-result"].includes(stage)) {
        return "Поиск сведений";
      }
      if (stage === "decision") return "Решение агента";
      return "Шаг карточки";
    };
    const rows = [
      ...orders.map((item) => ({
        id: `order:${item.id}`,
        createdAt: item.createdAt,
        kind: "Входящее письмо",
        actor: "Клиент",
        orderId: item.id,
        company: item.company || "Частный покупатель",
        title: item.company || "Частный покупатель",
        detail: item.subject,
        outcome: item.zone
          ? `${zoneCopy[item.zone].name} · ${statusLabel(item.status)}`
          : statusLabel(item.status),
      })),
      ...resultHistory.map((item) => ({
        id: `result:${item.id}`,
        createdAt: item.createdAt,
        kind: "Решение и письмо",
        actor: item.reason?.includes("руководител")
          ? "Руководитель"
          : [
                "Склад перечитан",
                "Поставщик перечитан",
                "Поставщик и склад перечитаны",
              ].includes(item.reason)
            ? "Программа стенда"
            : "Агент отдела продаж",
        orderId: item.orderId,
        company:
          companiesByOrderId.get(item.orderId) ?? "Частный покупатель",
        title: item.reason || "Агент сохранил решение",
        detail:
          item.replySubject ||
          `Черновик письма сохранён на этапе ${item.roundNo || 1}`,
        outcome:
          item.route === "manager"
            ? "Решает руководитель"
            : item.route === "needs_info"
              ? "Нужны детали"
              : "Готов ответить",
      })),
      ...events.map((item) => ({
        id: `event:${item.id}`,
        createdAt: item.createdAt,
        kind: eventKind(item.stage),
        actor: eventActor(item.stage, item.title),
        orderId: item.orderId,
        company:
          companiesByOrderId.get(item.orderId) ?? "Частный клиент",
        title: humanizeText(item.title),
        detail: humanizeText(item.detail),
        outcome: item.state === "error" ? "Можно запустить снова" : "Сохранено",
      })),
      ...(inventoryChanges ?? []).map((item) => ({
        id: `stock:${item.id}`,
        createdAt: item.createdAt,
        kind: "Живой склад",
        actor:
          item.actor === "sheets-sync" ? "Таблица склада" : "Ведущий",
        orderId: "",
        company: "Весь склад",
        title: `${
          inventory.find((paint) => paint.sku === item.sku)?.name ?? item.sku
        }: ${formatMoney(item.beforeStockKg)} → ${formatMoney(
          item.afterStockKg,
        )} кг`,
        detail: item.reason,
        outcome: "Склад обновлён",
      })),
    ];

    return rows
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt),
      )
      .slice(0, 30);
  }, [events, inventory, inventoryChanges, orders, resultHistory]);

  const copySheetConnection = async () => {
    const formula = `=IMPORTDATA("${publicSiteUrl}/api/ledger?format=csv")`;
    try {
      await navigator.clipboard.writeText(formula);
      setSheetCopyState(
        "Формула скопирована. Вставьте её в первую ячейку новой Google-таблицы.",
      );
    } catch {
      setSheetCopyState(
        `Вставьте формулу в первую ячейку новой Google-таблицы: ${formula}`,
      );
    }
  };

  return (
    <section className="ledger-block" aria-labelledby="ledger-title">
      <div className="ledger-heading">
        <div>
          <span>Живой журнал вебинара</span>
          <h3 id="ledger-title">Работа за сегодня в одной таблице</h3>
          <p>
            Обращение клиента, шаги агента, решения, черновики ответов и
            изменения склада попадают сюда сами. У строк заказа есть номер
            карточки — по нему открывается вся карточка. Изменения относятся
            ко всему складу.
          </p>
        </div>
        <div className="ledger-actions">
          <a href={sheetUrl} target="_blank" rel="noreferrer">
            Открыть таблицу вебинара в Google Таблицах ↗
          </a>
          <small>
            Лист «Заказы» получает весь журнал за день:
            заявки, действия, решения, письма, изменения склада и отправки.
          </small>
          <a href="/api/ledger?format=csv" download>
            Скачать журнал за сегодня
          </a>
          <details className="sheet-setup">
            <summary>Подключить свою таблицу</summary>
            <button type="button" onClick={() => void copySheetConnection()}>
              Скопировать формулу для Google Таблиц
            </button>
          </details>
        </div>
      </div>

      <div className="ledger-summary" aria-label="Итог живого журнала">
        <span>
          <strong>{ledgerSummary.companies}</strong>{" "}
          {countNoun(
            ledgerSummary.companies,
            "компания",
            "компании",
            "компаний",
          )}
        </span>
        <span>
          <strong>{ledgerSummary.orders}</strong>{" "}
          {countNoun(
            ledgerSummary.orders,
            "карточка",
            "карточки",
            "карточек",
          )}
        </span>
        <span>
          <strong>{ledgerSummary.inventoryChanges}</strong>{" "}
          {countNoun(
            ledgerSummary.inventoryChanges,
            "изменение склада",
            "изменения склада",
            "изменений склада",
          )}
        </span>
      </div>

      {sheetCopyState && (
        <div className="sheet-copy-note" role="status">
          {sheetCopyState}
        </div>
      )}

      <div className="ledger-table-wrap" tabIndex={0}>
        <table>
          <caption className="sr-only">
            Работа агента, руководителя и склада за сегодня
          </caption>
          <thead>
            <tr>
              <th scope="col">Когда</th>
              <th scope="col">Что произошло</th>
              <th scope="col">Заявка и компания</th>
              <th scope="col">Итог</th>
              <th scope="col">Детали</th>
            </tr>
          </thead>
          <tbody>
            {activityRows.map((item) => (
              <tr key={item.id}>
                <td>{formatDateTime(item.createdAt)}</td>
                <td>
                  <strong>{item.kind}</strong>
                  <small>{item.actor}</small>
                </td>
                <td>
                  {item.orderId ? (
                    <button
                      type="button"
                      onClick={() => onOpenOrder(item.orderId)}
                      aria-label={`Открыть заявку ${orderNumber(item.orderId)}`}
                    >
                      {orderNumber(item.orderId)}
                    </button>
                  ) : (
                    <span aria-label="Действие относится ко всему складу">
                      Весь склад
                    </span>
                  )}
                  <small>{item.company}</small>
                </td>
                <td>{item.outcome}</td>
                <td>
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </td>
              </tr>
            ))}
            {activityRows.length === 0 && (
              <tr>
                <td colSpan={5}>
                  Первая заявка и её шаги появятся здесь после отправки.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <small className="ledger-footnote">
        На экране — 30 последних действий. Полный журнал за день доступен по
        ссылке выше.
      </small>
    </section>
  );
}

function Modal({
  name,
  order,
  events,
  inventory,
  market,
  onClose,
}: {
  name: Exclude<ModalName, null>;
  order: OrderRecord | null;
  events: EventRow[];
  inventory: InventoryItem[];
  market: MarketOffer[];
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);

    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !sheetRef.current) return;

      const focusable = Array.from(
        sheetRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        sheetRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose]);

  const titles = {
    catalog: "Каталог и остатки",
    instructions: "Правила обработки заявок",
    order: "Заявка глазами агента",
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={sheetRef}
        className="modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <small>Колер · источник</small>
            <h2 id="modal-title">{titles[name]}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>

        {name === "catalog" && (
          <>
            <p className="modal-lead">
              Агент читает живые остатки перед каждым новым расчётом. Ведущий
              может изменить их во время показа. Карточка
              сохраняет краску, остаток и время расчёта, поэтому всегда видно,
              какой остаток учёл агент и почему выбрал этот шаг.
            </p>
                <div className="catalog-table">
              <div className="catalog-row catalog-header" aria-hidden="true">
                <span>Краска</span>
                <span>Назначение</span>
                <span>Остаток</span>
                <span>Цена</span>
                <span>Обновлён</span>
              </div>
              {demoData.products.map((product) => {
                const live = inventory.find(
                  (item) => item.sku === product.sku,
                );
                const whereToUse =
                  product.environment === "для улицы и помещения"
                    ? "на улице и в помещении"
                    : product.environment === "для улицы"
                      ? "на улице"
                      : product.environment === "для помещения"
                        ? "в помещении"
                        : product.environment;
                return (
                  <article className="catalog-row" key={product.sku}>
                    <div>
                      <small>{product.sku}</small>
                      <strong>{product.name}</strong>
                    </div>
                    <p>
                      Что можно красить: {product.substrates.join(", ")}. Где
                      использовать: {whereToUse}. Что важно:{" "}
                      {product.features.join(", ")}.
                    </p>
                    <div className="catalog-number">
                      <small>Остаток</small>
                      <strong>
                        {formatMoney(live?.stockKg ?? product.stockKg)} кг
                      </strong>
                    </div>
                    <div className="catalog-number">
                      <small>Цена</small>
                      <strong>{formatMoney(product.pricePerKg)} ₽/кг</strong>
                    </div>
                    <div className="catalog-number">
                      <small>Обновлён</small>
                      <strong>
                        {live
                          ? formatDateTime(live.updatedAt)
                          : "исходные данные"}
                      </strong>
                    </div>
                  </article>
                );
                  })}
                </div>
                <h3 className="catalog-subtitle">
                  Цены и наличие у других поставщиков
                </h3>
                <p className="catalog-caption">
                  Агент открывает эту часть таблицы, когда собственный склад
                  подтверждает только часть заказа.
                </p>
                <div className="catalog-table">
                  <div
                    className="catalog-row catalog-row-market catalog-header"
                    aria-hidden="true"
                  >
                    <span>Поставщик</span>
                    <span>Категория</span>
                    <span>Доступно</span>
                    <span>Цена</span>
                    <span>Срок</span>
                    <span>Проверено</span>
                  </div>
                  {market.map((item) => (
                    <article
                      className="catalog-row catalog-row-market"
                      key={`${item.category}-${item.competitor}`}
                    >
                      <div>
                        <small>Другой поставщик</small>
                        <strong>{item.competitor}</strong>
                      </div>
                      <p>{item.category}</p>
                      <div className="catalog-number">
                        <small>Доступно</small>
                        <strong>{formatMoney(item.stockKg)} кг</strong>
                      </div>
                      <div className="catalog-number">
                        <small>Цена</small>
                        <strong>{formatMoney(item.pricePerKg)} ₽/кг</strong>
                      </div>
                      <div className="catalog-number">
                        <small>Срок</small>
                        <strong>
                          {formatMoney(item.deliveryDays)}{" "}
                          {countNoun(
                            item.deliveryDays,
                            "день",
                            "дня",
                            "дней",
                          )}
                        </strong>
                      </div>
                      <div className="catalog-number">
                        <small>Проверено</small>
                        <strong>
                          {formatDateTime(
                            item.stockCheckedAt ??
                              item.updatedAt ??
                              item.checkedAt,
                          )}
                        </strong>
                      </div>
                    </article>
                  ))}
                  {market.length === 0 && (
                    <p className="catalog-empty" role="status">
                      Загружаем свежие цены и остатки партнёров…
                    </p>
                  )}
                </div>
                <a
              className="modal-primary-link"
              href={sheetUrl}
              target="_blank"
              rel="noreferrer"
            >
              Открыть товары и правила в Google Таблицах ↗
            </a>
          </>
        )}

        {name === "instructions" && (
          <>
            <p className="modal-lead">
              GPT-5.6 Sol подготовила правила и критерии проверки. Подключённая
              модель обрабатывает заказ по этим правилам. Автоматический режим
              применяет те же правила к живому складу.
            </p>
            <ol className="plain-rules">
              <li>
                <span>1</span>
                <p>Предлагаем объём, который подтверждает живой склад.</p>
              </li>
              <li>
                <span>2</span>
                <p>
                  По обычной цене завод зарабатывает на заказе. Особую цену
                  выбирает руководитель.
                </p>
              </li>
              <li>
                <span>3</span>
                <p>
                  Руководитель выбирает скидку, оплату после поставки, штраф за
                  задержку, условия конкурса поставщиков и срочной поставки.
                </p>
              </li>
            </ol>
            <details className="technical-instructions">
              <summary>Материалы для настройки системы</summary>
              <p>
                Эти файлы задают точный формат работы моделей. Они пригодятся
                команде, которая будет настраивать рабочую систему.
              </p>
              <div className="instruction-list">
                <a href="/prompts/sales-agent.md" target="_blank">
                  <span>01</span>
                  <div>
                    <strong>Модель обработки заказов</strong>
                    <small>
                      Письмо, источники, следующий шаг и готовое действие
                    </small>
                  </div>
                </a>
                <a href="/prompts/reviewer.md" target="_blank">
                  <span>02</span>
                  <div>
                    <strong>Модель проверки</strong>
                    <small>Факты, обещания и решения для руководителя</small>
                  </div>
                </a>
                <a href="/prompts/improver.md" target="_blank">
                  <span>03</span>
                  <div>
                    <strong>Команда улучшает правила по журналу</strong>
                    <small>
                      GPT-5.6 Sol предлагает правки, руководитель принимает
                      новую редакцию
                    </small>
                  </div>
                </a>
              </div>
            </details>
            <div className="instruction-rule">
              <strong>Что сохраняется в истории</strong>
              <p>
                Система сохраняет источники, проверенные числа, действия,
                решения и отправку. Команда видит понятные основания каждого
                вывода.
              </p>
            </div>
          </>
        )}

        {name === "order" && order && (
          <div className="agent-card-view">
            <div className="agent-card-meta">
              <article>
                <span>Заявка</span>
                <strong>{orderNumber(order.id)}</strong>
              </article>
              <article>
                <span>Состояние заявки</span>
                <strong>{statusLabel(order.status)}</strong>
              </article>
              <article>
                <span>Кто выполнил шаг</span>
                <strong>{modelLabel(order.agentModel ?? order.requestedModel)}</strong>
              </article>
              <article>
                <span>Как обработано</span>
                <strong>
                  {usesOpenCode(order.mode)
                    ? "Подключённая модель для заказов"
                    : "Автоматическая обработка по правилам и живому складу"}
                </strong>
              </article>
            </div>
            <article className="original-mail">
              <span>Исходное письмо</span>
              <strong>{order.subject}</strong>
              <p>{order.body}</p>
              <small>
                {order.company}
                {order.website ? ` · ${order.website}` : ""}
              </small>
            </article>
            {attachmentFromOrder(order) && (
              <figure className="agent-attachment">
                <Image
                  src={attachmentFromOrder(order)?.src ?? "/fence-demo.jpg"}
                  alt={attachmentFromOrder(order)?.alt ?? "Фото из заявки"}
                  width={1200}
                  height={800}
                  sizes="(max-width: 720px) 100vw, 760px"
                  unoptimized
                />
                <figcaption>
                  <strong>{attachmentFromOrder(order)?.name}</strong>
                  <span>
                    {usesOpenCode(order.mode)
                      ? "Модель для фото описала видимые детали. Агент использует это наблюдение и просит подтвердить материал и размеры."
                      : "Фото сохранено в карточке. Агент просит подтвердить материал и размеры."}
                  </span>
                </figcaption>
              </figure>
            )}
            {order.result && (
              <div className="agent-facts">
                <article>
                  <span>Что понял агент</span>
                  {order.result.understood.map((item) => (
                    <strong key={item}>{humanizeText(item)}</strong>
                  ))}
                </article>
                <article>
                  <span>Что делать дальше</span>
                  <strong>{zoneCopy[order.result.zone].name}</strong>
                  <p>{humanizeText(order.result.zoneReason)}</p>
                </article>
                <article>
                  <span>Источники</span>
                  <p>{order.result.sources.map(humanizeText).join(" · ")}</p>
                </article>
              </div>
            )}
            {Array.isArray(order.conversation) &&
              order.conversation.length > 0 && (
                <div className="agent-conversation">
                  <span>
                    Переписка · этап {order.roundNo ?? 1}
                  </span>
                  {order.conversation.map((message, index) => (
                    <article
                      key={`${message.createdAt ?? message.at ?? "turn"}-${index}`}
                    >
                      <strong>
                        {message.role === "customer" ? "Клиент" : "Агент"}
                      </strong>
                      <p>{humanizeText(message.body ?? message.text ?? "")}</p>
                    </article>
                  ))}
                </div>
              )}
            <div className="agent-log">
              <span>Журнал действий</span>
              {events.map((event) => (
                <div key={event.id}>
                  <time>{formatEventTime(event.createdAt)}</time>
                  <strong>{humanizeText(event.title)}</strong>
                  <p>{humanizeText(event.detail)}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
