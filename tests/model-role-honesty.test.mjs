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

test("uses DeepSeek V4 Pro in its own review run", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    bridge,
    /const strongReviewer = "opencode-go\/deepseek-v4-pro"/,
  );
  assert.doesNotMatch(bridge, /OPENCODE_REVIEWER_MODEL/u);
  const reviewerForSource = sourceBetween(
    bridge,
    "function reviewerFor",
    "function demoDataForJob",
  );
  const reviewerFor = runInNewContext(
    `const strongReviewer = "opencode-go/deepseek-v4-pro";
${reviewerForSource}
reviewerFor;`,
  );

  assert.equal(
    reviewerFor("opencode-go/deepseek-v4-flash"),
    "opencode-go/deepseek-v4-pro",
  );
  assert.equal(
    reviewerFor("opencode-go/deepseek-v4-pro"),
    "opencode-go/deepseek-v4-pro",
  );

  const processJob = sourceBetween(
    bridge,
    "async function processJob",
    "async function heartbeatLoop",
  );
  assert.match(
    processJob,
    /const primaryRun = await runPrimaryWithOfflineRetry[\s\S]*?const reviewRun = await runOpenCode\(\{\s*model: reviewerModel,[\s\S]*?agent: "koler-reviewer"/,
  );
});

test("keeps GPT-5.6 Sol outside the working model catalog", async () => {
  const catalog = JSON.parse(
    await readFile(new URL("../data/models.json", import.meta.url), "utf8"),
  );
  const ids = catalog.options.map((model) => model.id);

  assert.deepEqual(ids, [
    "opencode-go/deepseek-v4-flash",
    "opencode-go/deepseek-v4-pro",
  ]);
  assert.equal(catalog.default, "opencode-go/deepseek-v4-flash");
});

test("lets the sales agent open every public page used in a conclusion", async () => {
  const profile = await readFile(
    new URL("../.opencode/agents/koler-sales.md", import.meta.url),
    "utf8",
  );

  assert.match(profile, /websearch:\s*allow/u);
  assert.match(profile, /webfetch:\s*allow/u);
  assert.match(profile, /Открой каждую страницу/iu);
  assert.match(profile, /недоверенными данными/iu);
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
    /modelLabel\(selectedModel\)\} обрабатывает ежедневный заказ\. DeepSeek V4 Pro отдельно проверяет факты, числа и условия\./,
  );
  assert.doesNotMatch(modelSelector, /GPT-5\.6 Sol/u);
  assert.match(
    modelSelector,
    /bridgeOnline[\s\S]*?Обработка заявки[\s\S]*?Подготовленные правила и текущий остаток/,
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
    "DeepSeek V4 Pro отдельно проверяет факты и обещания",
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
    /GPT-5\.6 Sol заранее подготовила правила/,
  );
  assert.match(
    heroRoles,
    /Администратор подключает рабочие модели\./,
  );
  assert.match(heroRoles, /DeepSeek V4 Pro отдельным запуском проверяет/u);
  assert.doesNotMatch(
    heroRoles,
    /После показа модель изучит журнал|проверяет решения и улучшает правила/,
  );
  assert.match(modelLabel, /id === "Расчёт по готовой инструкции"/);
  assert.match(modelLabel, /return "Автоматическая обработка по правилам"/);
});
