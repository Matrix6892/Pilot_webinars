#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const PROJECT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SHORTAGE_SKU = "КР-001";
const SHORTAGE_SUPPLIER = "ПромКолор Опт";
const SHORTAGE_CATEGORY = "краска для металла с защитой от ржавчины";
const TARGET_OWN_STOCK_KG = 300;
const TARGET_SUPPLIER_STOCK_KG = 2_000;
const OWN_PRICE_PER_KG = 349;

function parseArgs(argv) {
  const options = { apply: false, url: "", adminCodeEnv: "", timeoutMs: 10_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--apply") options.apply = true;
    else if (item === "--url") options.url = argv[++index] ?? "";
    else if (item.startsWith("--url=")) options.url = item.slice(6);
    else if (item === "--admin-code-env") options.adminCodeEnv = argv[++index] ?? "";
    else if (item.startsWith("--admin-code-env=")) options.adminCodeEnv = item.slice(17);
    else if (item === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (item.startsWith("--timeout-ms=")) options.timeoutMs = Number(item.slice(13));
    else if (item === "--help" || item === "-h") options.help = true;
    else throw new Error(`Неизвестный аргумент: ${item}`);
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 250 || options.timeoutMs > 60_000) {
    throw new Error("--timeout-ms должен быть целым числом от 250 до 60000.");
  }
  if (options.adminCodeEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(options.adminCodeEnv)) {
    throw new Error("--admin-code-env должен содержать только имя переменной.");
  }
  if (options.apply && !options.url) throw new Error("--apply требует явный --url.");
  return options;
}

function normalizedBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("--url поддерживает только http и https.");
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (url.protocol === "http:" && !loopback.has(url.hostname.toLocaleLowerCase("en-US"))) {
    throw new Error("HTTP допустим только для loopback; удалённый target требует HTTPS.");
  }
  if (url.username || url.password) throw new Error("Не передавайте credentials внутри --url.");
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "") + "/";
  return url;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function requestJson(baseUrl, pathname, { method = "GET", headers = {}, body, timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(pathname, baseUrl), {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function catalogState() {
  const catalog = await readJson(resolve(PROJECT_ROOT, "data/paint-demo.json"));
  const own = catalog.products.find((product) => product.sku === SHORTAGE_SKU);
  const supplier = catalog.market.find(
    (offer) => offer.competitor === SHORTAGE_SUPPLIER && offer.category === SHORTAGE_CATEGORY,
  );
  if (!own || !supplier) throw new Error("Локальный catalog не содержит shortage baseline.");
  return {
    inventory: {
      sku: own.sku,
      stockKg: own.stockKg,
      revision: "local-catalog",
      pricePerKg: own.pricePerKg,
    },
    market: {
      id: "local-catalog",
      competitor: supplier.competitor,
      category: supplier.category,
      stockKg: supplier.stockKg,
      pricePerKg: supplier.pricePerKg,
      deliveryDays: supplier.deliveryDays,
      stockCheckedAt: supplier.stockCheckedAt,
    },
  };
}

async function currentState(baseUrl, timeoutMs) {
  const [inventoryResult, marketResult, catalog] = await Promise.all([
    requestJson(baseUrl, "/api/inventory", { timeoutMs }),
    requestJson(baseUrl, "/api/market", { timeoutMs }),
    readJson(resolve(PROJECT_ROOT, "data/paint-demo.json")),
  ]);
  if (!inventoryResult.response.ok || !Array.isArray(inventoryResult.data?.items)) {
    throw new Error(`GET /api/inventory не подтвердил состояние: HTTP ${inventoryResult.response.status}.`);
  }
  if (!marketResult.response.ok || !Array.isArray(marketResult.data?.market)) {
    throw new Error(`GET /api/market не подтвердил состояние: HTTP ${marketResult.response.status}.`);
  }
  const product = catalog.products.find((item) => item.sku === SHORTAGE_SKU);
  const inventory = inventoryResult.data.items.find((item) => item?.sku === SHORTAGE_SKU);
  const market = marketResult.data.market.find(
    (item) => item?.competitor === SHORTAGE_SUPPLIER && item?.category === SHORTAGE_CATEGORY,
  );
  if (!product || !inventory || !Number.isSafeInteger(inventory.stockKg) || !Number.isSafeInteger(inventory.revision)) {
    throw new Error(`В inventory отсутствует корректный ${SHORTAGE_SKU}.`);
  }
  if (!market || typeof market.id !== "string" || !Number.isSafeInteger(market.stockKg)) {
    throw new Error(`В market отсутствует корректная строка «${SHORTAGE_SUPPLIER}».`);
  }
  return {
    inventory: {
      sku: inventory.sku,
      stockKg: inventory.stockKg,
      revision: inventory.revision,
      pricePerKg: product.pricePerKg,
    },
    market: {
      id: market.id,
      competitor: market.competitor,
      category: market.category,
      stockKg: market.stockKg,
      pricePerKg: market.pricePerKg,
      deliveryDays: market.deliveryDays,
      stockCheckedAt: typeof market.stockCheckedAt === "string" ? market.stockCheckedAt : "",
    },
  };
}

async function readCode(options) {
  if (options.adminCodeEnv) {
    const code = process.env[options.adminCodeEnv]?.trim() ?? "";
    if (!code) throw new Error(`Переменная ${options.adminCodeEnv} пуста; значение не выводится.`);
    return code;
  }
  if (process.stdin.isTTY) throw new Error("Передайте код через stdin или --admin-code-env; аргумент командной строки запрещён.");
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1_024) throw new Error("Ввод кода слишком длинный.");
  }
  const code = input.trim();
  if (!code) throw new Error("stdin не содержит код администратора.");
  return code;
}

function cookieFrom(response) {
  const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0]?.trim() ?? "";
  if (!cookie || !cookie.includes("=")) throw new Error("Admin endpoint не вернул session cookie.");
  return cookie;
}

