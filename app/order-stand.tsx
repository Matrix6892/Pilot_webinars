"use client";

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

type Draft = DemoScenario;

type EventRow = {
  id: number;
  stage: string;
  title: string;
  detail: string;
  state: string;
  createdAt: string;
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
  result: AgentResult | null;
};

type DailyStats = {
  total: number;
  completed: number;
  awaitingApproval: number;
  sent: number;
  zones: Record<ScenarioZone, number>;
};

type ModalName = "catalog" | "instructions" | "order" | null;

const sheetUrl =
  "https://docs.google.com/spreadsheets/d/1gabC2L8HOihMzPpp6pDeoMDtqXN9cEoGxwV-Al3PaYY/edit";

const zoneCopy = {
  green: {
    name: "Зелёная зона",
    short: "Агент готовит ответ",
    description:
      "Продукт найден, полный объём есть, цена и условия проходят правила.",
    next: "Следующий шаг: проверить черновик и отправить.",
  },
  yellow: {
    name: "Жёлтая зона",
    short: "Агент уточняет",
    description:
      "Не хватает существенных данных либо продукт требует подтверждения.",
    next: "Следующий шаг: отправить точный вопрос вместе с предложенным ходом.",
  },
  red: {
    name: "Красная зона",
    short: "Руководитель выбирает",
    description:
      "Дефицит, скидка, отсрочка, штраф или срок на завтра требуют решения.",
    next: "Следующий шаг: выбрать один подготовленный вариант.",
  },
} satisfies Record<
  ScenarioZone,
  { name: string; short: string; description: string; next: string }
>;

