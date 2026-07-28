"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentResult } from "@/lib/demo-engine";

type Draft = {
  company: string;
  website: string;
  subject: string;
  body: string;
};

type EventRow = {
  id: number;
  stage: string;
  title: string;
  detail: string;
  state: string;
};

type OrderRecord = {
  id: string;
  subject: string;
  body: string;
  company: string;
  status: string;
  zone: "green" | "yellow" | "red" | null;
  mode: string;
  managerDecision?: string | null;
  agentModel?: string | null;
  reviewerModel?: string | null;
  result: AgentResult | null;
};

const scenarios: Array<{
  id: string;
  label: string;
  zone: string;
  draft: Draft;
}> = [
  {
    id: "red",
    label: "Дефицит и риск",
    zone: "Красная",
    draft: {
      company: "ВолгаМаш",
      website: "volgamash.example",
      subject: "Заказ грунт-эмали для металлоконструкций",
      body: "Добрый день! Требуется 800 кг тёмно-серой грунт-эмали для наружных металлоконструкций, цвет RAL 7024. Поставка в Казань в течение десяти дней. Мы производим оборудование и не можем останавливать покрасочную линию. Просим направить предложение.",
    },
  },
  {
    id: "yellow",
    label: "Нечёткий запрос",
    zone: "Жёлтая",
    draft: {
      company: "РегионСклад",
      website: "",
      subject: "Заказ краски для нового цеха",
      body: "Добрый день! Нам нужна прочная краска для пола нового производственного помещения. Хотим получить предложение как можно быстрее.",
    },
  },
  {
    id: "green",
    label: "Обычный заказ",
    zone: "Зелёная",
    draft: {
      company: "ГородПроект",
      website: "",
      subject: "Заказ белой краски для стен",
      body: "Добрый день! Нужны 200 кг белой акриловой краски для внутренних стен офиса по штукатурке. Доставка в Москву через две недели. Просим выставить коммерческое предложение.",
    },
  },
];

const emptyDraft: Draft = {
  company: "",
  website: "",
  subject: "",
  body: "",
};

const zoneCopy = {
  green: {
    name: "Зелёная зона",
    short: "Можно отвечать",
    description: "Товар, цена и объём подтверждены.",
  },
  yellow: {
    name: "Жёлтая зона",
    short: "Нужно уточнить",
    description: "Фактов недостаточно для предложения.",
  },
  red: {
    name: "Красная зона",
    short: "Решает руководитель",
    description: "Есть риск, дефицит или особые условия.",
  },
};

function formatMoney(value: number) {
  return new Intl.NumberFormat("ru-RU").format(value);
}