async function authenticate(baseUrl, code, timeoutMs) {
  const { response, data } = await requestJson(baseUrl, "/api/admin", {
    method: "POST",
    body: { code },
    timeoutMs,
  });
  if (!response.ok || data?.authenticated !== true) throw new Error(`Авторизация не выполнена: HTTP ${response.status}.`);
  return cookieFrom(response);
}

async function patchInventory(baseUrl, cookie, { stockKg, expectedRevision, reason }, timeoutMs) {
  const { response, data } = await requestJson(baseUrl, "/api/inventory", {
    method: "PATCH",
    headers: { cookie },
    body: { sku: SHORTAGE_SKU, stockKg, expectedRevision, reason },
    timeoutMs,
  });
  if (!response.ok || !data?.item) throw new Error(`PATCH /api/inventory не выполнен: HTTP ${response.status}.`);
  return data.item;
}

async function patchMarket(baseUrl, cookie, { id, stockKg }, timeoutMs) {
  const { response, data } = await requestJson(baseUrl, "/api/market", {
    method: "PATCH",
    headers: { cookie },
    body: { id, stockKg },
    timeoutMs,
  });
  if (!response.ok || !Array.isArray(data?.market)) throw new Error(`PATCH /api/market не выполнен: HTTP ${response.status}.`);
  const selected = data.market.find((offer) => offer?.id === id);
  if (!selected || selected.stockKg !== stockKg) throw new Error("PATCH /api/market не подтвердил состояние строки.");
  return { id: selected.id, stockKg: selected.stockKg, stockCheckedAt: selected.stockCheckedAt };
}

function printPlan(state, target) {
  console.log("RESET SHORTAGE BASELINE DRY-RUN");
  console.log(`Target: ${target}`);
  console.log(`${SHORTAGE_SKU}: ${state.inventory.stockKg} → ${TARGET_OWN_STOCK_KG} кг`);
  console.log(`${SHORTAGE_SUPPLIER}: ${state.market.stockKg} → ${TARGET_SUPPLIER_STOCK_KG} кг`);
  console.log(`Price: canonical ${OWN_PRICE_PER_KG} ₽/кг; runtime snapshot ${state.inventory.pricePerKg} ₽/кг`);
  console.log("Writes: none. Добавьте --apply только после явного разрешения.");
  console.log("Cards/history: не изменяются и не удаляются.");
}

