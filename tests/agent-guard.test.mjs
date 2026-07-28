import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeAgentResult } from "../lib/agent-guard.mjs";

const demoData = JSON.parse(
  await readFile(new URL("../data/paint-demo.json", import.meta.url), "utf8"),
);

test("grounds a red order in catalog data and keeps visible copy clean", () => {
  const result = normalizeAgentResult(
    {
      zone: "green",
      decision: "quote",
      confidence: 0.92,
      understood: ["Объём: 800 кг"],
      missing: [],
      product: {
        sku: "КР-001",
        name: "Invented product",
        stockKg: 900,
        requestedKg: 800,
        pricePerKg: 1,
        total: 800,
        replenishmentDays: 0,
      },
      market: {
        checked: true,
        summary: "Price is in market range",
        items: [],
      },
      businessContext: "Машиностроение: важен срок.",
      zoneReason: "Everything is available",
      managerNote: "",
      options: [
        {
          id: "split",
          title: "Разделить поставку",
          rationale: "Отгрузить первую партию со склада.",
          tradeoff: "Клиент получает часть объёма раньше.",
          reply: "Предлагаем разделить поставку.",
        },
      ],
      reply: {
        subject: "Offer RAL 7024",
        body: "We have available 300 kg product.",
      },
      checks: ["targetMargin passed"],
      sources: ["product catalog", "stock data"],
      review: { model: "", verdict: "", notes: [] },
    },
    demoData,
    {
      company: "ВолгаМаш",
      subject: "Заказ грунт-эмали",
      body: "Нужно 800 кг для оборудования.",
    },
  );

  assert.equal(result.zone, "red");
  assert.equal(result.decision, "escalate");
  assert.equal(result.product.name, "Барьер 3в1");
  assert.equal(result.product.stockKg, 300);
  assert.equal(result.product.pricePerKg, 349);
  assert.equal(result.options.length, 3);
  assert.match(result.market.summary, /Цена КОЛЕР: 349 ₽\/кг/);
  assert.match(result.reply.body, /выберет руководитель/);
  assert.deepEqual(result.sources, [
    "Входящее письмо",
    "Каталог и остатки",
    "Правила продаж",
    "Срез рынка",
    "Отраслевой сценарий",
  ]);
  assert.doesNotMatch(
    JSON.stringify({
      market: result.market,
      reply: result.reply,
      checks: result.checks,
      sources: result.sources,
    }),
    /available|product catalog|stock data|targetMargin/i,
  );
});