const emptyStats: DailyStats = {
  total: 0,
  completed: 0,
  awaitingApproval: 0,
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

function inferZone(draft: Draft) {
  const text = `${draft.subject}\n${draft.body}`.trim();
  if (text.length < 20) {
    return {
      zone: null,
      label: "Оценка появится по мере ввода",
      reason: "Добавьте задачу клиента обычными словами.",
    } as const;
  }

  const quantity = quantityFromText(text);
  const product = matchProduct(text, demoData.products);
  const hasUnknownSku = Boolean(explicitSkuFromText(text)) && !product;
  const special = hasSpecialTerms(text);

  if (special || (product && quantity > product.stockKg)) {
    return {
      zone: "red",
      label: "По тексту похоже на красную зону",
      reason: special
        ? "В письме есть особое коммерческое условие."
        : `Запрос выше демонстрационного остатка ${formatMoney(product?.stockKg ?? 0)} кг.`,
    } as const;
  }

  const missing: string[] = [];
  if (!product) {
    missing.push(hasUnknownSku ? "артикул отсутствует в каталоге" : "неясен продукт");
  }
  if (!quantity) missing.push("нет количества в килограммах");
  if (!hasUsableEnvironment(text)) {
    missing.push("не указаны условия эксплуатации");
  }
  if (!hasColor(text)) {
    missing.push("не указан цвет");
  }
  if (asksCompatibility(text)) {
    missing.push("нужно подтвердить совместимость");
  }

  if (missing.length) {
    return {
      zone: "yellow",
      label: "По тексту похоже на жёлтую зону",
      reason: missing.slice(0, 2).join(" · "),
    } as const;
  }

  return {
    zone: "green",
    label: "По тексту похоже на зелёную зону",
    reason: "Продукт, объём, условия и цвет уже указаны.",
  } as const;
}

function modelLabel(id?: string | null) {
  return modelCatalog.options.find((model) => model.id === id)?.label ?? id ?? "—";
}

function statusLabel(status: string) {
  return (
    {
      queued: "Ждёт свободного исполнителя",
      processing: "Модель готовит решение",
      awaiting_approval: "Ждёт решения руководителя",
      ready_to_send: "Готово к отправке",
      completed: "Готово к отправке",
      sent: "Демо-отправка зафиксирована",
      error: "Работа остановлена",
    }[status] ?? status
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
  const [order, setOrder] = useState<OrderRecord | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [stats, setStats] = useState<DailyStats>(emptyStats);
  const [bridgeOnline, setBridgeOnline] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState("");
  const [sending, setSending] = useState(false);
  const [modal, setModal] = useState<ModalName>(null);
  const [error, setError] = useState("");
  const closeModal = useCallback(() => setModal(null), []);

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

  const loadOrder = useCallback(async (id: string) => {
    const response = await fetch(`/api/orders?id=${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    if (!response.ok) return;
    const data = (await response.json()) as {
      order: OrderRecord;
      events: EventRow[];
    };
    setOrder(data.order);
    setEvents(data.events);
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void loadSystem();
      void loadStats();
    }, 0);
    const interval = window.setInterval(() => {
      void loadSystem();
      void loadStats();
    }, 10_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [loadStats, loadSystem]);

  useEffect(() => {
    if (!orderId) return;
    const initial = window.setTimeout(() => void loadOrder(orderId), 0);
    const interval = window.setInterval(() => void loadOrder(orderId), 1_500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [loadOrder, orderId]);

  const selectScenarioGroup = (zone: ScenarioZone) => {
    const group = scenarioGroups.find((item) => item.id === zone);
    if (!group) return;
    setScenarioGroup(zone);
    setScenarioIndex(0);
    setDraft(group.examples[0]);
    setError("");
  };

  const nextScenario = () => {
    const group = scenarioGroups.find((item) => item.id === scenarioGroup);
    if (!group) return;
    const next = (scenarioIndex + 1) % group.examples.length;
    setScenarioIndex(next);
    setDraft(group.examples[next]);
    setError("");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setOrder(null);
    setEvents([]);

    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draft, model: selectedModel }),
      });
      const data = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !data.id) {
        throw new Error(
          data.error ?? "Проверьте тему и текст письма, затем повторите.",
        );
      }
      setOrderId(data.id);
      await loadOrder(data.id);
      await loadStats();
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: orderId, action: "approve", optionId }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(
          data.error ?? "Обновите карточку и выберите вариант снова.",
        );
      }
      await loadOrder(orderId);
      await loadStats();
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: orderId, action: "send" }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(
          data.error ?? "Обновите карточку и повторите демо-отправку.",
        );
      }
      await loadOrder(orderId);
      await loadStats();
    } catch (sendError) {
      setError(
        sendError instanceof Error
          ? sendError.message
          : "Обновите карточку и повторите демо-отправку.",
      );
    } finally {
      setSending(false);
    }
  };

  const reset = () => {
    setOrderId("");
    setOrder(null);
    setEvents([]);
    setError("");
    document
      .getElementById("compose")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const result = order?.result;
  const currentZone = result?.zone ?? order?.zone;
  const hint = useMemo(() => inferZone(draft), [draft]);
  const progress = useMemo(() => {
    if (!orderId) return 0;
    if (order?.status === "sent") return 100;
    if (order?.status === "ready_to_send") return 96;
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
            {bridgeOnline ? "OpenCode подключён" : "Демо-режим"}
          </span>
        </div>
        <a className="topbar-link" href="#day-result">
          Результат дня
        </a>
      </header>

      <main id="top">
        <section className="story-hero" aria-labelledby="main-title">
          <div className="hero-intro">
            <p className="eyebrow">Демонстрация агентной системы продаж</p>
            <h1 id="main-title">Письмо клиента становится готовым решением</h1>
            <p className="hero-lead">
              Агент разбирает свободный текст, сверяет факты, оценивает риск,
              приносит руководителю варианты и доводит согласованный ответ до
              демо-отправки.
            </p>
          </div>

          <div className="hero-status">
            <span>Что работает сейчас</span>
            <strong>
              {bridgeOnline
                ? "Форма письма → карточка → OpenCode → выбранная модель"
                : "Форма письма → карточка → автономные правила → решение"}
            </strong>
            <p>
              {bridgeOnline
                ? "OpenCode подключён на компьютере ведущего. Облачная база хранит номер, статус и журнал."
                : "Публичный стенд отвечает сразу по тем же данным и коммерческим границам. Ведущий может подключить OpenCode для живого модельного запуска."}{" "}
              Корпоративная почта подключается к приёму и отправке через
              отдельные адаптеры.
            </p>
          </div>

          <div className="system-map" aria-label="Путь заказа">
            <article>
              <span>01</span>
              <strong>Письмо</strong>
              <small>
                Форма сейчас, почтовый ящик после подключения адаптера
              </small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>02</span>
              <strong>Карточка</strong>
              <small>Номер, статус и история в облачной базе</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>03</span>
              <strong>Факты</strong>
              <small>Каталог, склад, прайс и демонстрационный рынок</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>04</span>
              <strong>Исполнитель</strong>
              <small>
                {bridgeOnline
                  ? "OpenCode запускает выбранную модель по инструкции"
                  : "Автономные правила выполняют заказ сразу"}
              </small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>05</span>
              <strong>Граница</strong>
              <small>Зелёная, жёлтая или красная зона</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>06</span>
              <strong>Решение</strong>
              <small>Ответ агента либо выбор руководителя</small>
            </article>
            <i aria-hidden="true">→</i>
            <article>
              <span>07</span>
              <strong>Журнал</strong>
              <small>Демо-отправка и материал для улучшения инструкции</small>
            </article>
          </div>

          <div className="source-dock" aria-label="Источники и правила стенда">
            <a href={sheetUrl} target="_blank" rel="noreferrer">
              <span>Структура данных</span>
              Google-таблица демонстрации
            </a>
            <button type="button" onClick={() => setModal("catalog")}>
              <span>Товары</span>
              Каталог пяти продуктов
            </button>
            <button type="button" onClick={() => setModal("instructions")}>
              <span>Правила</span>
              Инструкция редакции 5.6
            </button>
            <a href="#day-result">
              <span>История</span>
              Журнал и результат дня
            </a>
          </div>

          <div className="zone-explainer">
            {(Object.keys(zoneCopy) as ScenarioZone[]).map((zone) => (
              <article className={`zone-explain zone-${zone}`} key={zone}>
                <div>
                  <span className="zone-light" aria-hidden="true" />
                  <span className="zone-name">{zoneCopy[zone].name}</span>
                </div>
                <strong>{zoneCopy[zone].short}</strong>
                <p>{zoneCopy[zone].description}</p>
                <small>{zoneCopy[zone].next}</small>
              </article>
            ))}
          </div>
        </section>

        <section className="demo-heading" id="compose">
          <div>
            <p className="eyebrow">Попробуйте путь руками</p>
            <h2>Отправьте первое письмо</h2>
          </div>
          <p>
            Начните с полного заказа, затем выберите заявку с пробелом и заказ
            с особыми условиями. Для каждой группы подготовлено десять писем.
          </p>
        </section>

        <section className="workbench">
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
                <strong>Новое письмо</strong>
                <span>Черновик</span>
              </div>

              <div className="mail-line">
                <span>Кому</span>
                <strong>sales@koler-demo.ru</strong>
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
                  placeholder="Необязательно"
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

              <div className="mail-model">
                <label>
                  <span>Модель живого запуска</span>
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
                    ? "OpenCode запустит выбранную модель по инструкции, которую проверила GPT-5.6 Sol."
                    : "Сейчас ответ готовят автономные правила стенда. Выбор модели включится вместе с OpenCode."}
                </small>
              </div>

              <div className={`zone-hint ${hint.zone ? `zone-${hint.zone}` : ""}`}>
                <span className="zone-light" aria-hidden="true" />
                <div>
                  <strong>{hint.label}</strong>
                  <small>{hint.reason}</small>
                </div>
              </div>

              <div className="mail-actions">
                <button className="send-button" type="submit" disabled={submitting}>
                  <span>{submitting ? "Создаём карточку…" : "Отправить агенту"}</span>
                  <span aria-hidden="true">→</span>
                </button>
                <small>
                  Финальную зону определят каталог, остатки и правила после
                  отправки.
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
                    Номер карточки, режим исполнения, открытые источники,
                    проверенные числа, решение и готовый ответ останутся в
                    одном потоке.
                  </p>
                </div>
                <ol className="process-preview">
                  <li>
                    <span aria-hidden="true">•</span>
                    <strong>Разбор письма</strong>
                    <small>Продукт, объём, срок и условия</small>
                  </li>
                  <li>
                    <span aria-hidden="true">•</span>
                    <strong>Проверка фактов</strong>
                    <small>
                      Каталог, остаток, цена и демонстрационный рынок
                    </small>
                  </li>
                  <li>
                    <span aria-hidden="true">•</span>
                    <strong>Контекст клиента</strong>
                    <small>
                      {bridgeOnline
                        ? "OpenCode ищет публичные источники при коммерческом риске"
                        : "Публичный поиск включается вместе с живым OpenCode"}
                    </small>
                  </li>
                  <li>
                    <span aria-hidden="true">•</span>
                    <strong>Проверка и граница</strong>
                    <small>
                      {bridgeOnline
                        ? "Вторая модель ищет ошибку до отправки"
                        : "Код проверяет числа, условия и полномочия"}
                    </small>
                  </li>
                  <li>
                    <span aria-hidden="true">•</span>
                    <strong>Следующий ход</strong>
                    <small>Письмо либо готовые варианты руководителю</small>
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
                      Карточка {orderId.slice(-6).toUpperCase()} ↗
                    </button>
                    <h2>{order?.subject ?? "Принимаем заказ…"}</h2>
                    <small>
                      {order?.company || "Компания не указана"} ·{" "}
                      {order?.mode === "opencode-live"
                        ? modelLabel(
                            order?.agentModel ??
                              order?.requestedModel ??
                              selectedModel,
                          )
                        : "Автономные правила стенда"}
                    </small>
                  </div>
                  <div
                    className={`zone-badge ${
                      currentZone ? `zone-${currentZone}` : "is-processing"
                    }`}
                  >
                    <span />
                    {currentZone ? zoneCopy[currentZone].name : "Агент работает"}
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
                        <h3>{item.title}</h3>
                        <p>{item.detail}</p>
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
                      <strong>Агент остановил обработку</strong>
                      <p>
                        Письмо и журнал сохранены. Выберите другой исполнитель
                        или запустите новую карточку.
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
                    onApprove={approve}
                    onSend={sendReply}
                    onOpenCatalog={() => setModal("catalog")}
                  />
                )}
              </div>
            )}

            {error && <div className="error-banner">{error}</div>}
          </div>
        </section>

        <section className="control-story">
          <div className="control-intro">
            <p className="eyebrow">Что удерживает качество ответа</p>
            <h2>Сильная инструкция сужает пространство ошибки</h2>
            <p>
              DeepSeek V4 Flash проходит те же правила, что и GPT-5.6 Sol. Код
              удерживает артикул, остаток, минимальную цену и красные условия.
              GPT-5.6 Sol проверила инструкцию, журнал собирает материал для
              следующей редакции.
            </p>
          </div>
          <div className="control-grid">
            <article>
              <span>Исполнитель</span>
              <strong>Выбирается для живого запуска</strong>
              <p>
                DeepSeek V4 Flash, DeepSeek V4 Pro и GPT-5.6 Sol работают по
                одной схеме данных.
              </p>
            </article>
            <article>
              <span>Инструкция</span>
              <strong>Markdown · редакция 5.6</strong>
              <p>
                Роль, источники, зоны, публичный поиск, ответы и структура
                результата.
              </p>
              <button type="button" onClick={() => setModal("instructions")}>
                Открыть инструкцию
              </button>
            </article>
            <article>
              <span>Наблюдаемость</span>
              <strong>Каждый шаг остаётся в журнале</strong>
              <p>
                Участник видит источник, проверку, модель, решение и
                демо-отправку.
              </p>
              <button
                type="button"
                onClick={() =>
                  document
                    .getElementById("day-result")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
              >
                Посмотреть результат дня
              </button>
            </article>
          </div>
        </section>

        <section className="day-result" id="day-result">
          <div className="day-heading">
            <div>
              <p className="eyebrow">Общий результат за сегодня</p>
              <h2>Стенд запоминает работу участников</h2>
            </div>
            <p>
              Показатели обновляются после создания карточки, согласования и
              демо-отправки.
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
              <span>Демо-отправки</span>
              <strong>{stats.sent}</strong>
              <small>зафиксировано в журнале</small>
            </article>
          </div>
          <div className="zone-totals">
            <span>
              <i className="zone-green" /> Зелёных: {stats.zones.green}
            </span>
            <span>
              <i className="zone-yellow" /> Жёлтых: {stats.zones.yellow}
            </span>
            <span>
              <i className="zone-red" /> Красных: {stats.zones.red}
            </span>
          </div>
        </section>
      </main>

      <footer>
        <strong>Колер</strong>
        <span>
          Данные о красках и запасах, сгенерированные для демонстрации на
          вебинаре. Демонстрационный рынок и отраслевые сценарии также
          подготовлены для показа.
        </span>
        <span>OpenCode · база заказов · модели по выбору</span>
      </footer>

      {modal && (
        <Modal
          name={modal}
          order={order}
          events={events}
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
  onApprove,
  onSend,
  onOpenCatalog,
}: {
  result: AgentResult;
  order: OrderRecord;
  approving: string;
  sending: boolean;
  onApprove: (id: string) => Promise<void>;
  onSend: () => Promise<void>;
  onOpenCatalog: () => void;
}) {
  const [selectedOption, setSelectedOption] = useState("");
  const zone = zoneCopy[result.zone];
  const canSend = order.status === "ready_to_send";
  const sent = order.status === "sent";

  return (
    <div className="result-panel">
      <div className="result-summary">
        <div className={`decision-poster zone-${result.zone}`}>
          <span>{zone.name}</span>
          <strong>{result.zoneReason}</strong>
          <small>
            Основание: {result.sources.length}{" "}
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
            <span>Понято</span>
            {result.understood.map((item) => (
              <strong key={item}>{item}</strong>
            ))}
          </article>
          <article>
            <span>Следующий ход</span>
            <p>{result.managerNote}</p>
          </article>
          <article>
            <span>Демонстрационный рынок</span>
            <p>{result.market.summary}</p>
          </article>
          <article>
            <span>
              {order.mode === "opencode-live"
                ? "ИИ-проверка"
                : "Проверка правил"}
            </span>
            <strong>{result.review.verdict}</strong>
            <p>{result.review.notes.join(" · ")}</p>
          </article>
          <article className="facts-wide">
            <span>Контекст для решения</span>
            <p>{result.businessContext}</p>
          </article>
        </div>
      </div>

      {result.research &&
        (result.research.checked || result.research.sources.length > 0) && (
          <div className="research-card">
            <div>
              <span>Публичный контекст компании</span>
              <p>{result.research.summary}</p>
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
                    <strong>{source.title}</strong>
                    <small>
                      {source.fact} · {source.checkedAt}
                    </small>
                  </a>
                ))}
              </div>
            ) : (
              <small>
                Агент завершил поиск. Надёжных публичных источников для решения не
                найдено.
              </small>
            )}
          </div>
        )}

      {result.product && (
        <div className="numbers-row">
          <button type="button" onClick={onOpenCatalog}>
            <span>Продукт ↗</span>
            <strong>{result.product.name}</strong>
            <small>{result.product.sku}</small>
          </button>
          <div>
            <span>Запрошено</span>
            <strong>
              {result.product.requestedKg
                ? `${formatMoney(result.product.requestedKg)} кг`
                : "После уточнения"}
            </strong>
          </div>
          <div>
            <span>В наличии</span>
            <strong>{formatMoney(result.product.stockKg)} кг</strong>
          </div>
          <div>
            <span>Цена</span>
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

      {result.options.length > 0 && !order.managerDecision && (
        <div className="manager-block">
          <div className="manager-heading">
            <span>Решение</span>
            <div>
              <small>Роль руководителя в демонстрации</small>
              <h3>Выберите один способ сохранить клиента</h3>
            </div>
          </div>
          <p className="manager-note">
            Агент приложил контекст, пользу, компромисс и готовый текст для
            каждого решения.
          </p>
          <fieldset className="option-grid" disabled={Boolean(approving)}>
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
                <h4>{option.title}</h4>
                <p>{option.rationale}</p>
                <small>{option.tradeoff}</small>
              </label>
            ))}
          </fieldset>
          <button
            className="approve-button"
            type="button"
            onClick={() => onApprove(selectedOption)}
            disabled={!selectedOption || Boolean(approving)}
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
            <strong>{order.managerDecision}</strong>
          </div>
        </div>
      )}

      <div className="reply-card">
        <div className="reply-head">
          <div>
            <span>Ответ</span>
            <small>Ответ клиенту</small>
          </div>
          <div className={`reply-status ${sent ? "is-sent" : ""}`}>
            {sent
              ? "Демо-отправка · записана в журнал"
              : order.status === "awaiting_approval"
                ? "Черновик · ждёт решения"
                : order.managerDecision
                  ? "Вариант согласован · готово к отправке"
                  : "Проверено · готово к отправке"}
          </div>
        </div>
        <strong className="reply-subject">{result.reply.subject}</strong>
        <p>{result.reply.body}</p>
        {canSend && (
          <div className="reply-action">
            <button type="button" onClick={onSend} disabled={sending}>
              {sending ? "Фиксируем отправку…" : "Завершить демо-отправку"}
            </button>
            <small>
              В стенде письмо записывается в журнал. Корпоративный почтовый
              шлюз подключается отдельным адаптером.
            </small>
          </div>
        )}
        {sent && (
          <div className="sent-note">
            Демо-отправка завершена. Карточка вошла в результат дня.
          </div>
        )}
      </div>

      <div className="checks-row">
        {result.checks.map((check) => (
          <span key={check}>✓ {check}</span>
        ))}
      </div>

      <div className="source-line">
        <span>Источники</span>
        {result.sources.map((source) => (
          <strong key={source}>{source}</strong>
        ))}
        <small>
          {order.mode === "opencode-live"
            ? `${modelLabel(order.agentModel)} · проверка ${modelLabel(order.reviewerModel)}`
            : "Автономные правила · те же данные и границы"}
        </small>
      </div>
    </div>
  );
}

function Modal({
  name,
  order,
  events,
  onClose,
}: {
  name: Exclude<ModalName, null>;
  order: OrderRecord | null;
  events: EventRow[];
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
    order: "Карточка глазами агента",
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
              Эти значения использует автономный режим и получает живая модель
              внутри задачи. Стенд читает фиксированный снимок; Google-таблица
              показывает ту же структуру данных.
            </p>
            <div className="catalog-table">
              <div className="catalog-row catalog-header" aria-hidden="true">
                <span>Артикул и продукт</span>
                <span>Назначение</span>
                <span>Остаток</span>
                <span>Цена</span>
                <span>Минимум</span>
              </div>
              {demoData.products.map((product) => (
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
                    <strong>{formatMoney(product.stockKg)} кг</strong>
                  </div>
                  <div className="catalog-number">
                    <small>Цена</small>
                    <strong>{formatMoney(product.pricePerKg)} ₽/кг</strong>
                  </div>
                  <div className="catalog-number">
                    <small>Минимум</small>
                    <strong>{formatMoney(product.minPricePerKg)} ₽/кг</strong>
                  </div>
                </article>
              ))}
            </div>
            <a
              className="modal-primary-link"
              href={sheetUrl}
              target="_blank"
              rel="noreferrer"
            >
              Открыть всю Google-таблицу ↗
            </a>
          </>
        )}

        {name === "instructions" && (
          <>
            <p className="modal-lead">
              GPT-5.6 Sol проверила инструкции 28 июля 2026 года. Исполнитель
              получает правила зон, формат результата, источники и границы
              публичного поиска.
            </p>
            <div className="instruction-list">
              <a href="/prompts/sales-agent.md" target="_blank">
                <span>01</span>
                <div>
                  <strong>Коммерческий агент</strong>
                  <small>
                    Разбор письма, источники, зоны, поиск и структура результата
                  </small>
                </div>
              </a>
              <a href="/prompts/reviewer.md" target="_blank">
                <span>02</span>
                <div>
                  <strong>ИИ-рецензент</strong>
                  <small>Блокирующие ошибки и проверка обязательств</small>
                </div>
              </a>
              <a href="/prompts/improver.md" target="_blank">
                <span>03</span>
                <div>
                  <strong>Ручной разбор журнала</strong>
                  <small>Инструкция для отдельного прохода сильной моделью</small>
                </div>
              </a>
            </div>
            <div className="instruction-rule">
              <strong>Наблюдаемые события</strong>
              <p>
                Система сохраняет открытые источники, проверки, модели,
                решения и демо-отправку. Скрытые рассуждения в журнал не входят.
              </p>
            </div>
          </>
        )}

        {name === "order" && order && (
          <div className="agent-card-view">
            <div className="agent-card-meta">
              <article>
                <span>Карточка</span>
                <strong>{order.id.slice(-6).toUpperCase()}</strong>
              </article>
              <article>
                <span>Статус</span>
                <strong>{statusLabel(order.status)}</strong>
              </article>
              <article>
                <span>Исполнитель</span>
                <strong>{modelLabel(order.agentModel ?? order.requestedModel)}</strong>
              </article>
              <article>
                <span>Режим</span>
                <strong>
                  {order.mode === "opencode-live"
                    ? "Живой OpenCode"
                    : "Автономные правила"}
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
            {order.result && (
              <div className="agent-facts">
                <article>
                  <span>Распознано</span>
                  {order.result.understood.map((item) => (
                    <strong key={item}>{item}</strong>
                  ))}
                </article>
                <article>
                  <span>Граница</span>
                  <strong>{zoneCopy[order.result.zone].name}</strong>
                  <p>{order.result.zoneReason}</p>
                </article>
                <article>
                  <span>Источники</span>
                  <p>{order.result.sources.join(" · ")}</p>
                </article>
              </div>
            )}
            <div className="agent-log">
              <span>Журнал действий</span>
              {events.map((event) => (
                <div key={event.id}>
                  <time>{formatEventTime(event.createdAt)}</time>
                  <strong>{event.title}</strong>
                  <p>{event.detail}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
