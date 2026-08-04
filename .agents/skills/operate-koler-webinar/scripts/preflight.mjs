#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { runScenarioCheck } from "./check-main-scenario.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function parseArgs(argv) {
  const options = { url: "", json: false, timeoutMs: 10_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--json") {
      options.json = true;
    } else if (item === "--url") {
      options.url = argv[++index] ?? "";
    } else if (item.startsWith("--url=")) {
      options.url = item.slice("--url=".length);
    } else if (item === "--timeout-ms") {
      options.timeoutMs = Number(argv[++index]);
    } else if (item.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number(item.slice("--timeout-ms=".length));
    } else if (item === "--help" || item === "-h") {
      options.help = true;
    } else {
      throw new Error(`Неизвестный аргумент: ${item}`);
    }
  }
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 250 ||
    options.timeoutMs > 60_000
  ) {
    throw new Error("--timeout-ms должен быть целым числом от 250 до 60000.");
  }
  return options;
}

function normalizedBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("--url поддерживает только http и https.");
  }
  if (url.username || url.password) {
    throw new Error("Не передавайте credentials внутри --url.");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "") + "/";
  return url;
}

function add(checks, level, name, detail, fallback = "") {
  checks.push({
    level,
    name,
    detail,
    ...(fallback ? { fallback } : {}),
  });
}

export function deployedSystemContract(body) {
  const models = Array.isArray(body?.models) ? body.models : [];
  const flash = models.find(
    (model) => model?.id === "deepseek/deepseek-v4-flash",
  );
  const failures = [
    ...(body?.contractRevision === "webinar-completion-v1"
      ? []
      : ["contractRevision != webinar-completion-v1"]),
    ...(body?.bridgeOnline === true ? [] : ["bridgeOnline != true"]),
    ...(body?.provider === "DeepSeek API"
      ? []
      : ["provider != DeepSeek API"]),
    ...(flash?.variant === "max" &&
    flash?.roles?.includes("primary") &&
    flash?.roles?.includes("reviewer")
      ? []
      : ["Flash/max primary+reviewer отсутствует в model catalog"]),
  ];
  return { ok: failures.length === 0, failures };
}