export function OrderStand() {
  const [draft, setDraft] = useState<Draft>(scenarios[0].draft);
  const [orderId, setOrderId] = useState("");
  const [order, setOrder] = useState<OrderRecord | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [bridgeOnline, setBridgeOnline] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState("");
  const [error, setError] = useState("");

  const loadSystem = useCallback(async () => {
    try {
      const response = await fetch("/api/orders?system=1", { cache: "no-store" });
      const data = (await response.json()) as { bridgeOnline?: boolean };
      setBridgeOnline(Boolean(data.bridgeOnline));
    } catch {
      setBridgeOnline(false);
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
    const initial = window.setTimeout(() => void loadSystem(), 0);
    const interval = window.setInterval(() => void loadSystem(), 10_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [loadSystem]);

  useEffect(() => {
    if (!orderId) return;
    const initial = window.setTimeout(() => void loadOrder(orderId), 0);
    const interval = window.setInterval(() => void loadOrder(orderId), 1_500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [loadOrder, orderId]);

  const selectScenario = (id: string) => {
    const scenario = scenarios.find((item) => item.id === id);
    if (scenario) {
      setDraft(scenario.draft);
      setError("");
    }
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
        body: JSON.stringify(draft),
      });
      const data = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !data.id) {
        throw new Error(data.error ?? "Не удалось отправить заказ.");
      }
      setOrderId(data.id);
      await loadOrder(data.id);
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Не удалось отправить заказ.",
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
        body: JSON.stringify({ id: orderId, optionId }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось согласовать.");
      await loadOrder(orderId);
    } catch (approvalError) {
      setError(
        approvalError instanceof Error
          ? approvalError.message
          : "Не удалось согласовать.",
      );
    } finally {
      setApproving("");
    }
  };

  const reset = () => {
    setOrderId("");
    setOrder(null);
    setEvents([]);
    setError("");
    setDraft(emptyDraft);
  };

  const result = order?.result;
  const currentZone = result?.zone ?? order?.zone;
  const progress = useMemo(() => {
    if (!orderId) return 0;
    if (order?.status === "completed" || order?.status === "awaiting_approval") {
      return 100;
    }
    return Math.min(90, 12 + events.length * 16);
  }, [events.length, order?.status, orderId]);

  return (
    <div className="site-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="КОЛЕР — начало">
          <span className="brand-mark" aria-hidden="true">
            К
          </span>
          <span>
            <strong>КОЛЕР</strong>
            <small>агент отдела продаж</small>
          </span>
        </a>
        <div className={`connection ${bridgeOnline ? "is-live" : ""}`}>
          <span className="connection-dot" aria-hidden="true" />
          <span>
            {bridgeOnline ? "OpenCode подключён" : "Автономный демо-режим"}
          </span>
        </div>
        <div className="topbar-note">Данные стенда · не вводите реальные реквизиты</div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">От входящего письма — к управляемому решению</p>
            <h1>
              Не просто ответ.
              <br />
              <span>Сохранённый заказ.</span>
            </h1>
            <p className="hero-lead">
              Напишите запрос как обычный клиент. Агент разберёт потребность,
              проверит склад и рынок, пройдёт модельное ревью и покажет границу
              своих полномочий.
            </p>
          </div>

          <div className="zone-strip" aria-label="Правила перехода">
            {(Object.keys(zoneCopy) as Array<keyof typeof zoneCopy>).map((zone) => (
              <div className={`zone-card zone-${zone}`} key={zone}>
                <span className="zone-light" aria-hidden="true" />
                <strong>{zoneCopy[zone].short}</strong>
                <small>{zoneCopy[zone].description}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="workbench">
          <div className="compose-column">
            <div className="section-label">
              <span>01</span>
              Письмо заказчика
            </div>

            <div className="scenario-row" aria-label="Быстрые сценарии">
              {scenarios.map((scenario) => (
                <button
                  className={`scenario scenario-${scenario.id}`}
                  type="button"
                  onClick={() => selectScenario(scenario.id)}
                  key={scenario.id}
                >
                  <span>{scenario.zone}</span>
                  {scenario.label}
                </button>
              ))}
            </div>

            <form className="mail-card" onSubmit={submit}>
              <div className="mail-toolbar">
                <span className="mail-dot" />
                <span className="mail-dot" />
                <span className="mail-dot" />
                <span>Новое письмо</span>
              </div>

              <label className="mail-field compact">
                <span>Кому</span>
                <input value="sales@koler-demo.ru" readOnly aria-label="Получатель" />
              </label>
              <label className="mail-field compact">
                <span>Компания</span>
                <input
                  value={draft.company}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      company: event.target.value,
                    }))
                  }
                  placeholder="Например, ВолгаМаш"
                />
              </label>
              <label className="mail-field compact">
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
                  placeholder="Заказ краски…"
                  required
                />
              </label>
              <label className="mail-body">
                <span className="sr-only">Текст письма</span>
                <textarea
                  value={draft.body}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, body: event.target.value }))
                  }
                  placeholder="Опишите заказ обычными словами…"
                  rows={9}
                  required
                />
              </label>

              <div className="mail-actions">
                <button className="send-button" type="submit" disabled={submitting}>
                  <span>{submitting ? "Отправляем…" : "Отправить агенту"}</span>
                  <span aria-hidden="true">→</span>
                </button>
                <small>Письмо станет рабочей задачей, а не просто промптом.</small>
              </div>
            </form>
          </div>

          <div className="process-column" aria-live="polite">
            <div className="section-label">
              <span>02</span>
              Ход обработки
              {orderId && (
                <button className="text-button" type="button" onClick={reset}>
                  Новый заказ
                </button>
              )}
            </div>

            {!orderId ? (
              <div className="empty-process">
                <div className="orbit" aria-hidden="true">
                  <span>письмо</span>
                  <span>склад</span>
                  <span>рынок</span>
                  <span>правила</span>
                  <div>АГЕНТ</div>
                </div>
                <h2>Здесь появится путь решения</h2>
                <p>
                  Вы увидите не скрытые рассуждения модели, а проверяемые действия:
                  источник, результат и точку согласования.
                </p>
              </div>
            ) : (
              <div className="run-panel">
                <div className="run-head">
                  <div>
                    <small>Карточка {orderId.slice(-6).toUpperCase()}</small>
                    <h2>{order?.subject ?? "Принимаем заказ…"}</h2>
                  </div>
                  <div
                    className={`zone-badge ${currentZone ? `zone-${currentZone}` : "is-processing"}`}
                  >
                    <span />
                    {currentZone
                      ? zoneCopy[currentZone].name
                      : "Агент работает"}
                  </div>
                </div>

                <div className="progress-track" aria-label={`Готовность ${progress}%`}>
                  <span style={{ width: `${progress}%` }} />
                </div>

                <div className="event-list">
                  {events.map((item, index) => (
                    <article
                      className={`event-item ${item.state === "error" ? "is-error" : ""}`}
                      key={item.id}
                      style={{ animationDelay: `${Math.min(index * 90, 450)}ms` }}
                    >
                      <div className="event-index">
                        {String(index + 1).padStart(2, "0")}
                      </div>
                      <div>
                        <h3>{item.title}</h3>
                        <p>{item.detail}</p>
                      </div>
                      <span className="event-check" aria-hidden="true">
                        ✓
                      </span>
                    </article>
                  ))}
                  {order?.status === "processing" && (
                    <article className="event-item is-active">
                      <div className="event-index">··</div>
                      <div>
                        <h3>Следующий шаг выбирает агент</h3>
                        <p>Он действует только доступными инструментами.</p>
                      </div>
                      <span className="event-pulse" />
                    </article>
                  )}
                </div>

                {result && (
                  <ResultPanel
                    result={result}
                    order={order}
                    approving={approving}
                    onApprove={approve}
                  />
                )}
              </div>
            )}

            {error && <div className="error-banner">{error}</div>}
          </div>
        </section>

        <section className="explain-strip">
          <div>
            <span>Сигнал</span>
            <strong>Письмо запускает дело</strong>
          </div>
          <i aria-hidden="true">→</i>
          <div>
            <span>Смысл</span>
            <strong>Модель понимает контекст</strong>
          </div>
          <i aria-hidden="true">→</i>
          <div>
            <span>Истина</span>
            <strong>Таблицы дают факты</strong>
          </div>
          <i aria-hidden="true">→</i>
          <div>
            <span>Граница</span>
            <strong>Правила задают свободу</strong>
          </div>
          <i aria-hidden="true">→</i>
          <div>
            <span>Действие</span>
            <strong>Ответ или согласование</strong>
          </div>
        </section>
      </main>

      <footer>
        <strong>КОЛЕР</strong>
        <span>Демонстрационный агентный контур · данные синтетические</span>
        <span>OpenCode + OpenCode Go</span>
      </footer>
    </div>
  );
}

