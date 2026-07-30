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

test("uses the configured reviewer in its own model run", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    bridge,
    /process\.env\.OPENCODE_REVIEWER_MODEL \?\? "opencode\/gpt-5\.6-sol"/,
  );
  const reviewerForSource = sourceBetween(
    bridge,
    "function reviewerFor",
    "function demoDataForJob",
  );
  const reviewerFor = runInNewContext(
    `const strongReviewer = "opencode/gpt-5.6-sol";
${reviewerForSource}
reviewerFor;`,
  );

  assert.equal(
    reviewerFor("opencode-go/deepseek-v4-flash"),
    "opencode/gpt-5.6-sol",
  );
  assert.equal(
    reviewerFor("opencode/gpt-5.6-sol"),
    "opencode/gpt-5.6-sol",
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
    /isComparativeStrongModel/,
  );
  assert.match(
    modelSelector,
    /modelLabel\(selectedModel\)\} обрабатывает ежедневный заказ\. GPT-5\.6 Sol отдельно проверяет факты, числа и условия\./,
  );
  assert.match(
    modelSelector,
    /GPT-5\.6 Sol ведёт заказ для сравнения\. Затем отдельный запуск проверяет факты, числа и условия\./,
  );
  assert.match(
    modelSelector,
    /bridgeOnline[\s\S]*?Обработка заявки[\s\S]*?Подготовленные правила и живой склад/,
  );
  assert.doesNotMatch(modelSelector, /disabled=\{!bridgeOnline\}/);
  assert.doesNotMatch(modelSelector, /прогон|недорогая рабочая модель/iu);
});

test("uses one selected-model flag for the four control-story roles", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );
  const controlStory = sourceBetween(
    stand,
    '<section className="control-story">',
    "<LiveInventoryPanel",
  );

  assert.match(
    stand,
    /const isComparativeStrongModel =\s*selectedModel === "opencode\/gpt-5\.6-sol"/,
  );
  assert.equal(
    (controlStory.match(/\bisComparativeStrongModel\b/g) ?? []).length,
    4,
  );

  for (const dailyModelCopy of [
    "Ежедневная модель и отдельная проверка",
    "обрабатывает заказ по готовым правилам",
    "Ежедневная работа",
    "modelLabel\\(selectedModel\\)",
  ]) {
    assert.match(controlStory, new RegExp(dailyModelCopy));
  }

  for (const strongModelCopy of [
    "Сравнение моделей",
    "GPT-5.6 Sol сначала обрабатывает заказ",
    "Сравнительный запуск",
    "GPT-5.6 Sol обрабатывает заказ",
  ]) {
    assert.match(controlStory, new RegExp(strongModelCopy));
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

  assert.match(heroRoles, /isComparativeStrongModel/);
  assert.match(
    heroRoles,
    /GPT-5\.6 Sol обрабатывает заказ для сравнения/,
  );
  assert.match(
    heroRoles,
    /Та же модель отдельно ведёт заказ и отдельно проверяет готовое решение\./,
  );
  assert.match(heroRoles, /bridgeOnline[\s\S]*?Фото сохраняется в карточке/);
  assert.match(
    heroRoles,
    /GPT-5\.6 Sol заранее подготовила правила/,
  );
  assert.match(
    heroRoles,
    /Ведущий подключает модели для отдельной проверки решения\./,
  );
  assert.doesNotMatch(
    heroRoles,
    /После показа модель изучит журнал|проверяет решения и улучшает правила/,
  );
  assert.match(modelLabel, /id === "Расчёт по готовой инструкции"/);
  assert.match(modelLabel, /return "Автоматическая обработка по правилам"/);
});