async function fileExists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function request(baseUrl, pathname, {
  method = "GET",
  headers = {},
  timeoutMs,
  parse = "none",
} = {}) {
  if (!["GET", "HEAD"].includes(method)) {
    throw new Error(`Read-only preflight запретил HTTP ${method}.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(pathname, baseUrl), {
      method,
      headers,
      cache: "no-store",
      signal: controller.signal,
    });
    let body = null;
    if (parse === "json") body = await response.json();
    if (parse === "text") body = await response.text();
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function readResponsePrefix(response, maxBytes = 64 * 1024) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let completed = false;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!(value instanceof Uint8Array) || value.length === 0) continue;

      const remaining = maxBytes - total;
      const newlineIndex = value.indexOf(0x0a);
      const wantedLength =
        newlineIndex >= 0
          ? Math.min(newlineIndex + 1, remaining)
          : Math.min(value.length, remaining);
      chunks.push(value.subarray(0, wantedLength));
      total += wantedLength;

      if (newlineIndex >= 0 || wantedLength < value.length || total >= maxBytes) {
        break;
      }
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }

  const prefix = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.length;
  }
  return prefix;
}

async function staticChecks(checks) {
  const requiredFiles = [
    "package.json",
    "data/paint-demo.json",
    "data/models.json",
    "opencode.json",
    "lib/order-facts.mjs",
    "lib/supplier-plan.mjs",
    "lib/supplier-market.mjs",
    "app/api/inventory/route.ts",
    "app/api/market/route.ts",
    "app/api/ledger/route.ts",
    "app/api/orders/route.ts",
    "public/fence-demo.jpg",
    "public/prompts/sales-agent.md",
    "public/prompts/reviewer.md",
    "public/prompts/vision-agent.md",
    ".opencode/agents/koler-sales.md",
    ".opencode/tools/public_webfetch.js",
    "lib/public-web-fetch.mjs",
    ".openai/hosting.json",
  ];
  const missing = [];
  for (const relativePath of requiredFiles) {
    if (!(await fileExists(resolve(PROJECT_ROOT, relativePath)))) {
      missing.push(relativePath);
    }
  }
  if (missing.length) {
    add(
      checks,
      "FAIL",
      "Локальные источники",
      `Не найдены: ${missing.join(", ")}`,
    );
    return null;
  }
  add(
    checks,
    "PASS",
    "Локальные источники",
    `${requiredFiles.length} обязательных файлов доступны`,
  );

  const [catalog, models, providerConfig, hosting, bridgeSource, readme, salesProfile, publicTool, publicFetch] = await Promise.all([
    readJson(resolve(PROJECT_ROOT, "data/paint-demo.json")),
    readJson(resolve(PROJECT_ROOT, "data/models.json")),
    readJson(resolve(PROJECT_ROOT, "opencode.json")),
    readJson(resolve(PROJECT_ROOT, ".openai/hosting.json")),
    readFile(resolve(PROJECT_ROOT, "scripts/agent-bridge.mjs"), "utf8"),
    readFile(resolve(PROJECT_ROOT, "README.md"), "utf8"),
    readFile(resolve(PROJECT_ROOT, ".opencode/agents/koler-sales.md"), "utf8"),
    readFile(resolve(PROJECT_ROOT, ".opencode/tools/public_webfetch.js"), "utf8"),
    readFile(resolve(PROJECT_ROOT, "lib/public-web-fetch.mjs"), "utf8"),
  ]);

  if (
    typeof hosting.d1 === "string" &&
    hosting.d1 &&
    typeof hosting.r2 === "string" &&
    hosting.r2
  ) {
    add(
      checks,
      "PASS",
      "Cloudflare bindings",
      "D1 и R2 bindings объявлены; идентификаторы не выводятся",
    );
  } else {
    add(
      checks,
      "FAIL",
      "Cloudflare bindings",
      "В hosting config отсутствует D1 или R2 binding",
    );
  }

  const modelIds = new Set(
    Array.isArray(models.options)
      ? models.options.map((model) => String(model?.id ?? ""))
      : [],
  );
  const flashPresent = modelIds.has("deepseek/deepseek-v4-flash");
  const defaultModel = models.options?.find((model) => model?.id === models.default);
  const deepseekProvider = providerConfig?.provider?.deepseek;
  const rolesPresent =
    flashPresent &&
    modelIds.size === 1 &&
    models.default === "deepseek/deepseek-v4-flash" &&
    defaultModel?.variant === "max" &&
    defaultModel?.roles?.includes("primary") &&
    defaultModel?.roles?.includes("reviewer") &&
    deepseekProvider?.api === "https://api.deepseek.com/v1" &&
    deepseekProvider?.env?.includes("DEEPSEEK_API_KEY") &&
    deepseekProvider?.models?.["deepseek-v4-flash"] &&
    bridgeSource.includes('const visionModel = "opencode-go/mimo-v2.5"') &&
    bridgeSource.includes(
      'const strongReviewer = "deepseek/deepseek-v4-flash"',
    ) &&
    /GPT-5\.6 Sol[\s\S]{0,180}(?:инструкц|не запуска)/u.test(readme);
  add(
    checks,
    rolesPresent ? "PASS" : "FAIL",
    "Роли моделей",
    rolesPresent
      ? "Отдельные direct Flash primary/reviewer, MiMo и подготовительная роль Sol подтверждены локально"
      : "Не подтверждены все канонические роли моделей",
  );

  add(
    checks,
    /webfetch:\s*deny/u.test(salesProfile) &&
      /public_webfetch:\s*allow/u.test(salesProfile) &&
      /fetchPublicWeb/u.test(publicTool) &&
      /url\.protocol !== "https:"/u.test(publicFetch) &&
      /pinnedAddress/u.test(publicFetch) &&
      /MAX_REDIRECTS/u.test(publicFetch) &&
      /MAX_RESPONSE_BYTES/u.test(publicFetch)
      ? "PASS"
      : "FAIL",
    "Public web transport",
    "Builtin webfetch denied; custom public_webfetch uses bounded HTTPS/DNS-pinned transport",
  );

  const scenario = await runScenarioCheck();
  add(
    checks,
    scenario.status === "PASS" ? "PASS" : "FAIL",
    "Детерминированный shortage-сценарий",
    scenario.status === "PASS"
      ? "2 000/300/1 700, ПромКолор Опт, checkedAt и target total подтверждены бизнес-логикой"
      : `${scenario.checks.filter((item) => item.status === "FAIL").length} проверок не прошли`,
  );

  return { catalog, scenario };
}

async function remoteChecks(checks, baseUrl, timeoutMs) {
  let inventoryItems = null;
  let marketItems = null;
  let ledger = null;

  try {
    const { response } = await request(baseUrl, "/", {
      method: "GET",
      timeoutMs,
    });
    const contentType = response.headers.get("content-type") ?? "";
    add(
      checks,
      response.ok && contentType.includes("text/html") ? "PASS" : "FAIL",
      "Сайт",
      `GET /: HTTP ${response.status}, ${contentType || "content-type отсутствует"}`,
    );
    await response.body?.cancel();
  } catch (error) {
    add(checks, "FAIL", "Сайт", `GET /: ${error.message}`);
  }

  try {
    const { response, body } = await request(
      baseUrl,
      "/api/orders?system=1",
      { method: "GET", timeoutMs, parse: "json" },
    );
    if (!response.ok) {
      add(
        checks,
        "FAIL",
        "Bridge status",
        `GET /api/orders?system=1: HTTP ${response.status}`,
      );
    } else {
      const contract = deployedSystemContract(body);
      add(
        checks,
        contract.ok ? "PASS" : "FAIL",
        "Deployed completion contract",
        contract.ok
          ? "Revision webinar-completion-v1, свежий heartbeat и Flash/max подтверждены"
          : contract.failures.join("; "),
        contract.ok
          ? ""
          : "Развернуть текущую web-версию, восстановить bridge и повторить read-only gate",
      );
    }
  } catch (error) {
    add(
      checks,
      "FAIL",
      "Deployed completion contract",
      error.message,
      "Восстановить bridge и повторить ту же live-карточку; не включать server fast fallback",
    );
  }

  try {
    const { response, body } = await request(baseUrl, "/api/inventory", {
      method: "GET",
      timeoutMs,
      parse: "json",
    });
    if (!response.ok || !Array.isArray(body?.items)) {
      throw new Error(`HTTP ${response.status} или неожиданный JSON`);
    }
    inventoryItems = body.items;
    add(
      checks,
      "PASS",
      "Inventory API",
      `Получено позиций: ${inventoryItems.length}`,
    );
  } catch (error) {
    add(checks, "FAIL", "Inventory API", error.message);
  }

  try {
    const { response, body } = await request(baseUrl, "/api/market", {
      method: "GET",
      timeoutMs,
      parse: "json",
    });
    if (!response.ok || !Array.isArray(body?.market)) {
      throw new Error(`HTTP ${response.status} или неожиданный JSON`);
    }
    marketItems = body.market;
    add(
      checks,
      "PASS",
      "Market API",
      `Получено предложений: ${marketItems.length}`,
    );
  } catch (error) {
    add(checks, "FAIL", "Market API", error.message);
  }

  try {
    const { response, body } = await request(
      baseUrl,
      "/api/ledger?limit=100",
      { method: "GET", timeoutMs, parse: "json" },
    );
    if (
      !response.ok ||
      body?.syntheticData !== true ||
      !Array.isArray(body?.orders) ||
      !Array.isArray(body?.events)
    ) {
      throw new Error(
        `HTTP ${response.status}, неожиданный JSON или отсутствует syntheticData=true`,
      );
    }
    ledger = body;
    add(
      checks,
      "PASS",
      "Ledger API",
      `Дневных карточек: ${body.orders.length}; событий: ${body.events.length}`,
    );
  } catch (error) {
    add(checks, "FAIL", "Ledger API", error.message);
  }

  try {
    const { response } = await request(
      baseUrl,
      "/api/ledger?format=csv",
      {
        method: "GET",
        headers: { accept: "text/csv" },
        timeoutMs,
      },
    );
    const prefix = await readResponsePrefix(response);
    const type = response.headers.get("content-type") ?? "";
    const hasBom =
      prefix.length >= 3 &&
      prefix[0] === 0xef &&
      prefix[1] === 0xbb &&
      prefix[2] === 0xbf;
    const text = new TextDecoder("utf-8").decode(prefix);
    const header = text.replace(/^\uFEFF/u, "").split(/\r?\n/u, 1)[0] ?? "";
    const hasHeader =
      header.includes('"Тип записи"') &&
      header.includes('"Дата и время"') &&
      header.includes('"Номер записи"');
    const hasLineBreak = prefix.includes(0x0a);
    const csvReady =
      response.ok &&
      type.includes("text/csv") &&
      hasBom &&
      hasHeader &&
      hasLineBreak;
    add(
      checks,
      csvReady ? "PASS" : "WARN",
      "Ledger CSV",
      `Bounded GET /api/ledger?format=csv: HTTP ${response.status}, ` +
        `${type || "content-type отсутствует"}, BOM=${hasBom}, header=${hasHeader}, body=${prefix.length > 0}`,
      csvReady
        ? ""
        : "При задержке Google показать живой ledger; до исправления CSV не проводить финальную приёмку",
    );
  } catch (error) {
    add(
      checks,
      "WARN",
      "Ledger CSV",
      error.message,
      "Показать живой ledger; не считать Google-таблицу источником состояния",
    );
  }

  const r2Source = ledger?.orders
    ?.map((order) => order?.attachment?.src)
    .find(
      (src) =>
        typeof src === "string" &&
        src.startsWith("/api/uploads?key="),
    );
  if (r2Source) {
    try {
      const { response } = await request(baseUrl, r2Source, {
        method: "GET",
        timeoutMs,
      });
      const type = response.headers.get("content-type") ?? "";
      const r2Ready = response.ok && type.startsWith("image/");
      add(
        checks,
        r2Ready ? "PASS" : "WARN",
        "R2 photo",
        `GET сохранённого тестового вложения: HTTP ${response.status}, ${type || "content-type отсутствует"}`,
        r2Ready
          ? ""
          : "Использовать public/fence-demo.jpg или продолжить текстом",
      );
      await response.body?.cancel();
    } catch (error) {
      add(
        checks,
        "WARN",
        "R2 photo",
        error.message,
        "Использовать public/fence-demo.jpg или продолжить текстом",
      );
    }
  } else {
    try {
      const { response } = await request(baseUrl, "/fence-demo.jpg", {
        method: "HEAD",
        timeoutMs,
      });
      add(
        checks,
        "WARN",
        "R2 photo",
        response.ok
          ? "Подготовленное изображение доступно, но в дневном ledger нет R2-вложения для read-only проверки"
          : `Нет R2-доказательства; fallback image вернул HTTP ${response.status}`,
        "Использовать подготовленное изображение и отдельно проверить загрузку до эфира",
      );
    } catch (error) {
      add(
        checks,
        "WARN",
        "R2 photo",
        error.message,
        "Продолжить без фото и подтвердить факты текстом",
      );
    }
  }

  if (inventoryItems && marketItems) {
    try {
      const scenario = await runScenarioCheck({
        inventoryItems,
        marketItems,
      });
      add(
        checks,
        scenario.status === "PASS" ? "PASS" : "FAIL",
        "Live baseline и сценарий",
        scenario.status === "PASS"
          ? "Read-only snapshot подтверждает shortage 2 000/300/1 700 и supplier plan"
          : scenario.checks
              .filter((item) => item.status === "FAIL")
              .map(
                (item) =>
                  `${item.name}: ${String(item.actual)} вместо ${String(item.expected)}`,
              )
              .join("; "),
      );
    } catch (error) {
      add(checks, "FAIL", "Live baseline и сценарий", error.message);
    }
  }
}

function verdictFor(checks) {
  if (checks.some((check) => check.level === "FAIL")) return "NO-GO";
  if (checks.some((check) => check.level === "WARN")) {
    return "GO WITH FALLBACK";
  }
  return "GO";
}

function printHuman(result) {
  console.log(`PREFLIGHT ${result.verdict}`);
  console.log(`Target: ${result.target}`);
  for (const check of result.checks) {
    console.log(`${check.level.padEnd(4)} ${check.name}: ${check.detail}`);
    if (check.fallback) console.log(`     fallback: ${check.fallback}`);
  }
  console.log(
    "Boundary: reserve/send — события стенда; реальная почта и ERP не подключены.",
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node preflight.mjs [--url https://stand.example] [--timeout-ms 10000] [--json]",
    );
    return;
  }

  const checks = [];
  await staticChecks(checks);
  let target = "local-only";
  if (options.url) {
    const baseUrl = normalizedBaseUrl(options.url);
    target = baseUrl.origin;
    await remoteChecks(checks, baseUrl, options.timeoutMs);
  } else {
    add(
      checks,
      "FAIL",
      "Удалённый стенд",
      "URL не передан; выполнены только локальные проверки, operational GO невозможен",
      "Перед эфиром отдельно повторить с явно разрешённым --url",
    );
  }

  const result = {
    verdict: verdictFor(checks),
    target,
    readOnlyMethods: ["GET", "HEAD"],
    checks,
  };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  if (result.verdict === "NO-GO") process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(`PREFLIGHT NO-GO: ${error.message}`);
    process.exitCode = 1;
  });
}
