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
  explicitSkuFromText,
  hasColor,
  hasSpecialTerms,
  hasUsableEnvironment,
  matchProduct,
  quantityFromText,
} from "@/lib/order-facts.mjs";
import { productInventoryChanged } from "@/lib/inventory-freshness.mjs";

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
  "https://docs.google.com/spreadsheets/d/1gabC2L8HOihMzPpp6pDeoMDtqXN9cEoGxwV-Al3PaYY/edit";
const publicSiteUrl = "https://koler-agent-demo.odinmaniac.chatgpt.site";
const liveStockDemoSku = "КР-005";
const maxPhotoSizeMb = 8;
const orderActionKeyStoragePrefix = "koler-order-key:";
const fenceDemoAnswer =
  "Забор деревянный, длина 25 м, высота 1,8 м. Красим с двух сторон, цвет коричневый.";

function answerForScenario(scenario: DemoScenario) {
  return scenario.demoKind === "fence-photo" ? fenceDemoAnswer : "";
}

const zoneCopy = {
  green: {
    name: "Готов ответить",
    color: "Полный ответ",
    short: "Агент готовит письмо",
    description:
      "Товар подобран, склад подтверждает весь объём, по этой цене завод зарабатывает на заказе.",
    next: "Проверьте черновик и отправьте клиенту.",
  },
  yellow: {
    name: "Нужны детали",
    color: "Точное уточнение",
    short: "Агент задаёт точные вопросы",
    description:
      "Агент собрал известное и просит только те данные, которые меняют подбор или расчёт.",
    next: "Отправьте вопросы и продолжите ту же карточку после ответа.",
  },
  red: {
    name: "Решает руководитель",
    color: "Выбор руководителя",
    short: "Агент приносит варианты",
    description:
      "Для скидки, оплаты после поставки, поставки частями и срочного срока агент готовит выполнимые варианты.",
    next: "Выберите один вариант и отправьте готовое письмо.",
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
      /цена\s+([\d\s]+)\s*₽\/кг\s+в\s+пределах\s+minPricePerKg\s+([\d\s]+)\s*₽\/кг\s*[—-]\s*нарушени[яй]\s+нет/giu,
      (_, price: string, floor: string) =>
        `Цена ${price.trim()} ₽/кг выше минимальной цены с прибылью ${floor.trim()} ₽/кг. Завод зарабатывает на заказе`,
    )
    .replaceAll(
      "minPricePerKg",
      "минимальная цена с прибылью",
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
    .replace(/нарушени[ея]/gi, "особое условие")
    .replace(
      /минимальн(?:ая|ой|ую)\s+(?:границ[аы]|цен[аы])/gi,
      "минимальная цена, при которой заказ остаётся прибыльным",
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
      "Ответ отправлен на стенде",
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
    "Склад показывает объём для первого шага",
    "Агент подготовил варианты для руководителя",
    ...checks,
  ].filter((item, index, rows) => rows.indexOf(item) === index);
}

function optionBusinessResult(
  option: AgentResult["options"][number],
  result: AgentResult,
) {
  const key = `${option.id} ${option.title}`.toLocaleLowerCase("ru-RU");
  if (/оплата-до-отгрузки/.test(key)) {
    return "Завод получает оплату до отгрузки и сохраняет обычную прибыль.";
  }
  if (/оплата-за-план/.test(key)) {
    return "Завод получает план закупок и заранее готовит нужный объём.";
  }
  if (/оплата-поэтапно/.test(key)) {
    return "Завод получает часть денег до отгрузки и меньше ждёт оплату.";
  }
  if (/замен|alternative|аналог/.test(key)) {
    return "Завод закрывает весь заказ товаром, который уже есть на складе.";
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
    ? `Завод сохраняет цену ${formatMoney(
        result.product.pricePerKg,
      )} ₽/кг и обычную прибыль.`
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

  if (
    draft.demoKind === "fence-photo" ||
    Boolean(draft.attachment) ||
    /забор|прикладываю фото|на фото/i.test(text)
  ) {
    return {
      zone: "yellow",
      label: "Похоже: нужны детали",
      reason:
        "Фото помогает начать подбор. Агент спросит материал и размеры, затем сам рассчитает килограммы.",
    } as const;
  }

  const quantity = quantityFromText(text);
  const product = matchProduct(text, demoData.products);
  const liveProduct = product
    ? inventory.find((item) => item.sku === product.sku)
    : null;
  const availableKg = liveProduct?.stockKg ?? product?.stockKg ?? 0;
  const hasUnknownSku = Boolean(explicitSkuFromText(text)) && !product;
  const special = hasSpecialTerms(text);

  if (special || (product && quantity > availableKg)) {
    return {
      zone: "red",
      label: "Похоже: решает руководитель",
      reason: special
        ? "В письме есть условие, для которого агент подготовит варианты."
        : `Склад подтверждает ${formatMoney(availableKg)} кг сейчас. Агент предложит способ закрыть остальной объём.`,
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
  if (!quantity) missing.push("агент рассчитает или уточнит количество");
  if (!hasUsableEnvironment(text)) {
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
      label: "Похоже: нужны детали",
      reason: missing.slice(0, 2).join(" · "),
    } as const;
  }

  return {
    zone: "green",
    label: "Похоже: готов ответить",
    reason: "Краска, объём, место работ и цвет уже указаны.",
  } as const;
}

function modelLabel(id?: string | null) {
  if (id === "Готовая инструкция") return "Программа стенда";
  return (
    modelCatalog.options.find((model) => model.id === id)?.label ??
    (id ? "Подключённая модель" : "—")
  );
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
      clarification_ready: "Вопросы готовы к отправке",
      awaiting_customer: "Ожидаем ответ клиента",
      awaiting_approval: "Руководитель выбирает вариант",
      ready_to_send: "Ответ готов к отправке",
      completed: "Ответ готов к отправке",
      sent: "Отправлено на стенде",
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
  const [ledger, setLedger] = useState<LedgerResponse>({});
  const [bridgeOnline, setBridgeOnline] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState("");
  const [sending, setSending] = useState(false);
  const [clarifying, setClarifying] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
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
  const [modal, setModal] = useState<ModalName>(null);
  const [error, setError] = useState("");
  const inventoryLoadedRef = useRef(false);
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

  const loadOrder = useCallback(async (id: string) => {
    const response = await fetch(`/api/orders?id=${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    if (!response.ok) return;
    const data = (await response.json()) as {
      order: OrderRecord;
      events: EventRow[];
      resultHistory?: ResultHistoryEntry[];
    };
    setOrder(data.order);
    setEvents(data.events);
    setOrderResultHistory(data.resultHistory ?? []);
  }, []);

  useEffect(() => {
    const refreshSharedState = () => {
      if (document.visibilityState !== "visible") return;
      void loadSystem();
      void loadStats();
      void loadInventory();
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
  }, [loadAdmin, loadInventory, loadLedger, loadStats, loadSystem]);

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
    setDraft(group.examples[0]);
    setCustomerAnswer(answerForScenario(group.examples[0]));
    setPhotoMessage("");
    setPhotoError("");
    setError("");
  };

  const nextScenario = () => {
    const group = scenarioGroups.find((item) => item.id === scenarioGroup);
    if (!group) return;
    const next = (scenarioIndex + 1) % group.examples.length;
    setScenarioIndex(next);
    setDraft(group.examples[next]);
    setCustomerAnswer(answerForScenario(group.examples[next]));
    setPhotoMessage("");
    setPhotoError("");
    setError("");
  };

  const uploadPhoto = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    setPhotoMessage("");
    setPhotoError("");

    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setPhotoError("Выберите фотографию JPEG, PNG или WebP.");
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
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(
          data.error ?? "Обновите карточку и выберите вариант снова.",
        );
      }
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
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(
          data.error ?? "Обновите карточку и повторите отправку на стенде.",
        );
      }
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
      await loadOrder(orderId);
      await Promise.all([loadStats(), loadLedger(), loadInventory()]);
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

  const signInAdmin = async (event: React.FormEvent) => {
    event.preventDefault();
    setAdminBusy(true);
    setInventoryError("");
    setInventoryMessage("");
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
    try {
      await fetch("/api/admin", { method: "DELETE" });
      setAdminAuthenticated(false);
      setInventoryMessage("Пульт ведущего закрыт.");
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
        order?.result?.product?.sku === item.sku;

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
          `Остаток изменился: ${formatMoney(item.stockKg)} → ${formatMoney(data.item.stockKg)} кг. Агент пересчитал заказ, новое решение и письмо сохранились в истории.`,
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

  const openLedgerOrder = (id: string) => {
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
    setOrderId("");
    setOrderActionKey("");
    setOrder(null);
    setEvents([]);
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
    if (order?.status === "ready_to_send") return 96;
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
        <div className={`connection ${bridgeOnline ? "is-live" : ""}`}>
          <span className="connection-dot" aria-hidden="true" />
          <span>
            {bridgeOnline
              ? "Модель для заказов подключена"
              : "Считает программа стенда по живому складу"}
          </span>
        </div>
        <a className="topbar-link" href="#day-result">
          Результат дня
        </a>
      </header>

      <main id="top">
        <section className="story-hero" aria-labelledby="main-title">
          <div className="hero-intro">
            <p className="eyebrow">Живой путь одного заказа</p>
            <h1 id="main-title">
              Клиент пишет своими словами. Агент ведёт заказ до ответа
            </h1>
            <p className="hero-lead">
              На стенде заявку создаёт форма ниже. В рабочей системе цепочку
              запускает письмо клиента. Система понимает задачу, проверяет
              живой склад и цены других поставщиков, собирает сведения о
              компании, предлагает следующий шаг и сохраняет всю работу. В
              живом режиме модели сами изучают фото и открывают источники.
            </p>
          </div>

          <div className="hero-status">
            <span>Кто за что отвечает</span>
            <ul className="hero-roles">
              <li>
                <strong>
                  {bridgeOnline
                    ? "Недорогая модель ведёт заказ"
                    : "Программа рассчитывает заявку по подготовленным правилам"}
                </strong>
                <small>
                  {bridgeOnline
                    ? "Читает письмо, выбирает источники и готовит ответ."
                    : "Программа применяет те же правила к живому складу и заявке."}
                </small>
              </li>
              <li>
                <strong>Модель для фото подключается отдельно</strong>
                <small>
                  В живом режиме описывает видимые детали. Материал подтверждает
                  клиент.
                </small>
              </li>
              <li>
                <strong>Сильная модель задала правила работы</strong>
                <small>
                  Заранее написала инструкцию для недорогой модели. После показа
                  команда передаст ей журнал и получит предложения по правкам.
                </small>
              </li>
              <li>
                <strong>Программа держит факты</strong>
                <small>
                  Сверяет цены и остатки, передаёт особые условия руководителю.
                </small>
              </li>
              <li>
                <strong>Руководитель подтверждает обязательства</strong>
                <small>
                  При скидке, оплате после поставки или нехватке выбирает один
                  подготовленный вариант и открывает отправку письма.
                </small>
              </li>
            </ul>
            <details className="technical-layer">
              <summary>Как стенд запущен сейчас</summary>
              <p>
                {bridgeOnline
                  ? "На компьютере ведущего программа OpenCode запускает выбранную модель. База хранит карточки и журнал."
                  : "Стенд выполняет тот же путь по готовой инструкции и живым данным. При необходимости ведущий подключает OpenCode — программу для запуска выбранной модели."}{" "}
                Корпоративная версия получает и отправляет письма через почтовый
                ящик компании.
              </p>
            </details>
          </div>

          <div className="system-map" aria-label="Путь заказа">
            <article>
              <span>01</span>
              <strong>Письмо или фото</strong>
              <small>Клиент описывает задачу своими словами</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>02</span>
              <strong>Понимание задачи</strong>
              <small>Текст и фото превращаются в факты и вопросы</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>03</span>
              <strong>Проверенные данные</strong>
              <small>Каталог, остаток и цены других поставщиков</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>04</span>
              <strong>Сведения о клиенте</strong>
              <small>Что производит компания и зачем ей краска</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>05</span>
              <strong>Что делать дальше</strong>
              <small>Ответ, уточнение или решение руководителя</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>06</span>
              <strong>Действие</strong>
              <small>Готовое письмо или выполнимые варианты</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>07</span>
              <strong>Журнал всех заказов</strong>
              <small>Заказ, действия и результат доступны команде</small>
            </article>
          </div>

          <div className="source-dock" aria-label="Источники и правила стенда">
            <a href={sheetUrl} target="_blank" rel="noreferrer">
              <span>Одна живая таблица</span>
              Товары, правила и вся работа за день
            </a>
              <button type="button" onClick={() => setModal("catalog")}>
                <span>Живой склад</span>
                Остаток меняется — черновик пересчитывается
            </button>
            <button type="button" onClick={() => setModal("instructions")}>
              <span>Три правила</span>
              Инструкция сильной модели
            </button>
            <a href="#day-result">
              <span>Результат дня</span>
              Заявки, решения и отправки
            </a>
          </div>

          <details className="zone-guide">
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
            <h2>Передайте первую заявку агенту</h2>
          </div>
          <p>
            На стенде заявку создаёт форма: выберите готовый пример и передайте
            его агенту. В наборе «Нужны детали» фотография забора уже
            приложена. В рабочей системе карточку создаёт письмо из ящика
            компании.
          </p>
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
                  value={scenarioGroup}
                  onChange={(event) =>
                    selectScenarioGroup(event.target.value as ScenarioZone)
                  }
                >
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
                <span>Готовый пример</span>
              </div>

              <div className="mail-line">
                <span>На стенде</span>
                <strong>Демонстрационная заявка</strong>
              </div>
              <label className="mail-field">
                <span>Компания</span>
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
                <span>Сайт</span>
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
                      ? "Добавьте фото забора, стены или пола. Модель для фото опишет видимые детали, агент уточнит материал и размеры, подберёт краску и посчитает килограммы."
                      : "Добавьте фото забора, стены или пола. Агент сохранит его в карточке, уточнит материал и размеры, подберёт краску и посчитает килограммы."}
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
                    Фотография до {maxPhotoSizeMb} МБ · без людей, документов и
                    адресов
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
                          ? "Недорогая модель опишет, что видно на снимке. Из чего сделан объект, его размеры и стороны покраски подтвердит клиент."
                          : "Фото сохранится в карточке. Агент задаст вопросы о материале, размерах и сторонах покраски."}
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
                <label>
                  <span>Модель для ежедневных заказов</span>
                  <select
                    value={selectedModel}
                    onChange={(event) => setSelectedModel(event.target.value)}
                    disabled={!bridgeOnline}
                  >
                    {modelCatalog.options.map((model) => (
                      <option value={model.id} key={model.id}>
                        {model.label} · {model.note}
                      </option>
                    ))}
                  </select>
                </label>
                <small>
                  {bridgeOnline
                    ? "Выбранная недорогая модель выполнит инструкцию, которую подготовила и проверила сильная модель."
                    : "Сейчас программа рассчитывает заявку по подготовленным правилам. После подключения ведущий выбирает модель для заказов."}
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
                  <h2>Здесь появится дело клиента</h2>
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
                    <small>Каталог, живой остаток и цены других поставщиков</small>
                  </li>
                  <li>
                    <span aria-hidden="true">•</span>
                    <strong>Сведения о клиенте</strong>
                    <small>
                      {bridgeOnline
                        ? "Модель для заказов проверяет сайт, ИНН и открытые источники"
                        : "Подготовленный пример показывает три заранее проверенных источника"}
                    </small>
                  </li>
                  <li>
                    <span aria-hidden="true">•</span>
                    <strong>Проверка решения</strong>
                    <small>
                      {bridgeOnline
                        ? "Сильная модель проверяет факты и обещания, затем отмечает решения для руководителя"
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
                      Заявка {orderNumber(orderId)} ↗
                    </button>
                    <h2>{order?.subject ?? "Принимаем заказ…"}</h2>
                    <small>
                      {order?.company || "Частный клиент"} ·{" "}
                      этап переписки {order?.roundNo ?? 1} ·{" "}
                      {order?.mode === "opencode-live"
                        ? modelLabel(
                            order?.agentModel ??
                              order?.requestedModel ??
                              selectedModel,
                          )
                        : "Расчёт по готовой инструкции"}
                    </small>
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
                  aria-label="Готовность карточки"
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
                        Письмо и журнал сохранены. Запустите карточку ещё раз.
                      </p>
                    </div>
                    <button type="button" onClick={reset}>
                      Вернуться к письму
                    </button>
                  </div>
                )}

                {result && order && (
                  <ResultPanel
                    key={order.id}
                    result={result}
                    order={order}
                    approving={approving}
                    sending={sending}
                    clarifying={clarifying}
                    continuing={continuing}
                    recalculating={recalculating}
                    customerAnswer={customerAnswer}
                    inventory={inventory}
                    resultHistory={orderResultHistory}
                    canManageOrder={
                      Boolean(orderActionKey) || adminAuthenticated
                    }
                    onApprove={approve}
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
                ? "Как недорогая модель ведёт заказ"
                : "Как программа ведёт заказ по готовым правилам"}
            </p>
            <h2>
              {bridgeOnline
                ? "Инструкция, сильная проверка и программа отвечают за качество"
                : "Готовые правила, точные факты и журнал отвечают за качество"}
            </h2>
            <p>
              {bridgeOnline
                ? "Недорогая модель выполняет понятную инструкцию. Сильная модель проверяет факты и обещания, затем отмечает решения для руководителя. Программа подтверждает цены и остатки перед каждым действием."
                : "Сейчас программа читает заявку, сверяет склад и собирает ответ по подготовленным правилам. OpenCode подключает модель для заказов и сильную проверку."}
            </p>
          </div>
          <div className="control-grid">
            <article>
              <span>Ежедневная работа</span>
              <strong>
                {bridgeOnline
                  ? "Недорогая модель ведёт заказ"
                  : "Программа выполняет готовую инструкцию"}
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
              <strong>Сильная модель готовит правила</strong>
              <p>
                {bridgeOnline
                  ? "GPT-5.6 Sol подготовила инструкцию и критерии проверки. В подключённом режиме сильная модель проверяет факты и обещания каждого ответа. После показа команда передаст ей журнал и рассмотрит предложения по правилам."
                  : "GPT-5.6 Sol заранее подготовила инструкцию и критерии проверки. После показа команда передаст ей журнал всех заказов и рассмотрит предложения по правилам."}
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
          selectedSku={inventorySku}
          stockValue={inventoryStock}
          reason={inventoryReason}
          authenticated={adminAuthenticated}
          adminCode={adminCode}
          busy={adminBusy}
          message={inventoryMessage}
          error={inventoryError}
          onOpenCatalog={() => setModal("catalog")}
          onSelectSku={selectInventoryItem}
          onStockChange={setInventoryStock}
          onReasonChange={setInventoryReason}
          onAdminCodeChange={setAdminCode}
          onSignIn={signInAdmin}
          onSignOut={signOutAdmin}
          onUpdate={updateInventory}
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
              <span>Завершено</span>
              <strong>{stats.completed}</strong>
              <small>ответ подготовлен</small>
            </article>
            <article>
              <span>Согласование</span>
              <strong>{stats.awaitingApproval}</strong>
              <small>ждут решения</small>
            </article>
            <article>
              <span>Ждут клиента</span>
              <strong>{stats.awaitingCustomer}</strong>
              <small>вопросы уже готовы или отправлены</small>
            </article>
            <article>
              <span>Отправлено на стенде</span>
              <strong>{stats.sent}</strong>
              <small>зафиксировано в журнале</small>
            </article>
          </div>
          <div className="zone-totals">
            <span>
              <i className="zone-green" /> Готовы ответить: {stats.zones.green}
            </span>
            <span>
              <i className="zone-yellow" /> Нужны детали: {stats.zones.yellow}
            </span>
            <span>
              <i className="zone-red" /> Решает руководитель: {stats.zones.red}
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
  sending,
  clarifying,
  continuing,
  recalculating,
  customerAnswer,
  inventory,
  resultHistory,
  canManageOrder,
  onApprove,
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
  sending: boolean;
  clarifying: boolean;
  continuing: boolean;
  recalculating: boolean;
  customerAnswer: string;
  inventory: InventoryItem[];
  resultHistory: ResultHistoryEntry[];
  canManageOrder: boolean;
  onApprove: (id: string) => Promise<void>;
  onSend: () => Promise<void>;
  onSendClarification: () => Promise<void>;
  onContinue: () => Promise<void>;
  onRecalculate: () => Promise<void>;
  onCustomerAnswerChange: (value: string) => void;
  onOpenCatalog: () => void;
}) {
  const [selectedOption, setSelectedOption] = useState("");
  const [inventoryTransition, setInventoryTransition] = useState<{
    beforeStockKg: number;
    afterStockKg: number;
    beforeZone: ScenarioZone;
    beforeReason: string;
    afterRevision: number;
  } | null>(null);
  const zone = zoneCopy[result.zone];
  const sent = order.status === "sent";
  const savedItem = result.product
    ? snapshotItems(order.inventorySnapshot).find(
        (item) => item.sku === result.product?.sku,
      )
    : null;
  const liveItem = result.product
    ? inventory.find((item) => item.sku === result.product?.sku)
    : null;
  const savedRevision = savedItem?.revision ?? savedItem?.stockRevision;
  const inventoryChanged =
    inventory.length > 0 &&
    productInventoryChanged(order.inventorySnapshot, result, inventory);
  const actionableInventoryChange = inventoryChanged && !sent;
  const canClarify =
    canManageOrder &&
    result.route === "needs_info" &&
    order.status === "clarification_ready";
  const waitingForCustomer = order.status === "awaiting_customer";
  const canSend =
    canManageOrder &&
    order.status === "ready_to_send" &&
    result.route !== "needs_info" &&
    !inventoryChanged;
  const checks = positiveChecks(result);
  const insights = [
    result.market.checked
      ? result.market.position
      : "Ответ клиента даст точный подбор и расчёт",
    ...checks,
  ]
    .map((item) => humanizeText(item ?? ""))
    .filter((item, index, rows) => item && rows.indexOf(item) === index)
    .slice(0, 4);
  const conversation = Array.isArray(order.conversation)
    ? order.conversation
    : [];
  const transitionComplete = Boolean(
    inventoryTransition &&
      savedItem &&
      savedItem.stockKg === inventoryTransition.afterStockKg &&
      Number(savedRevision) === inventoryTransition.afterRevision,
  );
  const savedRecalculation = (() => {
    for (let index = resultHistory.length - 1; index > 0; index -= 1) {
      if (resultHistory[index].reason === "Склад перечитан") {
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
  const persistedTransition =
    savedRecalculation &&
    savedRecalculation.after.id === resultHistory.at(-1)?.id
      ? {
          beforeStock:
            savedRecalculation.before.result?.product?.stockKg != null
              ? `${formatMoney(
                  savedRecalculation.before.result.product.stockKg,
                )} кг`
              : stockFromReason(savedRecalculation.before.zoneReason) ||
                "остаток сохранён в журнале",
          afterStock:
            savedRecalculation.after.result?.product?.stockKg != null
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
        }
      : null);
  const recalculateWithComparison = async () => {
    if (savedItem && liveItem) {
      setInventoryTransition({
        beforeStockKg: savedItem.stockKg,
        afterStockKg: liveItem.stockKg,
        beforeZone: result.zone,
        beforeReason: result.zoneReason,
        afterRevision: liveItem.revision,
      });
    }
    await onRecalculate();
  };

  return (
    <div className="result-panel">
      {actionableInventoryChange && savedItem && liveItem && (
        <section
          className="freshness-banner"
          id="current-order-refresh"
          role="status"
          tabIndex={-1}
        >
          <div>
            <span>Живой склад обновлён</span>
            <strong>
              Было {formatMoney(savedItem.stockKg)} кг. Сейчас на складе{" "}
              {formatMoney(liveItem.stockKg)} кг.
            </strong>
            <small>
              Новый остаток уже виден. Обновите черновик, чтобы сравнить новое
              решение с прежним.
            </small>
          </div>
          <button
            type="button"
            onClick={() => void recalculateWithComparison()}
            disabled={recalculating || !canManageOrder}
          >
            {recalculating
              ? "Обновляем черновик…"
              : "Обновить черновик по новому остатку"}
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
            <strong>Один новый факт изменил следующий шаг и письмо</strong>
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
          <small>
            Во время пересчёта согласование и отправка оставались закрытыми.
            Обе версии сохранились в карточке и журнале. Теперь письмо ждёт
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
                result.route === "ready" && !result.research?.checked
                  ? "Проверьте готовое письмо и отправьте его клиенту."
                  : result.managerNote,
              )}
            </p>
          </article>
          <article>
            <span>Как увеличить прибыль</span>
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

      <DecisionProofs
        insights={insights}
        bases={result.decisionBasis ?? []}
      />

      {result.research &&
        (result.research.checked || result.research.sources.length > 0) && (
          <div className="research-card">
            <div className="research-confirmed">
              <span>Проверено по источникам</span>
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
                <span>Гипотеза агента</span>
                <p>{researchHypothesis(result)}</p>
                <small>
                  Агент предлагает вопрос, который подтвердит или уточнит
                  гипотезу. Руководитель принимает решение по фактам и ответу
                  клиента.
                </small>
              </div>
            )}
            {order.mode !== "opencode-live" && (
              <small className="research-mode-note">
                В демонстрации карточка показывает заранее проверенные
                источники. Подключённая модель для заказов открывает страницы и
                сохраняет ссылки сама.
              </small>
            )}
          </div>
        )}

      {result.calculation && (
        <section className="calculation-card">
          <div className="calculation-heading">
            <span>Агент сам рассчитал количество</span>
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
            <span>
              {result.calculation.lengthM} × {result.calculation.heightM} м
            </span>
            <i aria-hidden="true">→</i>
            <span>
              {result.calculation.sides === 2
                ? "две стороны"
                : "одна сторона"}
            </span>
            <i aria-hidden="true">→</i>
            <span>{formatMoney(result.calculation.paintAreaM2)} м²</span>
            <i aria-hidden="true">→</i>
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
            <span>На складе</span>
            <strong>{formatMoney(result.product.stockKg)} кг</strong>
            <small>
              Остаток учтён {formatDateTime(savedItem?.updatedAt)}
            </small>
          </div>
          <div>
            <span>Предложение</span>
            <strong>{formatMoney(result.product.pricePerKg)} ₽/кг</strong>
          </div>
          <div>
            <span>Сумма</span>
            <strong>
              {result.product.requestedKg
                ? `${formatMoney(result.product.total)} ₽`
                : "После уточнения"}
            </strong>
          </div>
        </div>
      )}

      {conversation.length > 0 && (
        <section className="conversation-flow" aria-labelledby="conversation-title">
          <div className="conversation-heading">
            <span>Этап переписки {order.roundNo ?? 1}</span>
            <h3 id="conversation-title">Переписка в одной карточке</h3>
          </div>
          <div>
            {conversation.map((message, index) => {
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
                  <time>
                    {formatDateTime(message.createdAt ?? message.at)}
                  </time>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {result.options.length > 0 && !order.managerDecision && (
        <div className="manager-block">
          <div className="manager-heading">
            <span>Решение</span>
            <div>
              <small>Решение руководителя на стенде</small>
              <h3>Выберите один способ сохранить клиента</h3>
            </div>
          </div>
          <p className="manager-note">
            Агент приложил сведения о клиенте, пользу для клиента, результат
            для завода и готовое письмо к каждому варианту.
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
                  selectedOption === option.id ? "is-selected" : ""
                }`}
                key={option.id}
              >
                <input
                  type="radio"
                  name={`decision-${order.id}`}
                  value={option.id}
                  checked={selectedOption === option.id}
                  onChange={() => setSelectedOption(option.id)}
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
          <button
            className="approve-button"
            type="button"
            onClick={() => onApprove(selectedOption)}
            disabled={
              !selectedOption ||
              Boolean(approving) ||
              inventoryChanged ||
              !canManageOrder
            }
          >
            {approving ? "Согласуем решение…" : "Согласовать выбранный вариант"}
          </button>
        </div>
      )}

      {order.managerDecision && (
        <div className="approval-stamp">
          <span>✓</span>
          <div>
            <small>Согласованный вариант</small>
            <strong>{humanizeText(order.managerDecision)}</strong>
          </div>
        </div>
      )}

      <div className="reply-card">
        <div className="reply-head">
          <div>
            <span>Ответ</span>
            <small>Отправка на стенде</small>
          </div>
          <div className={`reply-status ${sent ? "is-sent" : ""}`}>
            {sent
              ? "Отправлено на стенде"
              : inventoryChanged
                ? "Склад обновился · обновите черновик"
              : waitingForCustomer
                ? "Вопросы отправлены на стенде · ожидаем ответ"
                : canClarify
                  ? "Вопросы готовы к отправке"
                : order.status === "awaiting_approval"
                ? "Руководитель выбирает вариант"
                : order.managerDecision
                  ? "Вариант согласован · ответ готов"
                  : "Ответ проверен и готов"}
          </div>
        </div>
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
                ? "Отправляем на стенде…"
                : "Отправить вопросы на стенде"}
            </button>
            <small>
              На стенде отправка сохраняется в журнале всех заказов. В рабочей системе
              письмо уйдёт через почту компании.
            </small>
          </div>
        )}
        {canSend && (
          <div className="reply-action">
            <button type="button" onClick={onSend} disabled={sending}>
              {sending ? "Отправляем на стенде…" : "Отправить на стенде"}
            </button>
            <small>
              Здесь отправка записывает результат в журнал всех заказов. В рабочей
              системе письмо уйдёт через почту компании.
            </small>
          </div>
        )}
        {sent && (
          <div className="sent-note">
            Отправлено на стенде. Карточка вошла в результат дня.
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
          <div>
            <span>Ответ клиента</span>
            <h3>Добавьте детали и продолжите ту же карточку</h3>
            <p>
              Агент объединит письмо, фото и ответ, рассчитает расход и снова
              проверит живой склад.
            </p>
          </div>
          <label>
            <span className="sr-only">Текст ответа клиента</span>
            <textarea
              value={customerAnswer}
              onChange={(event) =>
                onCustomerAnswerChange(event.target.value)
              }
              placeholder="Ответьте на вопросы агента своими словами — карточка продолжится под тем же номером."
              rows={4}
              required
            />
          </label>
          <button
            type="submit"
            disabled={continuing || customerAnswer.trim().length < 3}
          >
            {continuing
              ? "Агент продолжает карточку…"
              : "Продолжить эту карточку"}
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
          {order.mode === "opencode-live"
            ? `Заказ ведёт: ${modelLabel(order.agentModel)} · решение проверяет: ${modelLabel(order.reviewerModel)}`
            : "Расчёт по готовым правилам и живому складу"}
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

  const basisFor = (insight: string, index: number) => {
    const patterns =
      index === 0
        ? [/поставщик/i, /похож|рын|предложен/i, /цен|прибыл/i]
        : /склад|остат|объ[её]м|поставк/i.test(insight)
          ? [/склад|остат|объ[её]м|поставк/i]
          : /цен|прибыл/i.test(insight)
            ? [
                /сохраняет нужную прибыль|завод зарабатывает|карточк[аи] товара/i,
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
    return bases[index] ?? bases[0];
  };

  return (
    <section className="decision-proofs" aria-labelledby="proofs-title">
      <div className="proofs-heading">
        <div>
          <span>Решение можно проверить</span>
          <h3 id="proofs-title">Почему агент так решил</h3>
        </div>
        <p>
          Нажмите на пунктирную фразу или наведите указатель — откроются факт
          и источник.
        </p>
      </div>
      <div className="proofs-grid">
        {insights.map((insight, index) => {
          const basis = basisFor(insight, index);
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
                  Когда проверено: {basis?.checkedAt || "при этом расчёте"}
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
  selectedSku,
  stockValue,
  reason,
  authenticated,
  adminCode,
  busy,
  message,
  error,
  onOpenCatalog,
  onSelectSku,
  onStockChange,
  onReasonChange,
  onAdminCodeChange,
  onSignIn,
  onSignOut,
  onUpdate,
}: {
  inventory: InventoryItem[];
  selectedSku: string;
  stockValue: string;
  reason: string;
  authenticated: boolean;
  adminCode: string;
  busy: boolean;
  message: string;
  error: string;
  onOpenCatalog: () => void;
  onSelectSku: (sku: string) => void;
  onStockChange: (value: string) => void;
  onReasonChange: (value: string) => void;
  onAdminCodeChange: (value: string) => void;
  onSignIn: (event: React.FormEvent) => Promise<void>;
  onSignOut: () => Promise<void>;
  onUpdate: (event: React.FormEvent) => Promise<void>;
}) {
  const selected = inventory.find((item) => item.sku === selectedSku);

  return (
    <section
      className="live-inventory"
      id="live-inventory"
      aria-labelledby="live-inventory-title"
    >
      <div className="live-inventory-intro">
        <p className="eyebrow">Живой склад меняет решение</p>
        <h2 id="live-inventory-title">
          Ведущий меняет остаток — агент сам пересчитывает заказ
        </h2>
        <p>
          Новый остаток сразу появляется в открытой карточке. Агент сам
          пересчитывает заказ и показывает прежнее и новое решения рядом.
          Ведущий может поставить 40 кг, получить варианты для руководителя,
          затем вернуть 180 кг и получить готовое письмо. Обе версии
          сохранятся в истории.
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
                disabled={busy}
              >
                Закрыть пульт
              </button>
            )}
          </div>

          {authenticated ? (
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
              {selectedSku === liveStockDemoSku && (
                <div className="inventory-presets">
                  <span>Быстрый показ с первой заявкой на 100 кг</span>
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        onStockChange("40");
                        onReasonChange("40 кг осталось после резервов");
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
              <button type="submit" disabled={busy || inventory.length === 0}>
                {busy ? "Обновляем склад…" : "Обновить остаток"}
              </button>
            </form>
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
    const eventActor = (stage: string) => {
      if (stage === "customer-reply") return "Клиент";
      if (["approval", "approve", "approved"].includes(stage)) {
        return "Руководитель";
      }
      if (
        ["received", "fallback", "retry", "error", "recalculate"].includes(
          stage,
        )
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
      if (stage === "sent" || stage === "clarification-sent") {
        return "Отправка на стенде";
      }
      if (stage === "recalculate") return "Пересчёт заказа";
      if (stage === "inventory") return "Проверка склада";
      if (stage === "market") return "Проверка цены";
      if (stage === "company-context") return "Сведения о компании";
      if (stage === "review") return "Проверка ответа";
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
          : item.reason === "Склад перечитан"
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
        actor: eventActor(item.stage),
        orderId: item.orderId,
        company:
          companiesByOrderId.get(item.orderId) ?? "Частный покупатель",
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
            изменения склада попадают сюда сами. У каждой строки есть номер
            карточки — по нему открывается вся карточка.
          </p>
        </div>
        <div className="ledger-actions">
          <a href={sheetUrl} target="_blank" rel="noreferrer">
            Открыть общий журнал вебинара в Google Таблицах ↗
          </a>
          <small>
            Лист «Заказы» собирает заявки, действия, решения, черновики,
            изменения склада и отправки.
          </small>
          <a href="/api/ledger?format=csv" download>
            Скачать весь журнал для Google Таблиц
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
        На экране — 30 последних действий. Полная история писем, решений и
        изменений склада доступна в Google Таблице и выгрузке.
      </small>
    </section>
  );
}

function Modal({
  name,
  order,
  events,
  inventory,
  onClose,
}: {
  name: Exclude<ModalName, null>;
  order: OrderRecord | null;
  events: EventRow[];
  inventory: InventoryItem[];
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
    instructions: "Инструкции модели",
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
              Это живые остатки стенда: агент читает их перед каждым новым
              расчётом, а ведущий может изменить их во время показа. Карточка
              сохраняет краску, остаток и время расчёта, поэтому основание
              решения всегда видно.
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
                return (
                  <article className="catalog-row" key={product.sku}>
                    <div>
                      <small>{product.sku}</small>
                      <strong>{product.name}</strong>
                    </div>
                    <p>
                      {product.substrates.join(", ")} · {product.environment}
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
              Модель GPT-5.6 Sol подготовила и проверила инструкцию. Недорогая
              модель получает цель, доступные данные и три правила продаж.
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
              <summary>Технические инструкции для настройки</summary>
              <p>
                Эти файлы задают точный формат работы моделей. Они пригодятся
                команде, которая будет настраивать рабочую систему.
              </p>
              <div className="instruction-list">
                <a href="/prompts/sales-agent.md" target="_blank">
                  <span>01</span>
                  <div>
                    <strong>Недорогая модель ведёт заказ</strong>
                    <small>
                      Письмо, источники, следующий шаг и готовое действие
                    </small>
                  </div>
                </a>
                <a href="/prompts/reviewer.md" target="_blank">
                  <span>02</span>
                  <div>
                    <strong>Сильная модель проверяет решение</strong>
                    <small>Факты, обещания и решения для руководителя</small>
                  </div>
                </a>
                <a href="/prompts/improver.md" target="_blank">
                  <span>03</span>
                  <div>
                    <strong>Команда улучшает правила по журналу</strong>
                    <small>
                      Сильная модель предлагает правки, руководитель принимает
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
                  {order.mode === "opencode-live"
                    ? "Подключённая модель для заказов"
                    : "Расчёт по готовым правилам и живому складу"}
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
                    {order.mode === "opencode-live"
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
