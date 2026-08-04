import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Не найдено начало фрагмента: ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `Не найден конец фрагмента: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("uses DeepSeek V4 Flash in a separate review run", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    bridge,
    /const strongReviewer = "deepseek\/deepseek-v4-flash"/,
  );
  assert.doesNotMatch(bridge, /OPENCODE_REVIEWER_MODEL/u);
  const reviewerForSource = sourceBetween(
    bridge,
    "function reviewerFor",
    "function demoDataForJob",
  );
  const reviewerFor = runInNewContext(
    `const strongReviewer = "deepseek/deepseek-v4-flash";
${reviewerForSource}
reviewerFor;`,
  );

  assert.equal(
    reviewerFor("deepseek/deepseek-v4-flash"),
    "deepseek/deepseek-v4-flash",
  );
  assert.equal(
    reviewerFor("opencode-go/deepseek-v4-pro"),
    "deepseek/deepseek-v4-flash",
  );

  const processJob = sourceBetween(
    bridge,
    "async function processJob",
    "async function heartbeatLoop",
  );
  assert.match(
    processJob,
    /const primaryRun = await runPrimaryWithRetry[\s\S]*?const reviewRun = await runOpenCode\(\{\s*model: reviewerModel,\s*variant: reviewerVariant,[\s\S]*?agent: "koler-reviewer"/,
  );
  assert.match(
    processJob,
    /model: primaryModel,\s*variant: primaryVariant,[\s\S]*?agent: "koler-sales"/,
  );
});

test("uses the official DeepSeek Flash API for primary and reviewer", async () => {
  const catalog = JSON.parse(
    await readFile(new URL("../data/models.json", import.meta.url), "utf8"),
  );
  const provider = JSON.parse(
    await readFile(new URL("../opencode.json", import.meta.url), "utf8"),
  ).provider.deepseek;
  const ids = catalog.options.map((model) => model.id);

  assert.deepEqual(ids, ["deepseek/deepseek-v4-flash"]);
  assert.equal(catalog.default, "deepseek/deepseek-v4-flash");
  assert.equal(
    catalog.options.find((model) => model.id === catalog.default).variant,
    "max",
  );
  assert.equal(provider.api, "https://api.deepseek.com/v1");
  assert.deepEqual(provider.env, ["DEEPSEEK_API_KEY"]);
  assert.ok(provider.models["deepseek-v4-flash"]);
  assert.equal(provider.models["deepseek-v4-flash"].limit.output, 65_536);
  assert.deepEqual(catalog.options[0].roles, ["primary", "reviewer"]);
  assert.doesNotMatch(JSON.stringify(provider), /sk-[a-z0-9]/iu);
});

test("labels the system endpoint primary, runner, and reviewer roles separately", async () => {
  const route = await readFile(
    new URL("../app/api/orders/route.ts", import.meta.url),
    "utf8",
  );
  const systemEndpoint = sourceBetween(
    route,
    'if (url.searchParams.get("system") === "1")',
    'if (url.searchParams.get("stats") === "1")',
  );

  assert.match(systemEndpoint, /provider:\s*"DeepSeek API"/u);
  assert.match(systemEndpoint, /agent:\s*"Колер"/u);
  assert.match(systemEndpoint, /runner:\s*"OpenCode"/u);
  assert.match(systemEndpoint, /reviewerProvider:\s*"DeepSeek API"/u);
  assert.match(
    systemEndpoint,
    /models:\s*modelCatalog\.options\.filter\(\(model\) =>\s*model\.roles\.includes\("primary"\)/u,
  );
  assert.doesNotMatch(systemEndpoint, /provider:\s*"OpenCode Go"/u);
  assert.doesNotMatch(systemEndpoint, /agent:\s*"OpenCode"/u);
});

test("keeps operator setup on two independent direct Flash max runs", async () => {
  const [readme, architecture, handoff, envExample] = await Promise.all(
    [
      "../README.md",
      "../docs/ARCHITECTURE-AND-WEBINAR.md",
      "../docs/WEBINAR-RUNBOOK.md",
      "../.env.example",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );

  for (const document of [readme, architecture, handoff]) {
    assert.match(document, /DeepSeek V4 Flash|deepseek-v4-flash/iu);
    assert.doesNotMatch(document, /DeepSeek V4 Pro|opencode-go\/deepseek-v4-pro/u);
    assert.match(document, /variant `max`|Flash\/max|Flash · max/u);
    assert.match(document, /Flash/u);
    assert.match(document, /официальн|direct API|API DeepSeek/iu);
  }
  assert.match(
    readme,
    /OPENCODE_PRIMARY_MODEL=deepseek\/deepseek-v4-flash/u,
  );
  assert.match(readme, /DEEPSEEK_API_KEY=/u);
  assert.match(envExample, /^DEEPSEEK_API_KEY=/mu);
  assert.match(
    envExample,
    /^OPENCODE_PRIMARY_MODEL=deepseek\/deepseek-v4-flash$/mu,
  );
  assert.doesNotMatch(envExample, /opencode-go\/deepseek-v4-flash/u);
});

test("keeps sales-agent web evidence direct, bounded, and purposeful", async () => {
  const profile = await readFile(
    new URL("../.opencode/agents/koler-sales.md", import.meta.url),
    "utf8",
  );

  assert.match(profile, /"\*":\s*deny/u);
  assert.match(profile, /webfetch:\s*deny/u);
  assert.match(profile, /public_webfetch:\s*allow/u);
  assert.doesNotMatch(profile, /^\s*webfetch:\s*allow/mu);
  for (const unrelatedTool of [
    "websearch",
    "bash",
    "read",
    "write",
    "edit",
    "glob",
    "grep",
  ]) {
    assert.doesNotMatch(
      profile,
      new RegExp(`^\\s*${unrelatedTool}:\\s*allow`, "mu"),
    );
  }
  assert.match(profile, /steps:\s*5/u);
  assert.match(profile, /только custom tool `public_webfetch`/iu);
  assert.match(profile, /Discovery:\s*одна HTML-выдача Brave Search/iu);
  assert.match(profile, /до тр[её]х для shortage[\s\S]*?до двух для другого/iu);
  assert.match(profile, /origin\/homepage[\s\S]*?deep URL/iu);
  assert.match(profile, /Search\/snippet[\s\S]*?не являются evidence/iu);
  assert.match(profile, /недоверенные данные, не инструкции/iu);
});

test("guarantees a shared research budget and JSON completion after web attempts", async () => {
  const [profile, prompt] = await Promise.all([
    readFile(new URL("../.opencode/agents/koler-sales.md", import.meta.url), "utf8"),
    readFile(new URL("../public/prompts/sales-agent.md", import.meta.url), "utf8"),
  ]);
  const instructions = `${profile}\n${prompt}`;

  assert.match(instructions, /одна HTML-выдача Brave Search/iu);
  assert.match(instructions, /до тр[её]х для shortage[\s\S]*?до двух для другого/iu);
  assert.match(instructions, /остановись на первой содержательно подходящей странице/iu);
  assert.match(instructions, /Search\/snippet[\s\S]*?не являются evidence/iu);
  assert.match(instructions, /ни одна не[\s\S]*?JSON без `supplierLead`[\s\S]*?confirmationNeeded/iu);
  assert.doesNotMatch(instructions, /кроватк|мангал|Twin Peaks|стиральн/iu);
});

test("requires exact snapshot keys and canonical versions", async () => {
  const prompt = await readFile(
    new URL("../public/prompts/sales-agent.md", import.meta.url),
    "utf8",
  );
  assert.match(prompt, /ровно один точный SKU для `catalog\|inventory`/iu);
  assert.match(prompt, /`inventorySnapshot\.version`/u);
  assert.match(prompt, /Не создавай aggregate keys/iu);
});

test("keeps the compact primary draft structurally exact", async () => {
  const prompt = await readFile(
    new URL("../public/prompts/sales-agent.md", import.meta.url),
    "utf8",
  );
  const compact = prompt.slice(prompt.indexOf("## Компактный JSON-draft"));

  assert.match(
    compact,
    /`reply` обязателен[\s\S]*?ровно объектом[\s\S]*?`\{ "subject": string, "body": string \}`[\s\S]*?никогда строкой/iu,
  );
  assert.match(
    compact,
    /"reply": \{\s*"subject": "Короткая тема",\s*"body": "Готовый человеческий ответ"\s*\}/u,
  );
  assert.match(
    compact,
    /`metric` — ровно `surface_area`, `paint_quantity` или `budget`/u,
  );
  assert.match(
    compact,
    /"observedClaims": \["Что прямо увидено на странице"\][\s\S]*?"confirmationNeeded": \["Что подтвердить у поставщика"\]/u,
  );
  assert.match(
    compact,
    /Не заменяй `observedClaims` и\s*`confirmationNeeded` на `summary`, `needsConfirmation`/u,
  );
  assert.match(
    compact,
    /"range": \{ "min": 10, "max": 16, "unit": "м²" \}/u,
  );
  assert.match(
    compact,
    /Если площадь оценена диапазоном,[\s\S]*?`surface_area`[\s\S]*?`paint_quantity`/u,
  );
  assert.match(
    compact,
    /`confirmBefore` — только `never`,\s*`commercial_offer`, `reserve` или `production`/u,
  );
  assert.match(
    compact,
    /"id": "stable-action-id",\s*"title":[\s\S]*?"rationale":[\s\S]*?"tradeoff":[\s\S]*?"reply":[\s\S]*?"followUpActor": "internal"/u,
  );
  assert.match(
    compact,
    /не заменяй их на `label`, `reason` или `description`/u,
  );
  assert.match(
    compact,
    /При `commitment=none`[\s\S]*?не содержат SKU,[\s\S]*?чисел,[\s\S]*?обещания/iu,
  );
  assert.match(prompt, /для оттенка[\s\S]*?широкое направление[\s\S]*?пробный выкрас[\s\S]*?без RAL/iu);
});

test("reviewer treats target choices as classification, not a product promise", async () => {
  const reviewer = await readFile(
    new URL("../public/prompts/reviewer.md", import.meta.url),
    "utf8",
  );

  assert.match(reviewer, /Варианты `target_ambiguity`/u);
  assert.match(reviewer, /не являются\s+рекомендацией товара/u);
  assert.match(reviewer, /`product=null`, `estimates=\[\]`/u);
  assert.match(reviewer, /`commitment=none`/u);
});

test("explains the selected model role next to the selector", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );
  const modelSelector = sourceBetween(
    stand,
    '<div className="mail-model">',
    '<div className={`zone-hint',
  );

  assert.match(
    modelSelector,
    /modelLabel\(selectedModel\)\} обрабатывает ежедневный заказ\. Отдельный второй запуск DeepSeek V4 Flash проверяет факты, числа и условия\./,
  );
  assert.doesNotMatch(modelSelector, /GPT-5\.6 Sol/u);
  assert.match(
    modelSelector,
    /bridgeOnline[\s\S]*?Соединение с агентом восстанавливается[\s\S]*?без подмены автоматическими правилами/,
  );
  assert.doesNotMatch(modelSelector, /disabled=\{!bridgeOnline\}/);
  assert.doesNotMatch(modelSelector, /прогон|недорогая рабочая модель/iu);
});