function ResultPanel({
  result,
  order,
  approving,
  onApprove,
}: {
  result: AgentResult;
  order: OrderRecord;
  approving: string;
  onApprove: (id: string) => Promise<void>;
}) {
  const zone = zoneCopy[result.zone];
  return (
    <div className="result-panel">
      <div className="result-summary">
        <div className={`decision-poster zone-${result.zone}`}>
          <span>{zone.name}</span>
          <strong>{result.zoneReason}</strong>
          <small>Уверенность агента: {Math.round(result.confidence * 100)}%</small>
        </div>

        <div className="facts-grid">
          <article>
            <span>Понято</span>
            {result.understood.map((item) => (
              <strong key={item}>{item}</strong>
            ))}
          </article>
          <article>
            <span>Рынок</span>
            <p>{result.market.summary}</p>
          </article>
          <article>
            <span>Контекст бизнеса</span>
            <p>{result.businessContext}</p>
          </article>
          <article>
            <span>Модельное ревью</span>
            <strong>{result.review.verdict}</strong>
            <p>{result.review.notes.join(" · ")}</p>
          </article>
        </div>
      </div>

      {result.product && (
        <div className="numbers-row">
          <div>
            <span>Продукт</span>
            <strong>{result.product.name}</strong>
            <small>{result.product.sku}</small>
          </div>
          <div>
            <span>Запрошено</span>
            <strong>{formatMoney(result.product.requestedKg)} кг</strong>
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
            <strong>{formatMoney(result.product.total)} ₽</strong>
          </div>
        </div>
      )}

      {result.options.length > 0 && !order.managerDecision && (
        <div className="manager-block">
          <div className="manager-heading">
            <span>03</span>
            <div>
              <small>Пульт руководителя</small>
              <h3>Как сохранить клиента?</h3>
            </div>
          </div>
          <p className="manager-note">{result.managerNote}</p>
          <div className="option-grid">
            {result.options.map((option, index) => (
              <article className="option-card" key={option.id}>
                <span className="option-number">0{index + 1}</span>
                <h4>{option.title}</h4>
                <p>{option.rationale}</p>
                <small>{option.tradeoff}</small>
                <button
                  type="button"
                  onClick={() => onApprove(option.id)}
                  disabled={Boolean(approving)}
                >
                  {approving === option.id ? "Согласуем…" : "Согласовать"}
                </button>
              </article>
            ))}
          </div>
        </div>
      )}

      {order.managerDecision && (
        <div className="approval-stamp">
          <span>✓</span>
          <div>
            <small>Решение руководителя</small>
            <strong>{order.managerDecision}</strong>
          </div>
        </div>
      )}

      <div className="reply-card">
        <div className="reply-head">
          <div>
            <span>04</span>
            <small>Ответ клиенту</small>
          </div>
          <div className="reply-status">
            {result.zone === "red" && !order.managerDecision
              ? "Черновик · отправка заблокирована"
              : "Проверено · готово к отправке"}
          </div>
        </div>
        <strong className="reply-subject">{result.reply.subject}</strong>
        <p>{result.reply.body}</p>
      </div>

      <div className="checks-row">
        {result.checks.map((check) => (
          <span key={check}>✓ {check}</span>
        ))}
      </div>

      <div className="source-line">
        <span>Источники:</span>
        {result.sources.map((source) => (
          <strong key={source}>{source}</strong>
        ))}
        <small>
          {order.mode === "opencode-live"
            ? `${order.agentModel ?? "OpenCode"} · ревью ${order.reviewerModel ?? "OpenCode"}`
            : "Автономный демо-контур"}
        </small>
      </div>
    </div>
  );
}
