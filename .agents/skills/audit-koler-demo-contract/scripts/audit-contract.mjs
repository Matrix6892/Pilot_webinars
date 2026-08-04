#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSupplierPlan } from "../../../../lib/supplier-plan.mjs";
import { supplierMarketWithIds } from "../../../../lib/supplier-market.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(scriptDirectory, "..");
const repoRoot = resolve(skillRoot, "../../..");

const args = process.argv.slice(2);
let format = "markdown";
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--help" || argument === "-h") {
    console.log(`Usage: node audit-contract.mjs [--format=markdown|console]

Runs a read-only Koler contract audit. The repository root is resolved from
this script, so the command works from any current working directory.

Exit codes:
  0  no P0/P1 findings (P2 notes are allowed)
  1  at least one P0/P1 contract drift
  2  invalid command-line arguments`);
    process.exit(0);
  }
  if (argument === "--format" && args[index + 1]) {
    format = args[index + 1];
    index += 1;
    continue;
  }
  if (argument.startsWith("--format=")) {
    format = argument.slice("--format=".length);
    continue;
  }
  console.error(`Unknown argument: ${argument}`);
  process.exit(2);
}
if (!["markdown", "console"].includes(format)) {
  console.error(`Unsupported format: ${format}`);
  process.exit(2);
}

const coreFiles = [
  "README.md",
  "docs/ARCHITECTURE-AND-WEBINAR.md",
  "docs/AGENT-BEHAVIOR-STANDARD.md",
  "docs/WEBINAR-RUNBOOK.md",
  "data/models.json",
  "opencode.json",
  "data/paint-demo.json",
  ".openai/hosting.json",
  ".opencode/agents/koler-sales.md",
  ".opencode/agents/koler-sales-local.md",
  ".opencode/agents/koler-reviewer.md",
  ".opencode/tools/public_webfetch.js",
  "public/prompts/sales-agent.md",
  "public/prompts/reviewer.md",
  "public/prompts/vision-agent.md",
  "public/prompts/improver.md",
  "lib/demo-engine.ts",
  "lib/agent-guard.mjs",
  "lib/upload-guard.mjs",
  "lib/public-web-fetch.mjs",
  "lib/admin-auth.ts",
  "lib/ledger-export.mjs",
  "db/index.ts",
  "scripts/agent-bridge.mjs",
  "app/api/agent/route.ts",
  "app/api/orders/route.ts",
  "app/api/uploads/route.ts",
  "app/api/ledger/route.ts",
  "app/api/inventory/route.ts",
  "app/api/market/route.ts",
  "app/order-stand.tsx",
  "tests/agent-guard.test.mjs",
  "tests/vision-bridge.test.mjs",
  "tests/public-web-fetch.test.mjs",
  "tests/agent-contract-v2.test.mjs",
  "tests/flow-integrity.test.mjs",
  "tests/run-webinar-probes.mjs",
  ".agents/skills/operate-koler-webinar/SKILL.md",
  ".agents/skills/operate-koler-webinar/references/canonical-scenario.md",
  ".agents/skills/operate-koler-webinar/references/recovery-matrix.md",
  ".agents/skills/operate-koler-webinar/scripts/check-main-scenario.mjs",
  ".agents/skills/operate-koler-webinar/scripts/preflight.mjs",
  ".agents/skills/operate-koler-webinar/scripts/reset-baseline.mjs",
  ".agents/skills/operate-koler-webinar/workflows/preflight-readonly.md",
  ".agents/skills/operate-koler-webinar/workflows/rehearse-main-scenario.md",
  ".agents/skills/operate-koler-webinar/workflows/restore-baseline.md",
  ".agents/skills/evaluate-koler-agent-rules/scripts/check-eval-readiness.mjs",
  ".agents/skills/manage-koler-changes/scripts/check-change-contract.mjs",
];

const findings = [];
const fileCache = new Map();
const missingFiles = new Set();

function portablePath(file) {
  return file.split("\\").join("/");
}

function relativePath(absolutePath) {
  return portablePath(relative(repoRoot, absolutePath));
}

async function loadText(file) {
  if (fileCache.has(file)) return fileCache.get(file);
  try {
    const text = await readFile(resolve(repoRoot, file), "utf8");
    fileCache.set(file, text);
    return text;
  } catch {
    missingFiles.add(file);
    fileCache.set(file, "");
    return "";
  }
}

await Promise.all(coreFiles.map(loadText));

function lineNumberAt(text, offset) {
  if (offset < 0) return 1;
  return text.slice(0, offset).split(/\r?\n/).length;
}

function regexWithoutState(regex) {
  return new RegExp(regex.source, regex.flags.replaceAll("g", ""));
}

function location(file, regex, fallbackLine = 1) {
  const text = fileCache.get(file) ?? "";
  const match = regexWithoutState(regex).exec(text);
  return `${file}:${match ? lineNumberAt(text, match.index) : fallbackLine}`;
}

function matches(file, regex) {
  return regexWithoutState(regex).test(fileCache.get(file) ?? "");
}

function addFinding({
  severity,
  claim,
  canonical,
  conflicts,
  detail,
}) {
  findings.push({
    severity,
    claim,
    canonical: [...new Set(canonical.filter(Boolean))],
    conflicts: [...new Set(conflicts.filter(Boolean))],
    detail,
  });
}

for (const file of missingFiles) {
  addFinding({
    severity: file.startsWith("docs/") || file === "README.md" ? "P1" : "P0",
    claim: `Обязательный contract surface существует: ${file}`,
    canonical: [`${file}:1`],
    conflicts: [`${file}:1`],
    detail: `Аудит не смог прочитать обязательный файл \`${file}\`.`,
  });
}

function requirePattern({
  file,
  pattern,
  anchors,
  severity = "P1",
  claim,
  canonical = [],
  detail,
}) {
  const requiredAnchors = anchors ?? [{ file, pattern }];
  const missingAnchors = requiredAnchors.filter(
    ({ file: anchorFile, pattern: anchorPattern }) =>
      !matches(anchorFile, anchorPattern),
  );
  if (!missingAnchors.length) return;
  addFinding({
    severity,
    claim,
    canonical,
    conflicts: [
      ...new Set(
        missingAnchors.map(({ file: anchorFile }) => `${anchorFile}:1`),
      ),
    ],
    detail,
  });
}