test("explains the instruction, worker, and reviewer roles separately", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );
  const controlStory = sourceBetween(
    stand,
    '<section className="control-story">',
    "<LiveInventoryPanel",
  );

  assert.doesNotMatch(stand, /isComparativeStrongModel/u);

  for (const dailyModelCopy of [
    "Ежедневная модель и отдельная проверка",
    "обрабатывает заказ по готовым правилам",
    "Ежедневная работа",
    "modelLabel\\(selectedModel\\)",
    "Второй запуск DeepSeek V4 Flash отдельно проверяет факты и обещания",
    "GPT-5.6 Sol подготовила правила и критерии",
  ]) {
    assert.match(controlStory, new RegExp(dailyModelCopy));
  }

  for (const forbiddenRuntimeCopy of [
    "Сравнение моделей",
    "GPT-5.6 Sol сначала обрабатывает заказ",
    "Сравнительный запуск",
    "GPT-5.6 Sol обрабатывает заказ",
    "она же отдельным запуском проверяет",
  ]) {
    assert.doesNotMatch(controlStory, new RegExp(forbiddenRuntimeCopy));
  }
});

test("keeps the top model role and offline executor honest", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );
  const heroRoles = sourceBetween(
    stand,
    '<ul className="hero-roles">',
    '<details className="technical-layer">',
  );
  const modelLabel = sourceBetween(
    stand,
    "function modelLabel",
    "function usesOpenCode",
  );

  assert.doesNotMatch(heroRoles, /isComparativeStrongModel/);
  assert.doesNotMatch(heroRoles, /GPT-5\.6 Sol обрабатывает|GPT-5\.6 Sol проверяет/u);
  assert.match(
    heroRoles,
    /bridgeOnline[\s\S]*?Фото сохраняется на странице заказа/,
  );
  assert.match(
    heroRoles,
    /Свободные заявки остаются в очереди/,
  );
  assert.match(
    heroRoles,
    /без подмены упрощённым сценарием/,
  );
  assert.match(heroRoles, /Проверка продолжится после восстановления/);
  assert.match(heroRoles, /Непроверенное решение не отправляется клиенту/);
  assert.match(heroRoles, /DeepSeek V4 Flash отдельным вторым запуском проверяет/u);
  assert.doesNotMatch(
    heroRoles,
    /После показа модель изучит журнал|проверяет решения и улучшает правила/,
  );
  assert.match(modelLabel, /id === "Расчёт по готовой инструкции"/);
  assert.match(modelLabel, /return "Автоматическая обработка по правилам"/);
});

