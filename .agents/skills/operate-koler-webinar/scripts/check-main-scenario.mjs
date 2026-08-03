#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const PROJECT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SHORTAGE_SKU = "КР-001";
const SHORTAGE_SUPPLIER = "ПромКолор Опт";
const REQUESTED_KG = 2_000;
const OWN_STOCK_KG = 300;
const OWN_PRICE_PER_KG = 349;
const SUPPLIER_STOCK_KG = 2_000;
const SUPPLIER_PRICE_PER_KG = 361;
const SUPPLIER_DELIVERY_DAYS = 4;
const SUPPLIER_CHECKED_AT = "2026-07-31 09:00";
const DEFICIT_KG = 1_700;
const TOTAL_RUB = 718_400;

function parseArgs(argv) {
  const options = { url: "", json: false, timeoutMs: 10_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--json") options.json = true;
    else if (item === "--url") options.url = argv[++index] ?? "";
    else if (item.startsWith("--url=")) options.url = item.slice(6);
    else if (item === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (item.startsWith("--timeout-ms=")) options.timeoutMs = Number(item.slice(13));
    else if (item === "--help" || item === "-h") options.help = true;
    else throw new Error(`Неизвестный аргумент: ${item}`);
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 250 || options.timeoutMs > 60_000) {
    throw new Error("--timeout-ms должен быть целым числом от 250 до 60000.");
  }
  return options;
}

function normalizedBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("--url поддерживает только http и https.");
  if (url.username || url.password) throw new Error("Не передавайте credentials внутри --url.");
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "") + "/";
  return url;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fetchJson(baseUrl, pathname, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(pathname, baseUrl), {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizedCheckedAt(value) {
  const text = String(value ?? "").trim();
  const european = /^(\d{2})\.(\d{2})\.(\d{4}),?\s+(\d{2}:\d{2})$/u.exec(text);
  return european
    ? `${european[3]}-${european[2]}-${european[1]} ${european[4]}`
    : text.replaceAll("T", " ").replace(/:00Z$/u, "");
}

function check(list, name, actual, expected, detail = "") {
  const passed = Object.is(actual, expected);
  list.push({
    status: passed ? "PASS" : "FAIL",
    name,
    actual,
    expected,
    ...(detail ? { detail } : {}),
  });
  return passed;
}

export async function runScenarioCheck({
  inventoryItems,
  marketItems,
  projectRoot = PROJECT_ROOT,
} = {}) {
  const catalog = await readJson(resolve(projectRoot, "data/paint-demo.json"));
  const { buildSupplierPlan } = await import(
    pathToFileURL(resolve(projectRoot, "lib/supplier-plan.mjs")).href
  );
  const { supplierMarketWithIds } = await import(
    pathToFileURL(resolve(projectRoot, "lib/supplier-market.mjs")).href
  );
  const sourceProduct = catalog.products.find((product) => product.sku === SHORTAGE_SKU);
  if (!sourceProduct) throw new Error(`В data/paint-demo.json отсутствует ${SHORTAGE_SKU}.`);

  const liveInventory = Array.isArray(inventoryItems) ? inventoryItems : [];
  const liveProduct = liveInventory.find((item) => item?.sku === SHORTAGE_SKU);
  const product = {
    ...sourceProduct,
    ...(liveProduct && Number.isFinite(Number(liveProduct.stockKg))
      ? { stockKg: Number(liveProduct.stockKg) }
      : {}),
  };
  const market = supplierMarketWithIds(
    Array.isArray(marketItems) ? marketItems : catalog.market,
  );
  const supplier = market.find((offer) => offer.competitor === SHORTAGE_SUPPLIER);
  const plan = buildSupplierPlan(product, market, REQUESTED_KG);
  const checks = [];

  check(checks, "SKU главного shortage-сценария", sourceProduct.sku, SHORTAGE_SKU);
  check(checks, "Запрос главного shortage-сценария", REQUESTED_KG, 2_000);
  check(checks, "Собственный остаток baseline", product.stockKg, OWN_STOCK_KG);
  check(checks, "Цена КР-001", sourceProduct.pricePerKg, OWN_PRICE_PER_KG);
  check(checks, "Дефицит считается программно", REQUESTED_KG - product.stockKg, DEFICIT_KG);
  check(checks, "Поставщик main scenario", supplier?.competitor, SHORTAGE_SUPPLIER);
  check(checks, "Snapshot supplier stock", supplier?.stockKg, SUPPLIER_STOCK_KG);
  check(checks, "Snapshot supplier price", supplier?.pricePerKg, SUPPLIER_PRICE_PER_KG);
  check(checks, "Snapshot supplier delivery", supplier?.deliveryDays, SUPPLIER_DELIVERY_DAYS);
  check(checks, "Snapshot supplier checkedAt", normalizedCheckedAt(supplier?.stockCheckedAt), SUPPLIER_CHECKED_AT);
  check(checks, "Plan ownKg", plan?.ourKg, OWN_STOCK_KG);
  check(checks, "Plan supplierKg", plan?.supplierKg, DEFICIT_KG);
  check(checks, "Plan supplierName", plan?.supplierName, SHORTAGE_SUPPLIER);
  check(checks, "Plan total", plan?.total, TOTAL_RUB);
  check(checks, "Итог рассчитан из двух частей", OWN_STOCK_KG * OWN_PRICE_PER_KG + DEFICIT_KG * SUPPLIER_PRICE_PER_KG, TOTAL_RUB);

  return {
    status: checks.some((item) => item.status === "FAIL") ? "FAIL" : "PASS",
    source: Array.isArray(inventoryItems) ? "remote-readonly-snapshot" : "local",
    contract: {
      sku: SHORTAGE_SKU,
      requestedKg: REQUESTED_KG,
      ownStockKg: OWN_STOCK_KG,
      deficitKg: DEFICIT_KG,
      ownPricePerKg: OWN_PRICE_PER_KG,
      supplier: SHORTAGE_SUPPLIER,
      supplierStockKg: SUPPLIER_STOCK_KG,
      supplierPricePerKg: SUPPLIER_PRICE_PER_KG,
      deliveryDays: SUPPLIER_DELIVERY_DAYS,
      checkedAt: SUPPLIER_CHECKED_AT,
      totalRub: TOTAL_RUB,
    },
    checks,
  };
}

function printHuman(result) {
  console.log(`SCENARIO ${result.status} (${result.source})`);
  for (const item of result.checks) {
    console.log(`${item.status.padEnd(4)} ${item.name}: ${String(item.actual)} (ожидалось ${String(item.expected)})`);
    if (item.detail) console.log(`     ${item.detail}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node check-main-scenario.mjs [--url https://stand.example] [--timeout-ms 10000] [--json]");
    return;
  }

  let inventoryItems;
  let marketItems;
  if (options.url) {
    const baseUrl = normalizedBaseUrl(options.url);
    const [inventory, market] = await Promise.all([
      fetchJson(baseUrl, "/api/inventory", options.timeoutMs),
      fetchJson(baseUrl, "/api/market", options.timeoutMs),
    ]);
    if (!Array.isArray(inventory?.items) || !Array.isArray(market?.market)) {
      throw new Error("Удалённые inventory/market имеют неожиданный формат.");
    }
    inventoryItems = inventory.items;
    marketItems = market.market;
  }

  const result = await runScenarioCheck({ inventoryItems, marketItems });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  if (result.status !== "PASS") process.exitCode = 1;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    console.error(`SCENARIO FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