async function restoreOriginal({ baseUrl, cookie, original, applied, timeoutMs }) {
  const failures = [];
  let current;
  try {
    current = await currentState(baseUrl, timeoutMs);
  } catch (error) {
    return [`не удалось перечитать состояние перед rollback: ${error.message}`];
  }
  if (applied.market) {
    failures.push(`market: automatic rollback запрещён без caller-visible revision; после reset вручную проверьте ${original.market.stockKg} кг.`);
  }
  if (applied.inventory) {
    const unchanged = current.inventory.stockKg === applied.inventory.stockKg && current.inventory.revision === applied.inventory.revision;
    if (!unchanged) {
      failures.push(`inventory: параллельное изменение после reset; текущая revision ${current.inventory.revision}.`);
    } else {
      try {
        await patchInventory(baseUrl, cookie, {
          stockKg: original.inventory.stockKg,
          expectedRevision: applied.inventory.revision,
          reason: "Откат незавершённого shortage baseline",
        }, timeoutMs);
      } catch (error) {
        failures.push(`inventory: ${error.message}`);
      }
    }
  }
  return failures;
}

async function applyBaseline(baseUrl, options, code) {
  const original = await currentState(baseUrl, options.timeoutMs);
  const cookie = await authenticate(baseUrl, code, options.timeoutMs);
  const applied = { inventory: null, market: null };
  let committed = false;
  let operationError = null;
  let rollbackFailures = [];
  try {
    if (original.inventory.stockKg !== TARGET_OWN_STOCK_KG) {
      applied.inventory = await patchInventory(baseUrl, cookie, {
        stockKg: TARGET_OWN_STOCK_KG,
        expectedRevision: original.inventory.revision,
        reason: "Канонический main shortage baseline",
      }, options.timeoutMs);
    }
    if (original.market.stockKg !== TARGET_SUPPLIER_STOCK_KG) {
      applied.market = await patchMarket(baseUrl, cookie, {
        id: original.market.id,
        stockKg: TARGET_SUPPLIER_STOCK_KG,
      }, options.timeoutMs);
    }
    const verified = await currentState(baseUrl, options.timeoutMs);
    if (verified.inventory.stockKg !== TARGET_OWN_STOCK_KG || verified.market.stockKg !== TARGET_SUPPLIER_STOCK_KG) {
      throw new Error(`Проверка baseline не прошла: ${SHORTAGE_SKU}=${verified.inventory.stockKg}, ${SHORTAGE_SUPPLIER}=${verified.market.stockKg}.`);
    }
    committed = true;
  } catch (error) {
    operationError = error;
  } finally {
    if (!committed) rollbackFailures = await restoreOriginal({ baseUrl, cookie, original, applied, timeoutMs: options.timeoutMs });
  }
  if (operationError) {
    if (rollbackFailures.length) throw new Error(`${operationError.message} Rollback incomplete: ${rollbackFailures.join("; ")}`);
    throw operationError;
  }
  console.log("RESET SHORTAGE BASELINE APPLIED");
  console.log(`Target: ${baseUrl.origin}`);
  console.log(`${SHORTAGE_SKU}: ${TARGET_OWN_STOCK_KG} кг`);
  console.log(`${SHORTAGE_SUPPLIER}: ${TARGET_SUPPLIER_STOCK_KG} кг`);
  console.log("Verification: GET inventory/market PASS.");
  console.log("Cards/history: не изменялись и не удалялись.");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node reset-baseline.mjs [--url https://stand.example] [--apply] [--admin-code-env NAME] [--timeout-ms 10000]");
    console.log("Без --apply выполняется только local/remote dry-run; apply требует явного URL и admin authorization.");
    return;
  }
  const baseUrl = options.url ? normalizedBaseUrl(options.url) : null;
  if (!options.apply) {
    const state = baseUrl ? await currentState(baseUrl, options.timeoutMs) : await catalogState();
    printPlan(state, baseUrl?.origin ?? "local-catalog-only");
    return;
  }
  const code = await readCode(options);
  await applyBaseline(baseUrl, options, code);
}

main().catch((error) => {
  console.error(`RESET BASELINE FAILED: ${error.message}`);
  process.exitCode = 1;
});