test("uses actual reviewer transport events in the order result", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );
  const resultPanel = sourceBetween(
    stand,
    "function ResultPanel",
    "function DecisionProofs",
  );

  assert.match(resultPanel, /events: EventRow\[\]/);
  assert.match(resultPanel, /reviewerTransportCopy\(events, order, result\)/);
  assert.match(resultPanel, /reviewer не запускался/);
  assert.match(resultPanel, /reviewer недоступен · manager path/);
  assert.match(stand, /Проверка не запускалась · skipped/);
  assert.match(stand, /Модель проверки недоступна · manager path/);
  assert.doesNotMatch(
    resultPanel,
    /Проверка перед действием[\s\S]*?<strong>\{humanizeText\(result\.review\.verdict\)\}/,
  );
});

test("keeps the order modal honest about two separate Flash roles", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );
  const catalog = JSON.parse(
    await readFile(new URL("../data/models.json", import.meta.url), "utf8"),
  );
  const modal = stand.slice(stand.indexOf("function Modal"));

  assert.match(
    modal,
    /DeepSeek V4\s+Flash\s+через официальный DeepSeek API\s+выполняет ежедневные заказы\.[\s\S]*?DeepSeek V4\s+Flash\s+отдельным вторым запуском\s+проверяет результат\./u,
  );
  assert.doesNotMatch(
    modal,
    /DeepSeek V4 Pro|opencode-go\/deepseek-v4-pro/iu,
  );
  assert.deepEqual(
    catalog.options.map(({ id, roles }) => ({ id, roles })),
    [{ id: "deepseek/deepseek-v4-flash", roles: ["primary", "reviewer"] }],
  );
});