function parseJson(file, severity = "P0") {
  try {
    return JSON.parse(fileCache.get(file) ?? "");
  } catch (error) {
    addFinding({
      severity,
      claim: `${file} содержит валидный JSON`,
      canonical: [`${file}:1`],
      conflicts: [`${file}:1`],
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

const modelCatalog = parseJson("data/models.json");
const providerConfig = parseJson("opencode.json");
const demoData = parseJson("data/paint-demo.json");
const hosting = parseJson(".openai/hosting.json");

const modelContract = {
  primary: "deepseek/deepseek-v4-flash",
  reviewer: "deepseek/deepseek-v4-flash",
  vision: "opencode-go/mimo-v2.5",
};

if (modelCatalog) {
  const ids = new Set(
    Array.isArray(modelCatalog.options)
      ? modelCatalog.options.map((option) => option?.id)
      : [],
  );
  const flashModel = modelCatalog.options?.find(
    (option) => option?.id === modelContract.primary,
  );
  if (
    modelCatalog.default !== modelContract.primary ||
    ids.size !== 1 ||
    !ids.has(modelContract.primary) ||
    !ids.has(modelContract.reviewer) ||
    !flashModel?.roles?.includes("primary") ||
    !flashModel?.roles?.includes("reviewer")
  ) {
    addFinding({
      severity: "P1",
      claim: "Каталог моделей использует direct Flash для отдельных primary и reviewer запусков",
      canonical: [
        location("scripts/agent-bridge.mjs", /const strongReviewer\s*=/u),
        location("data/models.json", /"roles"/u),
      ],
      conflicts: [location("data/models.json", /"default"/u)],
      detail:
        "Изменение каталога моделей не согласовано с runtime-ролями и публичным описанием.",
    });
  }
}

const directProvider = providerConfig?.provider?.deepseek;
if (
  directProvider?.api !== "https://api.deepseek.com/v1" ||
  !directProvider?.env?.includes("DEEPSEEK_API_KEY") ||
  !directProvider?.models?.["deepseek-v4-flash"] ||
  Number(directProvider?.models?.["deepseek-v4-flash"]?.limit?.output) !== 65_536
) {
  addFinding({
    severity: "P1",
    claim: "Default primary использует официальный DeepSeek API без встроенного секрета",
    canonical: [location("data/models.json", /deepseek\/deepseek-v4-flash/u)],
    conflicts: [location("opencode.json", /"provider"/u)],
    detail: "Direct Flash provider, output cap или secret-env contract не согласованы с runtime catalog.",
  });
}

const roleChecks = [
  {
    file: "scripts/agent-bridge.mjs",
    pattern: /const strongReviewer\s*=\s*"deepseek\/deepseek-v4-flash"/u,
    claim: "DeepSeek V4 Flash выполняет отдельную reviewer-проверку",
    canonical: [location("data/models.json", /"roles"/u)],
  },
  {
    file: "scripts/agent-bridge.mjs",
    pattern: /const visionModel\s*=\s*"opencode-go\/mimo-v2\.5"/u,
    claim: "MiMo V2.5 используется только как vision-модель",
    canonical: [location("public/prompts/vision-agent.md", /Ты изучаешь фотографию/u)],
  },
  {
    file: "public/prompts/improver.md",
    pattern: /GPT-5\.6 Sol[\s\S]{0,180}не участвует\s+в обработке заказов/iu,
    claim: "GPT-5.6 Sol не участвует в повседневной обработке заказов",
    canonical: [location("README.md", /GPT-5\.6 Sol подготовила/u)],
  },
  {
    file: ".opencode/agents/koler-sales.md",
    pattern: /webfetch:\s*deny[\s\S]{0,80}public_webfetch:\s*allow[\s\S]{0,2000}Discovery:\s*одна HTML-выдача Brave Search/u,
    claim: "Sales-профиль запрещает builtin webfetch и разрешает только custom public_webfetch",
    canonical: [location(".opencode/tools/public_webfetch.js", /fetchPublicWeb/u)],
  },
  {
    file: ".opencode/agents/koler-sales-local.md",
    pattern: /permission:[\s\S]{0,80}"\*":\s*deny/u,
    claim: "Offline-профиль запрещает внешние инструменты",
    canonical: [location("scripts/agent-bridge.mjs", /agent:\s*"koler-sales-local"/u)],
  },
  {
    file: ".opencode/tools/public_webfetch.js",
    pattern: /fetchPublicWeb\(args\.url\)/u,
    claim: "Custom public_webfetch uses the bounded public transport",
    canonical: [location("lib/public-web-fetch.mjs", /export async function fetchPublicWeb/u)],
  },
];
for (const check of roleChecks) {
  requirePattern({
    ...check,
    detail: `Surface \`${check.file}\` расходится с закреплённой ролью модели.`,
  });
}

for (const file of [
  "README.md",
  "docs/ARCHITECTURE-AND-WEBINAR.md",
  "docs/WEBINAR-RUNBOOK.md",
]) {
  const absent = [
    ["MiMo V2.5", /MiMo V2\.5/u],
    ["DeepSeek V4 Flash", /DeepSeek V4 Flash|deepseek-v4-flash/u],
    ["отдельный Flash reviewer", /(?:(?:отдельн|независим)\p{L}*[\s\S]{0,100}DeepSeek V4 Flash|DeepSeek V4 Flash[\s\S]{0,100}(?:отдельн|независим)\p{L}*)/iu],
    ["GPT-5.6 Sol", /GPT-5\.6 Sol/u],
  ].filter(([, pattern]) => !matches(file, pattern));
  if (absent.length) {
    addFinding({
      severity: "P1",
      claim: `${file} согласованно объясняет четыре runtime-роли`,
      canonical: [location("docs/WEBINAR-RUNBOOK.md", /Роли моделей разделены/u)],
      conflicts: [`${file}:1`],
      detail: `Не найдены роли: ${absent.map(([name]) => name).join(", ")}.`,
    });
  }
}

const domainFirstDocs = [
  ["README.md", /неименованн[а-яё]* «покрасить это»[\s\S]{0,300}неодушевлённ[а-яё]* объект[\s\S]{0,260}человек[\s\S]{0,120}контекст/iu],
  ["docs/ARCHITECTURE-AND-WEBINAR.md", /неименованн[а-яё]* цел[а-яё]*[\s\S]{0,260}разумн[а-яё]* неодушевлённ[а-яё]* объект[\s\S]{0,260}человек[\s\S]{0,120}контекст/iu],
  ["docs/AGENT-BEHAVIOR-STANDARD.md", /Domain-first selection[\s\S]{0,300}разумн[а-яё]* неодушевлённ[а-яё]* объект[\s\S]{0,260}человек[\s\S]{0,120}контекст/iu],
  ["docs/WEBINAR-RUNBOOK.md", /покрасить это[\s\S]{0,240}разумн[а-яё]* неодушевлённ[а-яё]* объект[\s\S]{0,200}человек[\s\S]{0,100}контекст/iu],
];
for (const [file, pattern] of domainFirstDocs) {
  requirePattern({
    file,
    pattern,
    claim: `${file} описывает domain-first выбор цели без человеческой альтернативы по умолчанию`,
    canonical: [location("public/prompts/sales-agent.md", /vision\.targetCandidates.*наблюдения/u)],
    detail: "Активная документация должна выбирать разумный неодушевлённый объект и считать человека контекстом без явного указания клиента.",
  });
}

for (const file of [
  "README.md",
  "docs/ARCHITECTURE-AND-WEBINAR.md",
  "docs/WEBINAR-RUNBOOK.md",
]) {
  requirePattern({
    file,
    pattern: /node tests\/run-webinar-probes\.mjs --url "\$STAND_URL" --json/u,
    claim: `${file} использует deployed API runner как обязательный webinar gate`,
    canonical: [
      location("tests/run-webinar-probes.mjs", /export const PROBES/u),
      location("tests/run-webinar-probes.mjs", /runConcurrentProbe/u),
    ],
    detail: "Практический webinar gate должен проходить API, upload, polling и действия пользователя, а не прямой model runner.",
  });
  requirePattern({
    file,
    pattern: /KOLER_LIVE_REPEAT=3[\s\S]{0,420}wow-02-washer-sports-car[\s\S]{0,120}wow-03-hostile-grill[\s\S]{0,120}wow-08-two-ton-shortage[\s\S]{0,120}wow-09-red-curtain-reference/iu,
    claim: `${file} использует текущие четыре family для формальной проверки повторяемости`,
    canonical: [location("tests/run-agent-wow-live.mjs", /export const WEBINAR_CASE_IDS/u)],
    detail: "Необязательная release-серия 4 × 3 должна совпадать с WEBINAR_CASE_IDS runtime runner.",
  });
  if (matches(file, /KOLER_LIVE_REPEAT=3[\s\S]{0,420}wow-01-equal-targets/iu)) {
    addFinding({
      severity: "P1",
      claim: `${file} не включает diagnostic ambiguity case в release-серию`,
      canonical: [location("tests/run-agent-wow-live.mjs", /export const WEBINAR_CASE_IDS/u)],
      conflicts: [location(file, /KOLER_LIVE_REPEAT=3/u)],
      detail: "wow-01 остаётся диагностическим bonus-case и не входит в формальную release-серию.",
    });
  }
}

const activeNoVersionClaimFiles = [
  "README.md",
  "docs/ARCHITECTURE-AND-WEBINAR.md",
  "docs/WEBINAR-RUNBOOK.md",
  ".opencode/agents/koler-sales.md",
  ".opencode/tools/public_webfetch.js",
  "scripts/agent-bridge.mjs",
];
for (const file of activeNoVersionClaimFiles) {
  const text = fileCache.get(file) ?? "";
  const unsupportedDatedClaim = [...text.matchAll(/0731/gu)].some(
    ({ index = 0 }) => {
      const context = text.slice(
        Math.max(0, index - 140),
        Math.min(text.length, index + 180),
      );
      return !/не\s+(?:подтвержд|доказ|утвержд|публику|датирован)|без\s+(?:подтвержд|доказ)/iu.test(
        context,
      );
    },
  );
  if (unsupportedDatedClaim) {
    addFinding({
      severity: "P1",
      claim: `${file} не делает недоказанного Flash version claim`,
      canonical: [location("data/models.json", /deepseek-v4-flash/u)],
      conflicts: [location(file, /0731/u)],
      detail: "Rolling Flash alias не доказывает существование конкретной версии.",
    });
  }
}

const researchEvidence = [
  location(".opencode/agents/koler-sales.md", /Открой каждую страницу/u),
  location("public/prompts/sales-agent.md", /Ставь `research\.checked=true`/u),
  location("scripts/agent-bridge.mjs", /openedSourceUrls/u),
  location("lib/agent-guard.mjs", /openedResearchSources/u),
  location("tests/agent-guard.test.mjs", /research\.checked,\s*true/u),
];
const readmeUncheckedClaim =
  /Текущий профиль `koler-sales` не подтверждает открытие страниц[\s\S]{0,180}research\.checked=false/iu;
if (
  matches("README.md", readmeUncheckedClaim) &&
  matches(".opencode/agents/koler-sales.md", /Открой каждую страницу/u) &&
  matches("scripts/agent-bridge.mjs", /openedSourceUrls/u)
) {
  addFinding({
    severity: "P1",
    claim: "Открытые и использованные публичные страницы могут дать research.checked=true",
    canonical: researchEvidence,
    conflicts: [location("README.md", readmeUncheckedClaim)],
    detail:
      "README описывает профиль как неспособный подтвердить открытие страниц, но profile, prompt, bridge, guard и regression поддерживают подтверждённые источники.",
  });
}

const researchPathChecks = [
  {
    file: "README.md",
    pattern: /### Выбор источников и продолжение карточки(?:(?!\n#{2,3}\s)[\s\S])*Модель сама решает, нужен ли поиск(?:(?!\n#{2,3}\s)[\s\S])*Regex-router не\s+включает и не выключает инструмент/u,
    claim: "README фиксирует LLM-first search без regex-router",
  },
  {
    file: "tests/vision-bridge.test.mjs",
    anchors: [
      {
        file: "tests/vision-bridge.test.mjs",
        pattern: /test\("keeps photo and non-photo work inside one 650 second job budget"/u,
      },
      {
        file: "tests/vision-bridge.test.mjs",
        pattern: /assert\.match\(\s*processJob,\s*\/runPrimaryWithRetry\\\(\\\{\[\\s\\S\]\*\?agent:\\s\*"koler-sales"\[\\s\\S\]\*\?publishResearch:\\s\*true\//u,
      },
      {
        file: "tests/vision-bridge.test.mjs",
        pattern: /assert\.doesNotMatch\(processJob, \/allowsPublicSearch\//u,
      },
    ],
    claim: "Executable test закрепляет web-tools для каждого свободного primary run",
  },
  {
    file: "public/prompts/sales-agent.md",
    pattern: /Каждый использованный внешний факт должен\s+иметь открытый URL/u,
    claim: "Prompt требует открытый URL для каждого использованного web-факта",
  },
  {
    file: "scripts/agent-bridge.mjs",
    anchors: [
      {
        file: "scripts/agent-bridge.mjs",
        pattern: /const urls =\s*evidenceTool && completed\s*\?\s*observedUrls\.filter\(\(url\) => !isSearchResultUrl\(url\)\)\s*:\s*\[\];/u,
      },
      {
        file: "scripts/agent-bridge.mjs",
        pattern: /function openedSourceUrlsFromTools\(tools\)[\s\S]{0,420}tool\?\.tool === "public_webfetch"\s*&&\s*tool\.completed === true\s*&&\s*tool\.failed !== true/u,
      },
      {
        file: "scripts/agent-bridge.mjs",
        pattern: /attemptOpenedSourceUrls\s*=\s*openedSourceUrlsFromTools\(primaryRun\.tools\);/u,
      },
      {
        file: "scripts/agent-bridge.mjs",
        pattern: /openedSourceUrls:\s*verifiedOpenedSourceUrls,\s*openedSources:\s*\[[\s\S]{0,350}\.\.\.openedSourcesFromTools\(primaryRun\.tools\)/u,
      },
      {
        file: "scripts/agent-bridge.mjs",
        pattern: /catch \(primaryError\)[\s\S]{0,500}attemptOpenedSourceUrls\s*=\s*openedSourceUrlsFromTools\(\s*primaryError\.partialRun\.tools,\s*\);[\s\S]{0,500}openedSourceUrls:\s*verifiedOpenedSourceUrls/u,
      },
    ],
    claim: "Bridge передаёт guard только наблюдаемые открытые страницы",
  },
  {
    file: "lib/agent-guard.mjs",
    pattern: /openedResearchSources[\s\S]{0,500}allResearchClaimsGrounded/u,
    claim: "Guard связывает checked=true с открытыми и grounded sources",
  },
  {
    file: "scripts/agent-bridge.mjs",
    pattern: /agent:\s*"koler-sales-local"[\s\S]{0,300}primaryRetryPrompt/u,
    claim: "Synthesis retry использует локальный профиль без нового поиска",
  },
];
for (const check of researchPathChecks) {
  requirePattern({
    ...check,
    canonical: researchEvidence,
    detail: `Не найден обязательный элемент research pipeline в \`${check.file}\`.`,
  });
}

const publicWebChecks = [
  {
    file: "scripts/agent-bridge.mjs",
    pattern: /const evidenceTool = tool === "public_webfetch"[\s\S]{0,260}legacyWebTool[\s\S]{0,220}urls =\s*evidenceTool/u,
    claim: "Bridge accepts evidence only from completed custom public_webfetch events",
  },
  {
    file: "lib/public-web-fetch.mjs",
    anchors: [
      {
        file: "lib/public-web-fetch.mjs",
        pattern: /export function validatePublicHttpsUrl\(input\)/u,
      },
      {
        file: "lib/public-web-fetch.mjs",
        pattern: /url\.protocol !== "https:"[\s\S]{0,220}isForbiddenHostname\(hostname\)/u,
      },
      {
        file: "lib/public-web-fetch.mjs",
        pattern: /export async function resolvePublicTarget\(input, resolveAll = defaultResolveAll\)/u,
      },
      {
        file: "lib/public-web-fetch.mjs",
        pattern: /!addresses\.length \|\| !addresses\.every\(isGlobalUnicastAddress\)/u,
      },
      {
        file: "lib/public-web-fetch.mjs",
        pattern: /pinnedAddress:\s*addresses\[0\]/u,
      },
      {
        file: "lib/public-web-fetch.mjs",
        pattern: /servername:\s*target\.hostname/u,
      },
      {
        file: "lib/public-web-fetch.mjs",
        pattern: /lookup\(_hostname, options, callback\)[\s\S]{0,220}options\?\.all[\s\S]{0,220}address:\s*target\.pinnedAddress[\s\S]{0,220}callback\(null, target\.pinnedAddress, family\)/u,
      },
      {
        file: "lib/public-web-fetch.mjs",
        pattern: /while \(true\) \{\s*const target = await resolvePublicTarget\(current, resolveAll\);\s*const response = await requestPinnedHttps\(target,/u,
      },
    ],
    claim: "Public web transport validates HTTPS, DNS and pinned public targets",
  },
  {
    file: "lib/public-web-fetch.mjs",
    pattern: /MAX_REDIRECTS[\s\S]{0,2000}MAX_RESPONSE_BYTES[\s\S]{0,2000}allowedContentTypes/u,
    claim: "Public web transport bounds redirects, response size and content type",
  },
  {
    file: ".opencode/tools/public_webfetch.js",
    pattern: /public HTTPS page through the SSRF-safe Koler transport/u,
    claim: "OpenCode exposes only the SSRF-safe custom public tool",
  },
  {
    file: "README.md",
    pattern: /custom `public_webfetch`|custom public_webfetch/u,
    claim: "README names custom public_webfetch rather than builtin webfetch",
  },
  {
    file: "docs/ARCHITECTURE-AND-WEBINAR.md",
    pattern: /custom `public_webfetch`|custom public_webfetch/u,
    claim: "Architecture names custom public_webfetch and its public egress boundary",
  },
];
for (const check of publicWebChecks) {
  requirePattern({
    ...check,
    canonical: [
      location(".opencode/agents/koler-sales.md", /public_webfetch:\s*allow/u),
      location("lib/public-web-fetch.mjs", /validatePublicHttpsUrl/u),
    ],
    detail: `Не доказана public_webfetch boundary в \`${check.file}\`.`,
  });
}

const activeScenarioToolChecks = [
  {
    file: ".agents/skills/operate-koler-webinar/references/canonical-scenario.md",
    pattern: /КР-001[\s\S]{0,600}ПромКолор Опт[\s\S]{0,600}2 000 кг[\s\S]{0,600}1 700 кг/u,
    claim: "Operate reference uses the shortage scenario as main",
  },
  {
    file: ".agents/skills/operate-koler-webinar/scripts/check-main-scenario.mjs",
    pattern: /const SHORTAGE_SKU = "КР-001"[\s\S]{0,160}ПромКолор Опт/u,
    claim: "Main scenario checker targets KР-001 and ПромКолор Опт",
  },
  {
    file: ".agents/skills/operate-koler-webinar/scripts/reset-baseline.mjs",
    pattern: /const SHORTAGE_SKU = "КР-001"[\s\S]{0,180}SHORTAGE_SUPPLIER/u,
    claim: "Reset dry-run/apply targets shortage baseline only",
  },
  {
    file: ".agents/skills/operate-koler-webinar/scripts/preflight.mjs",
    anchors: [
      {
        file: ".agents/skills/operate-koler-webinar/scripts/preflight.mjs",
        pattern: /const options = \{ url: "", json: false, timeoutMs: 10_000 \};/u,
      },
      {
        file: ".agents/skills/operate-koler-webinar/scripts/preflight.mjs",
        pattern: /let target = "local-only";/u,
      },
      {
        file: ".agents/skills/operate-koler-webinar/scripts/preflight.mjs",
        pattern: /if \(options\.url\) \{[\s\S]{0,220}await remoteChecks\(checks, baseUrl, options\.timeoutMs\);[\s\S]{0,80}\} else \{[\s\S]{0,120}add\(\s*checks,\s*"FAIL",\s*"Удалённый стенд"/u,
      },
      {
        file: ".agents/skills/operate-koler-webinar/scripts/preflight.mjs",
        pattern: /function verdictFor\(checks\)\s*\{\s*if \(checks\.some\(\(check\) => check\.level === "FAIL"\)\) return "NO-GO";/u,
      },
      {
        file: ".agents/skills/operate-koler-webinar/scripts/preflight.mjs",
        pattern: /if \(result\.verdict === "NO-GO"\) process\.exitCode = 1;/u,
      },
    ],
    claim: "Default preflight remains local-only and cannot claim GO",
  },
  {
    file: ".agents/skills/operate-koler-webinar/references/recovery-matrix.md",
    pattern: /bridge-offline[\s\S]{0,500}(?:recover live|explicitly choose recorded|recorded)/iu,
    claim: "Recovery matrix has no silent server fast fallback",
  },
];
for (const check of activeScenarioToolChecks) {
  requirePattern({
    ...check,
    canonical: [
      location("data/paint-demo.json", /"sku": "КР-001"/u),
      location("README.md", /Канонический shortage-сценарий/u),
    ],
    detail: `Active operator tooling is stale in \`${check.file}\`.`,
  });
}

const agentContractChecks = [
  {
    file: "lib/demo-engine.ts",
    pattern: /export type AgentResult\s*=\s*\{[\s\S]{0,500}schemaVersion:\s*2;[\s\S]{0,500}resolvedIntent:\s*ResolvedIntent;[\s\S]{0,500}estimates:\s*RangeEstimate\[\];[\s\S]{0,500}supplierLeads:\s*SupplierLead\[\];/u,
    claim: "TypeScript задаёт полный AgentResult v2",
  },
  {
    file: "lib/demo-engine.ts",
    pattern: /export type ResolvedAsk[\s\S]{0,300}evidenceIds:\s*string\[\][\s\S]{0,300}asks:\s*ResolvedAsk\[\]/u,
    claim: "ResolvedIntent v2 перечисляет явные просьбы клиента",
  },
  {
    file: "public/prompts/sales-agent.md",
    pattern: /## Компактный JSON-draft[\s\S]{0,1800}"schemaVersion": 2[\s\S]{0,500}"resolvedIntent"[\s\S]{0,1000}"commitment"[\s\S]{0,500}"reply"/u,
    claim: "Primary prompt задаёт компактное обязательное ядро v2",
  },
  {
    file: "public/prompts/sales-agent.md",
    pattern: /Программный guard сам\s+построит полный `AgentResult v2`/u,
    claim: "Prompt явно делегирует производные legacy-поля guard",
  },
  {
    file: "lib/agent-guard.mjs",
    pattern: /export function normalizeV2AgentResult[\s\S]{0,12000}schemaVersion:\s*2[\s\S]{0,12000}zone:\s*"yellow"[\s\S]{0,500}route:\s*"ready"/u,
    claim: "Guard достраивает полный маршрут AgentResult v2",
  },
  {
    file: "lib/agent-guard.mjs",
    pattern: /export function askCoverageGaps\(job, result\)[\s\S]{0,3500}\.map\(\(\{ request \}\) => request\)/u,
    claim: "Guard универсально проверяет покрытие всех asks",
  },
  {
    file: "public/prompts/reviewer.md",
    pattern: /resolvedIntent\.asks[\s\S]{0,300}полным последним сообщением[\s\S]{0,200}material_utility/u,
    claim: "Reviewer независимо блокирует пропущенную просьбу",
  },
];
for (const check of agentContractChecks) {
  requirePattern({
    ...check,
    canonical: [
      location("lib/demo-engine.ts", /export type AgentResult/u),
      location("lib/agent-guard.mjs", /export function isCompleteAgentResult/u),
    ],
    detail: `Не доказана согласованная v2-граница в \`${check.file}\`.`,
  });
}

const agentSurfaceChecks = [
  {
    file: "scripts/agent-bridge.mjs",
    anchors: [
      {
        file: "scripts/agent-bridge.mjs",
        pattern: /\bresult\s*=\s*normalizeV2AgentResult\(/u,
      },
      {
        file: "scripts/agent-bridge.mjs",
        pattern: /function resultPayload\(\s*job,\s*result,\s*openedSourceUrls,\s*agentModel,\s*reviewerModel,\s*reviewerProvenance,\s*openedSources,\s*\)\s*\{\s*return\s*\{\s*action:\s*"result",\s*\.\.\.claimPayload\(job\),\s*result,/u,
      },
      {
        file: "scripts/agent-bridge.mjs",
        pattern: /await agentRequestWithRetry\(\s*resultPayload\(\s*job,\s*result,\s*verifiedOpenedSourceUrls,\s*primaryModel,\s*reviewerModel,\s*reviewerProvenance,\s*guardedJob\.openedSources,\s*\),\s*"POST",\s*terminalTimeoutMs,\s*\);/u,
      },
    ],
    claim: "Bridge нормализует и отправляет AgentResult",
  },
  {
    file: "app/api/agent/route.ts",
    pattern: /isCompleteAgentResult\(result\)[\s\S]{0,3000}JSON\.stringify\(agentResult\)/u,
    claim: "Agent API валидирует и сохраняет AgentResult",
  },
  {
    file: "app/order-stand.tsx",
    pattern: /import type \{ AgentResult \}[\s\S]*result\.research\?\.checked/u,
    claim: "UI типизированно читает AgentResult и research state",
  },
  {
    file: "app/api/ledger/route.ts",
    anchors: [
      {
        file: "app/api/ledger/route.ts",
        pattern: /result:\s*projectLedgerOrder\(order\)\.result,/u,
      },
      {
        file: "app/api/ledger/route.ts",
        pattern: /result:\s*null,/u,
      },
      {
        file: "app/api/ledger/route.ts",
        pattern: /:\s*\(rawOrders as Array<PublicLedgerOrder>\)\.map\(syntheticLedgerOrder\);/u,
      },
      {
        file: "lib/ledger-export.mjs",
        pattern: /export function decodeStoredAgentResultForLedger\(value\)[\s\S]{0,320}isCompleteAgentResult\(decoded\)[\s\S]{0,160}return !Object\.hasOwn\(parsed, "schemaVersion"\) \? decoded : null;/u,
      },
      {
        file: "lib/ledger-export.mjs",
        pattern: /export function projectLedgerOrder\(order\)\s*\{[\s\S]{0,240}decodeStoredAgentResultForLedger\(order\.resultJson\)[\s\S]{0,120}resultJson:\s*undefined/u,
      },
    ],
    claim: "JSON ledger публикует bounded сохранённый AgentResult",
  },
  {
    file: "lib/ledger-export.mjs",
    pattern: /result\?\.reply[\s\S]{0,3000}result\?\.zoneReason/u,
    claim: "CSV ledger наблюдаемо экспортирует письмо и основание AgentResult",
  },
];
for (const check of agentSurfaceChecks) {
  requirePattern({
    ...check,
    canonical: [location("lib/demo-engine.ts", /export type AgentResult/u)],
    detail: `Не доказана сквозная AgentResult surface в \`${check.file}\`.`,
  });
}

const scenarioContract = {
  sku: "КР-001",
  requestedKg: 2_000,
  ownBaselineKg: 300,
  ownPricePerKg: 349,
  deficitKg: 1_700,
  supplier: "ПромКолор Опт",
  supplierStockKg: 2_000,
  supplierPricePerKg: 361,
  deliveryDays: 4,
  checkedAt: "2026-07-31 09:00",
  total: 718_400,
};

function exactNumberPattern(value) {
  const digits = String(value).split("");
  return new RegExp(
    `(?<!\\d)${digits.join("[\\s\\u00a0\\u202f]*")}(?!\\d)`,
    "u",
  );
}

function quantityPattern(value) {
  const source = exactNumberPattern(value).source;
  return new RegExp(`${source}[\\s\\u00a0\\u202f]*кг`, "iu");
}

function moneyPattern(value) {
  const source = exactNumberPattern(value).source;
  return new RegExp(`${source}[\\s\\u00a0\\u202f]*₽`, "u");
}

function findProduct(data, sku) {
  return Array.isArray(data?.products)
    ? data.products.find((product) => product?.sku === sku)
    : null;
}

function findOffer(data, competitor) {
  return Array.isArray(data?.market)
    ? data.market.find((offer) => offer?.competitor === competitor)
    : null;
}

function normalizedCheckedAt(value) {
  const text = String(value ?? "").trim();
  const european = /^(\d{2})\.(\d{2})\.(\d{4}),?\s+(\d{2}:\d{2})$/u.exec(text);
  return european
    ? `${european[3]}-${european[2]}-${european[1]} ${european[4]}`
    : text.replaceAll("T", " ").replace(/:00Z$/u, "");
}

const shortageProduct = findProduct(demoData, scenarioContract.sku);
const supplierOffer = findOffer(demoData, scenarioContract.supplier);
const scenarioEvidence = [
  location("data/paint-demo.json", /"sku": "КР-001"/u),
  location("data/paint-demo.json", /"competitor": "ПромКолор Опт"/u),
  location("tests/agent-contract-v2.test.mjs", /2000 kg order/u),
];

if (
  !shortageProduct ||
  Number(shortageProduct.stockKg) !== scenarioContract.ownBaselineKg ||
  !supplierOffer ||
  Number(supplierOffer.stockKg) !== scenarioContract.supplierStockKg ||
  Number(supplierOffer.pricePerKg) !== scenarioContract.supplierPricePerKg ||
  Number(supplierOffer.deliveryDays) !== scenarioContract.deliveryDays ||
  normalizedCheckedAt(supplierOffer.stockCheckedAt) !== scenarioContract.checkedAt
) {
  addFinding({
    severity: "P1",
    claim: "Demo data сохраняет baseline главного shortage-сценария",
    canonical: [
      location("README.md", /Канонический shortage-сценарий/u),
      location("docs/ARCHITECTURE-AND-WEBINAR.md", /Канонический webinar fixture/u),
    ],
    conflicts: scenarioEvidence,
    detail:
      "КР-001, 300 кг, supplier snapshot ПромКолор Опт, цена, срок или checkedAt расходятся с active shortage contract.",
  });
}

if (shortageProduct && Number(shortageProduct.pricePerKg) !== scenarioContract.ownPricePerKg) {
  addFinding({
    severity: "P1",
    claim: "Runtime KР-001 own price matches the active shortage contract",
    canonical: [location("data/paint-demo.json", /"sku": "КР-001"/u)],
    conflicts: [location("data/paint-demo.json", /"pricePerKg"/u)],
    detail: `Canonical price is ${scenarioContract.ownPricePerKg} ₽/кг, runtime data contains ${shortageProduct.pricePerKg} ₽/кг.`,
  });
}

const scenarioMarket = supplierMarketWithIds(demoData?.market);
const scenarioProduct = shortageProduct
  ? { ...shortageProduct, stockKg: scenarioContract.ownBaselineKg }
  : null;
const shortagePlan = scenarioProduct
  ? buildSupplierPlan(
      scenarioProduct,
      scenarioMarket,
      scenarioContract.requestedKg,
    )
  : null;
const planChecks = [
  ["supplier", shortagePlan?.supplierName, scenarioContract.supplier],
  ["ourKg", shortagePlan?.ourKg, scenarioContract.ownBaselineKg],
  ["supplierKg", shortagePlan?.supplierKg, scenarioContract.deficitKg],
  ["supplierPricePerKg", shortagePlan?.supplierPricePerKg, scenarioContract.supplierPricePerKg],
  ["deliveryDays", shortagePlan?.deliveryDays, scenarioContract.deliveryDays],
  ["total", shortagePlan?.total, scenarioContract.total],
];
for (const [name, actual, expected] of planChecks) {
  if (actual !== expected) {
    addFinding({
      severity: "P1",
      claim: `Shortage plan ${name} matches canonical contract`,
      canonical: scenarioEvidence,
      conflicts: [location("lib/supplier-plan.mjs", /buildSupplierPlan/u)],
      detail: `Expected ${String(expected)}, received ${String(actual)}.`,
    });
  }
}

const briefArithmetic =
  scenarioContract.ownBaselineKg * scenarioContract.ownPricePerKg +
  scenarioContract.deficitKg * scenarioContract.supplierPricePerKg;
if (briefArithmetic !== scenarioContract.total) {
  addFinding({
    severity: "P1",
    claim: "Canonical shortage price and total are arithmetically consistent",
    canonical: scenarioEvidence,
    conflicts: [location("README.md", /718\s*400/u)],
    detail: `${scenarioContract.ownBaselineKg} × ${scenarioContract.ownPricePerKg} + ${scenarioContract.deficitKg} × ${scenarioContract.supplierPricePerKg} = ${briefArithmetic}, not ${scenarioContract.total}.`,
  });
}

const scenarioDocs = [
  {
    file: "README.md",
    quantities: [scenarioContract.requestedKg, scenarioContract.ownBaselineKg, scenarioContract.deficitKg],
    money: [scenarioContract.total],
    severity: "P1",
    anchor: /Канонический shortage-сценарий/u,
  },
  {
    file: "docs/ARCHITECTURE-AND-WEBINAR.md",
    quantities: [scenarioContract.requestedKg, scenarioContract.ownBaselineKg, scenarioContract.deficitKg],
    money: [scenarioContract.total],
    severity: "P1",
    anchor: /Канонический webinar fixture/u,
  },
  {
    file: "docs/WEBINAR-RUNBOOK.md",
    quantities: [scenarioContract.requestedKg, scenarioContract.ownBaselineKg, scenarioContract.deficitKg],
    money: [scenarioContract.total],
    severity: "P1",
    anchor: /Как пройти главный живой сценарий/u,
  },
];
for (const surface of scenarioDocs) {
  const missing = [
    ...surface.quantities
      .filter((value) => !matches(surface.file, quantityPattern(value)))
      .map((value) => `${value} кг`),
    ...surface.money
      .filter(
        (value) =>
          Number.isFinite(value) && !matches(surface.file, moneyPattern(value)),
      )
      .map((value) => `${value} ₽`),
  ];
  if (missing.length) {
    addFinding({
      severity: surface.severity,
      claim: `${surface.file} сохраняет числа главного сценария`,
      canonical: scenarioEvidence,
      conflicts: [location(surface.file, surface.anchor)],
      detail: `Не найдены ожидаемые значения с единицами: ${missing.join(", ")}.`,
    });
  }
}

const secondaryScenarioChecks = [
  [
    "README.md",
    /Вторич(?:ный|ная|ное|ные)\/legacy regression example[^\n]*\n?[^\n]{0,80}620 кг/iu,
  ],
  [
    "docs/ARCHITECTURE-AND-WEBINAR.md",
    /### Контроль управляемого сценария ПРОТЕК\s+Старый складской эпизод остаётся локальной проверкой причинности/u,
  ],
  [
    "docs/WEBINAR-RUNBOOK.md",
    /(?:вторичн[а-яё]*|secondary|legacy)[^\n]{0,100}ПРОТЕК[^\n]*\n[^\n]{0,100}отдельн[а-яё]* локальн[а-яё]* проверк[а-яё]*/iu,
  ],
  [
    ".agents/skills/operate-koler-webinar/references/canonical-scenario.md",
    /<secondary_legacy>[\s\S]{0,160}<fact>ПРОТЕК 620\/420\/260\/150\/700 — только secondary\/legacy regression\.<\/fact>[\s\S]{0,240}<forbidden>Не использовать его как main scenario/u,
  ],
];
for (const [file, pattern] of secondaryScenarioChecks) {
  if (!matches(file, pattern)) {
    addFinding({
      severity: "P1",
      claim: `${file} labels the old ПРОТЕК scenario as secondary/legacy`,
      canonical: scenarioEvidence,
      conflicts: [location(file, /ПРОТЕК/iu)],
      detail: "The 620/420/260/150/700 scenario must not be active main, reset, default demo, or GO policy.",
    });
  }
}

const expectedScenarioValues = [
  scenarioContract.requestedKg,
  scenarioContract.ownBaselineKg,
  scenarioContract.deficitKg,
  scenarioContract.ownPricePerKg,
  scenarioContract.supplierPricePerKg,
  scenarioContract.total,
].filter(Number.isFinite);

const allTestFiles = [];
async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    const rel = relativePath(absolute);
    const pathSegments = rel.split("/");
    if (
      entry.isDirectory() &&
      ([".git", ".next", ".wrangler", "dist", "node_modules"].some(
        (excluded) => pathSegments.includes(excluded),
      ) ||
        rel === ".agents/skills" ||
        rel.startsWith(".agents/skills/"))
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      await collectFiles(absolute);
      continue;
    }
    if (!entry.isFile()) continue;
    if (
      rel.startsWith("tests/") ||
      [".md", ".ts", ".tsx", ".js", ".mjs", ".json", ".jsonc", ".sql"].includes(
        extname(entry.name),
      )
    ) {
      if (!/(?:package-lock|bun\.lock|pnpm-lock)/u.test(entry.name)) {
        allTestFiles.push(rel);
      }
    }
  }
}
await collectFiles(repoRoot);
await Promise.all(allTestFiles.map(loadText));

function numericLiteral(value) {
  return Number(String(value).replaceAll("_", ""));
}

function constantMs(name) {
  const text = fileCache.get("scripts/agent-bridge.mjs") ?? "";
  const match = new RegExp(
    `const\\s+${name}\\s*=\\s*([\\d_]+)`,
    "u",
  ).exec(text);
  return match ? numericLiteral(match[1]) : Number.NaN;
}

const primaryTimeoutMs = constantMs("primaryOpenCodeTimeoutMs");
const synthesisTimeoutMs = constantMs("openCodeTimeoutMs");
const visionTimeoutMs = constantMs("visionOpenCodeTimeoutMs");
const reviewerTimeoutMs = constantMs("reviewerOpenCodeTimeoutMs");
const modelDeadlineMs = constantMs("jobDeadlineMs");
const renewalMs = constantMs("leaseRenewalMs");
const leaseMatch = /JOB_LEASE_SECONDS\s*=\s*(\d+)/u.exec(
  fileCache.get("app/api/agent/route.ts") ?? "",
);
const leaseMs = leaseMatch ? Number(leaseMatch[1]) * 1000 : Number.NaN;
const hasJobLeaseRenewal =
  /const stopLeaseRenewal = startLeaseRenewal\(job\)[\s\S]{0,30000}stopLeaseRenewal\(\)/u.test(
    fileCache.get("scripts/agent-bridge.mjs") ?? "",
  ) &&
  /action:\s*"renew"[\s\S]{0,120}claimPayload\(job\)/u.test(
    fileCache.get("scripts/agent-bridge.mjs") ?? "",
  );
if (
  ![leaseMs, renewalMs, modelDeadlineMs].every(Number.isFinite) ||
  renewalMs >= leaseMs ||
  modelDeadlineMs <= leaseMs ||
  !hasJobLeaseRenewal
) {
  addFinding({
    severity: "P1",
    claim: "90-секундная processing lease продлевается каждые 30 секунд с claim fencing",
    canonical: [
      location("app/api/agent/route.ts", /JOB_LEASE_SECONDS/u),
      location("scripts/agent-bridge.mjs", /const leaseRenewalMs/u),
      location("scripts/agent-bridge.mjs", /function startLeaseRenewal/u),
      location("tests/flow-integrity.test.mjs", /renewable 90 second lease/u),
    ],
    conflicts: [location("scripts/agent-bridge.mjs", /const jobDeadlineMs/u)],
    detail:
      "Длинная model chain безопасна только при job-specific renewal быстрее истечения lease.",
  });
}

const timeoutContract = [
  ["vision", visionTimeoutMs, 180, /180\s+секунд/iu],
  ["primary", primaryTimeoutMs, 600, /600\s+секунд/u],
  ["synthesis", synthesisTimeoutMs, 300, /300[- ]секунд|300\s+секунд/iu],
  ["reviewer", reviewerTimeoutMs, 300, /300\s+секунд/iu],
  ["deadline", modelDeadlineMs, 650, /650\s+секунд/iu],
];
for (const [name, actualMs, expectedSeconds, docsPattern] of timeoutContract) {
  const actualSeconds = Number.isFinite(actualMs) ? actualMs / 1000 : Number.NaN;
  if (actualSeconds !== expectedSeconds || !matches("README.md", docsPattern)) {
    addFinding({
      severity: "P1",
      claim: `${name} model-chain budget matches runtime and operator docs`,
      canonical: [location("scripts/agent-bridge.mjs", new RegExp(`const\\s+${name === "vision" ? "visionOpenCodeTimeoutMs" : name === "primary" ? "primaryOpenCodeTimeoutMs" : name === "synthesis" ? "openCodeTimeoutMs" : name === "reviewer" ? "reviewerOpenCodeTimeoutMs" : "jobDeadlineMs"}` , "u"))],
      conflicts: [location("README.md", docsPattern)],
      detail: `Expected ${expectedSeconds}s, runtime has ${String(actualSeconds)}s.`,
    });
  }
}

for (const file of [
  "README.md",
  "docs/ARCHITECTURE-AND-WEBINAR.md",
  "docs/WEBINAR-RUNBOOK.md",
]) {
  requirePattern({
    file,
    pattern: /660\s+секунд/iu,
    claim: `${file} фиксирует deployed operational limit 660 секунд от POST`,
    canonical: [
      location("tests/run-webinar-probes.mjs", /OPERATIONAL_LIMIT_MS = 660_000/u),
    ],
    detail: "Bridge budget 650 секунд от claim и deployed limit 660 секунд от POST не должны смешиваться.",
  });
}

const sharedDeadlineAnchors = [
  /function stageTimeoutForDeadline\([\s\S]{0,500}deadlineMs - elapsedMs - reservedMs - terminationGraceMs/u,
  /const jobStartedAtMs = performance\.now\(\);[\s\S]{0,2500}visionObservationForJob\(\s*job,\s*jobStartedAtMs/u,
  /const downloadTimeoutMs = stageTimeoutForDeadline\([\s\S]{0,300}IMAGE_DOWNLOAD_TIMEOUT_MS[\s\S]{0,180}jobDeadlineMs/u,
  /const visionTimeoutMs = stageTimeoutForDeadline\([\s\S]{0,300}visionOpenCodeTimeoutMs[\s\S]{0,180}jobDeadlineMs/u,
  /const primaryTimeoutMs = stageTimeoutForDeadline\([\s\S]{0,300}primaryOpenCodeTimeoutMs[\s\S]{0,180}jobDeadlineMs/u,
  /const synthesisTimeoutMs = stageTimeoutForDeadline\([\s\S]{0,300}openCodeTimeoutMs[\s\S]{0,180}jobDeadlineMs/u,
  /const reviewerTimeoutMs = stageTimeoutForDeadline\([\s\S]{0,300}reviewerOpenCodeTimeoutMs[\s\S]{0,180}jobDeadlineMs/u,
  /const terminalTimeoutMs = stageTimeoutForDeadline\([\s\S]{0,300}agentApiTimeoutMs[\s\S]{0,180}jobDeadlineMs/u,
];
if (
  !sharedDeadlineAnchors.every((pattern) =>
    matches("scripts/agent-bridge.mjs", pattern),
  )
) {
  addFinding({
    severity: "P1",
    claim: "Every model stage is constrained by the remaining shared deadline",
    canonical: [
      location("scripts/agent-bridge.mjs", /function stageTimeoutForDeadline/u),
      location("tests/vision-bridge.test.mjs", /keeps photo and non-photo work inside one 650 second job budget/u),
    ],
    conflicts: [location("scripts/agent-bridge.mjs", /const jobDeadlineMs/u)],
    detail: "Vision download, vision, primary, synthesis, reviewer and terminal publication must derive timeout from one remaining job budget.",
  });
}

function limitRule(file, name) {
  const text = fileCache.get(file) ?? "";
  const match = new RegExp(
    `name:\\s*"${name}"[\\s\\S]{0,180}?max:\\s*(\\d+)[\\s\\S]{0,100}?windowSeconds:\\s*(\\d+)`,
    "u",
  ).exec(text);
  return match
    ? {
        max: Number(match[1]),
        windowSeconds: Number(match[2]),
        location: `${file}:${lineNumberAt(text, match.index)}`,
      }
    : null;
}

const limits = [
  limitRule("app/api/orders/route.ts", "orders-minute"),
  limitRule("app/api/orders/route.ts", "orders-stand-minute"),
  limitRule("app/api/orders/route.ts", "order-actions-minute"),
  limitRule("app/api/orders/route.ts", "order-actions-stand-minute"),
  limitRule("app/api/uploads/route.ts", "uploads-ten-minutes"),
  limitRule("app/api/uploads/route.ts", "uploads-stand-ten-minutes"),
];
const queueMatch = /Number\(queue\?\.total\s*\?\?\s*0\)\s*>=\s*(\d+)/u.exec(
  fileCache.get("app/api/orders/route.ts") ?? "",
);
const queueLimit = queueMatch ? Number(queueMatch[1]) : Number.NaN;
const limitValues = limits.filter(Boolean).map((rule) => rule.max);
if (Number.isFinite(queueLimit)) limitValues.push(queueLimit);
const missingLimitValues = limitValues.filter(
  (value) => !matches("README.md", exactNumberPattern(value)),
);
if (limits.some((rule) => !rule) || !Number.isFinite(queueLimit)) {
  addFinding({
    severity: "P1",
    claim: "Runtime содержит все документированные rate/queue limits",
    canonical: [location("README.md", /Стенд принимает от одного посетителя/u)],
    conflicts: [
      location("app/api/orders/route.ts", /orders-minute/u),
      location("app/api/uploads/route.ts", /uploads-ten-minutes/u),
    ],
    detail: "Одна или несколько limit rules не найдены.",
  });
} else if (missingLimitValues.length) {
  addFinding({
    severity: "P1",
    claim: "README совпадает с runtime rate/queue limits",
    canonical: limits.filter(Boolean).map((rule) => rule.location),
    conflicts: [location("README.md", /Стенд принимает от одного посетителя/u)],
    detail: `README не содержит runtime-значения: ${missingLimitValues.join(", ")}.`,
  });
}

const uploadBytesMatch = /MAX_UPLOAD_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/u.exec(
  fileCache.get("lib/upload-guard.mjs") ?? "",
);
const uploadMiB = uploadBytesMatch ? Number(uploadBytesMatch[1]) : Number.NaN;
if (
  !Number.isFinite(uploadMiB) ||
  !matches("README.md", new RegExp(`до\\s+${uploadMiB}\\s+МиБ`, "iu"))
) {
  addFinding({
    severity: "P1",
    claim: "Документированный upload limit совпадает с runtime",
    canonical: [location("lib/upload-guard.mjs", /MAX_UPLOAD_BYTES/u)],
    conflicts: [location("README.md", /PNG или WebP размером/u)],
    detail: "Размер изображения в README расходится с upload guard.",
  });
}

if (hosting) {
  const bindingProblems = [];
  if (hosting.d1 !== "DB") bindingProblems.push(`d1=${String(hosting.d1)}`);
  if (hosting.r2 !== "UPLOADS") bindingProblems.push(`r2=${String(hosting.r2)}`);
  if (bindingProblems.length) {
    addFinding({
      severity: "P0",
      claim: "Hosting bindings совпадают с runtime DB и UPLOADS",
      canonical: [
        location("db/index.ts", /env\.DB/u),
        location("app/api/uploads/route.ts", /\.UPLOADS/u),
      ],
      conflicts: [location(".openai/hosting.json", /"d1"/u)],
      detail: `Несовпадающие bindings: ${bindingProblems.join(", ")}.`,
    });
  }
}

const bindingChecks = [
  {
    file: "docs/ARCHITECTURE-AND-WEBINAR.md",
    pattern: /D1 как `DB`,?\s*(?:а\s+)?R2 как `UPLOADS`/u,
    claim: "Архитектура называет реальные DB/R2 bindings",
  },
  {
    file: "scripts/agent-bridge.mjs",
    pattern: /BRIDGE_TOKEN is required/u,
    claim: "Bridge требует BRIDGE_TOKEN",
  },
  {
    file: "app/api/agent/route.ts",
    pattern: /BRIDGE_TOKEN/u,
    claim: "Agent API проверяет тот же BRIDGE_TOKEN",
  },
  {
    file: "lib/admin-auth.ts",
    pattern: /KOLER_ADMIN_CODE/u,
    claim: "Admin mutations требуют KOLER_ADMIN_CODE",
  },
];
for (const check of bindingChecks) {
  requirePattern({
    ...check,
    severity: check.file.startsWith("docs/") ? "P1" : "P0",
    canonical: [location(".openai/hosting.json", /"d1"/u)],
    detail: `Не найден обязательный binding/secret contract в \`${check.file}\`.`,
  });
}

const endpointClaims = [
  ["/api/uploads", "app/api/uploads/route.ts", true],
  ["/api/agent", "app/api/agent/route.ts", false],
  ["/api/orders", "app/api/orders/route.ts", true],
  ["/api/ledger", "app/api/ledger/route.ts", true],
  ["/api/inventory", "app/api/inventory/route.ts", false],
  ["/api/market", "app/api/market/route.ts", true],
];
for (const [endpoint, file, documented] of endpointClaims) {
  if (
    documented &&
    !matches("README.md", new RegExp(endpoint.replaceAll("/", "\\/"), "u"))
  ) {
    addFinding({
      severity: "P2",
      claim: `README перечисляет работающий endpoint ${endpoint}`,
      canonical: [`${file}:1`],
      conflicts: [location("README.md", /Где у агента/u)],
      detail: `Endpoint ${endpoint} существует, но не найден в интеграционном описании README.`,
    });
  }
}

const boundaryChecks = [
  {
    file: "README.md",
    pattern: /не создают резерв в учётной системе и не доставляют письмо/u,
    claim: "README не называет D1-события реальным резервом или письмом",
    severity: "P1",
  },
  {
    file: "docs/WEBINAR-RUNBOOK.md",
    pattern: /Связь с[\s\S]{0,100}учётной и складской системой[\s\S]{0,100}не создаёт фактический[\s\S]{0,30}резерв/u,
    claim: "Операторский runbook фиксирует отсутствие ERP-резерва",
    severity: "P1",
  },
  {
    file: "README.md",
    pattern: /Смысл vision-наблюдения не проверяется отдельной vision-моделью/u,
    claim: "README фиксирует границу независимой проверки vision",
    severity: "P1",
  },
  {
    file: "README.md",
    pattern: /Публичный журнал\s+предназначен только для учебных данных/u,
    claim: "README ограничивает публичный ledger учебными данными",
    severity: "P0",
  },
  {
    file: "app/api/ledger/route.ts",
    pattern: /syntheticData:\s*true/u,
    claim: "Ledger API маркирует публичные данные как synthetic",
    severity: "P0",
  },
  {
    file: "scripts/agent-bridge.mjs",
    pattern: /vision-fallback[\s\S]{0,220}Агент продолжает по тексту[\s\S]{0,120}не использует необработанное фото как доказательство/u,
    claim: "Vision failure продолжает по тексту без сырого фото как evidence",
    severity: "P1",
  },
];
for (const check of boundaryChecks) {
  requirePattern({
    ...check,
    canonical: [
      location("README.md", /В текущем стенде форма играет роль входящей почты/u),
      location("app/api/ledger/route.ts", /syntheticData:\s*true/u),
    ],
    detail: `Не доказана integration boundary в \`${check.file}\`.`,
  });
}

const severityOrder = { P0: 0, P1: 1, P2: 2 };
findings.sort(
  (left, right) =>
    severityOrder[left.severity] - severityOrder[right.severity] ||
    left.claim.localeCompare(right.claim, "ru"),
);

const scanFiles = [...new Set(allTestFiles)].sort();

function dependencyLocations(regex, contextRegex = null, files = scanFiles) {
  const result = [];
  for (const file of files) {
    const text = fileCache.get(file) ?? "";
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (
        regexWithoutState(regex).test(line) &&
        (!contextRegex || regexWithoutState(contextRegex).test(line))
      ) {
        result.push(`${file}:${index + 1}`);
      }
    });
  }
  return [...new Set(result)];
}

const modelDependencies = {
  "MiMo V2.5": dependencyLocations(/MiMo V2\.5|mimo-v2\.5/iu),
  "DeepSeek V4 Flash": dependencyLocations(
    /DeepSeek V4 Flash|deepseek-v4-flash/iu,
  ),
  "GPT-5.6 Sol": dependencyLocations(/GPT-5\.6 Sol/iu),
};

const scenarioScanFiles = scanFiles.filter(
  (file) =>
    [
      "README.md",
      "docs/ARCHITECTURE-AND-WEBINAR.md",
      "docs/WEBINAR-RUNBOOK.md",
      "data/paint-demo.json",
      "db/index.ts",
      "app/order-stand.tsx",
    ].includes(file) || file.startsWith("tests/"),
);
const quantityValues = new Set([
  scenarioContract.requestedKg,
  scenarioContract.ownBaselineKg,
]);
const quantityCodeContext =
  /\b(?:stockKg|stock_kg|requestedKg|ourKg|supplierKg|supplierStockKg|beforeRestock|afterRestock|onStockChange|onMarketStockChange|buildSupplierPlan)\b|КР-003/u;
const moneyCodeContext = /\b(?:total|ourSubtotal|supplierSubtotal)\b/u;

function scenarioDependencyLocations(value) {
  const result = [];
  const number = exactNumberPattern(value);
  const quantity = quantityValues.has(value);
  for (const file of scenarioScanFiles) {
    const lines = (fileCache.get(file) ?? "").split(/\r?\n/);
    lines.forEach((line, index) => {
      const proseMatch = quantity
        ? regexWithoutState(quantityPattern(value)).test(line)
        : regexWithoutState(moneyPattern(value)).test(line);
      const codeMatch =
        regexWithoutState(number).test(line) &&
        regexWithoutState(
          quantity ? quantityCodeContext : moneyCodeContext,
        ).test(line);
      if (proseMatch || codeMatch) result.push(`${file}:${index + 1}`);
    });
  }
  return [...new Set(result)];
}

const scenarioDependencies = Object.fromEntries(
  expectedScenarioValues.map((value) => [
    String(value),
    scenarioDependencyLocations(value),
  ]),
);

const agentResultDependencies = {
  producer: [
    location("lib/demo-engine.ts", /export type AgentResult/u),
    location("public/prompts/sales-agent.md", /## Формат результата/u),
  ],
  guard: [
    location("lib/agent-guard.mjs", /isCompleteAgentResult/u),
    location("lib/agent-guard.mjs", /normalizeAgentResult/u),
  ],
  bridge: [location("scripts/agent-bridge.mjs", /normalizeAgentResult/u)],
  persistence: [
    location("app/api/agent/route.ts", /isCompleteAgentResult/u),
    location("db/schema.ts", /resultJson/u),
  ],
  consumers: [
    location("app/order-stand.tsx", /import type \{ AgentResult \}/u),
    location("app/api/ledger/route.ts", /decodeStoredJson/u),
    location("lib/ledger-export.mjs", /const result =/u),
  ],
};

const blocking = findings.some((finding) =>
  ["P0", "P1"].includes(finding.severity),
);
const status = blocking
  ? "FAIL"
  : findings.some((finding) => finding.severity === "P2")
    ? "PASS WITH P2"
    : "PASS";
const exitCode = blocking ? 1 : 0;

function markdownLocations(items) {
  return items.length
    ? items.map((item) => `\`${item}\``).join("<br>")
    : "—";
}

function markdownReport() {
  const lines = [
    "# Аудит demo-контракта «Колер»",
    "",
    `- Репозиторий: \`${repoRoot}\``,
    `- Результат: **${status}**`,
    `- Exit code: \`${exitCode}\``,
    "- Режим: `read-only`",
    "",
    "## Findings",
    "",
    "| Severity | Claim | Canonical evidence | Conflicts |",
    "|---|---|---|---|",
  ];
  if (!findings.length) {
    lines.push("| — | Расхождений не найдено | — | — |");
  } else {
    for (const finding of findings) {
      lines.push(
        `| ${finding.severity} | ${finding.claim.replaceAll("|", "\\|")} | ${markdownLocations(
          finding.canonical,
        )} | ${markdownLocations(finding.conflicts)} |`,
      );
    }
  }
  lines.push("", "## Details", "");
  if (!findings.length) {
    lines.push("Автоматические проверки не нашли drift.");
  } else {
    for (const finding of findings) {
      lines.push(
        `### ${finding.severity} · ${finding.claim}`,
        "",
        finding.detail,
        "",
      );
    }
  }
  lines.push("## Dependency index", "", "### Models", "");
  for (const [name, items] of Object.entries(modelDependencies)) {
    lines.push(`- **${name}**: ${markdownLocations(items)}`);
  }
  lines.push("", "### Canonical scenario", "");
  for (const [value, items] of Object.entries(scenarioDependencies)) {
    lines.push(`- **${value}**: ${markdownLocations(items)}`);
  }
  lines.push("", "### AgentResult surfaces", "");
  for (const [name, items] of Object.entries(agentResultDependencies)) {
    lines.push(`- **${name}**: ${markdownLocations(items)}`);
  }
  lines.push(
    "",
    "## Checks",
    "",
    `- Models and roles: ${findings.some((item) => /MiMo|DeepSeek|GPT-5\.6|роль модел|модел[ьи]/iu.test(item.claim) && item.severity !== "P2") ? "FAIL" : "PASS"}`,
    `- Research/open-page contract: ${findings.some((item) => /research|публичн.*страниц/iu.test(item.claim) && item.severity !== "P2") ? "FAIL" : "PASS"}`,
    `- AgentResult surfaces: ${findings.some((item) => /AgentResult/iu.test(item.claim) && item.severity !== "P2") ? "FAIL" : "PASS"}`,
    `- Canonical scenario: ${findings.some((item) => /сценар|ПРОТЕК|Fallback/iu.test(item.claim) && item.severity !== "P2") ? "FAIL" : findings.some((item) => /сценар|ПРОТЕК|Fallback/iu.test(item.claim)) ? "P2" : "PASS"}`,
    `- Limits and bindings: ${findings.some((item) => /limit|binding|DB|R2/iu.test(item.claim) && item.severity !== "P2") ? "FAIL" : "PASS"}`,
    `- Integration boundaries: ${findings.some((item) => /почт|ERP|synthetic|публичн.*ledger|границ.*vision|Vision failure|integration boundary/iu.test(item.claim) && item.severity !== "P2") ? "FAIL" : "PASS"}`,
    "",
    "Ненулевой exit code означает найденный P0/P1 contract drift, а не запись или изменение проекта.",
  );
  return lines.join("\n");
}

function consoleReport() {
  const lines = [
    `KOLER CONTRACT AUDIT: ${status}`,
    `repository: ${repoRoot}`,
    `mode: read-only`,
    `exit: ${exitCode}`,
    "",
  ];
  if (!findings.length) {
    lines.push("No findings.");
  } else {
    for (const finding of findings) {
      lines.push(
        `[${finding.severity}] ${finding.claim}`,
        `  canonical: ${finding.canonical.join(", ") || "—"}`,
        `  conflicts: ${finding.conflicts.join(", ") || "—"}`,
        `  detail: ${finding.detail}`,
        "",
      );
    }
  }
  lines.push("MODEL DEPENDENCIES");
  for (const [name, items] of Object.entries(modelDependencies)) {
    lines.push(`  ${name}: ${items.join(", ") || "—"}`);
  }
  lines.push("", "SCENARIO DEPENDENCIES");
  for (const [value, items] of Object.entries(scenarioDependencies)) {
    lines.push(`  ${value}: ${items.join(", ") || "—"}`);
  }
  return lines.join("\n");
}

console.log(format === "markdown" ? markdownReport() : consoleReport());
process.exitCode = exitCode;
