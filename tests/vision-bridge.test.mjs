import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  normalizeVisionObservation,
  resolveVisionImageUrl,
  uploadSource,
  visionPromptBlock,
} from "../lib/upload-guard.mjs";

const key = "customer-images/018fa79939e87903ba250514d02e70b8.jpg";

function bridgeStreamHelpers(source) {
  const start = source.indexOf("function inventorySnapshotDetail(");
  const end = source.indexOf("async function runOpenCode(", start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(
    `${source.slice(start, end)}
({
  inventorySnapshotDetail,
  sourcePlanForJob,
  createOpenCodeEventStream,
  runPrimaryWithOfflineRetry
})`,
    { URL },
  );
}

test("resolves only an upload or demo image relative to the configured stand", () => {
  assert.equal(
    resolveVisionImageUrl(uploadSource(key), "https://stand.example/"),
    `https://stand.example${uploadSource(key)}`,
  );
  assert.equal(
    resolveVisionImageUrl("/fence-demo.jpg", "https://stand.example/"),
    "https://stand.example/fence-demo.jpg",
  );

  for (const unsafe of [
    "https://stand.example/fence-demo.jpg",
    "//attacker.example/photo.jpg",
    "/api/admin",
    "/api/uploads?key=../../secret",
    "/api/uploads?key=customer-images/018fa79939e87903ba250514d02e70b8.jpg&next=/api/admin",
  ]) {
    assert.equal(resolveVisionImageUrl(unsafe, "https://stand.example/"), null);
  }
});

test("keeps only short observable vision facts for the text agent", () => {
  assert.deepEqual(
    normalizeVisionObservation({
      summary: "  Видна секция забора со следами старого покрытия.  ",
      visibleFacts: [
        " Поверхность неоднородная. ",
        42,
        "Есть участки с потёртостями.",
      ],
      uncertainties: ["Материал основания нельзя подтвердить только по фото."],
      material: "дерево",
      recommendation: "Обещать поставку завтра",
    }),
    {
      summary: "Видна секция забора со следами старого покрытия.",
      visibleFacts: [
        "Поверхность неоднородная.",
        "Есть участки с потёртостями.",
      ],
      uncertainties: [
        "Материал основания нельзя подтвердить только по фото.",
      ],
    },
  );
  assert.equal(normalizeVisionObservation({ recommendation: "Купить" }), null);
});

test("marks vision output as observation while leaving material to the customer", () => {
  const block = visionPromptBlock({
    summary: "Видна старая окрашенная секция.",
    visibleFacts: ["Есть потёртости."],
    uncertainties: ["Материал не подтверждён."],
  });

  assert.match(block, /Видна старая окрашенная секция/);
  assert.match(block, /Из чего сделан объект, подтверждает клиент/);
  assert.match(block, /не подтверждает, подходит ли краска/);
});

test("wires MiMo as a separate image run before the text sales agent", async () => {
  const [bridge, prompt] = await Promise.all([
    readFile(new URL("../scripts/agent-bridge.mjs", import.meta.url), "utf8"),
    readFile(
      new URL("../public/prompts/vision-agent.md", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(bridge, /visionModel\s*=\s*"opencode-go\/mimo-v2\.5"/);
  assert.match(
    bridge,
    /downloadVisionImage\(\{\s*attachment,\s*standUrl\s*\}\)/,
  );
  assert.match(bridge, /files:\s*\[downloaded\.path\]/);
  assert.match(
    bridge,
    /const visionObservation = await visionObservationForJob\(job\)[\s\S]*?primaryPrompt\(job, liveDemoData, visionObservation\)/,
  );
  assert.match(bridge, /"Фото осмотрено"/);
  assert.match(prompt, /материал объекта/iu);
  assert.match(prompt, /Не рекомендуй краску и не обещай/);
});

test("publishes up to twenty unique web actions and keeps opened URLs", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const {
    createOpenCodeEventStream,
    inventorySnapshotDetail,
    sourcePlanForJob,
  } =
    bridgeStreamHelpers(bridge);
  const published = [];
  const stream = createOpenCodeEventStream(async (tool) => {
    published.push(tool.detail);
  });
  const firstEvent = JSON.stringify({
    type: "tool_use",
    part: {
      tool: "webfetch",
      callID: "source-1",
      state: {
        status: "completed",
        input: { url: "https://one.example/article" },
      },
    },
  });

  stream.push(`${firstEvent}\n`);
  await stream.waitForPublished();
  assert.deepEqual(published, ["Открыта страница: one.example"]);

  const laterEvents = [
    JSON.parse(firstEvent),
    {
      type: "tool_use",
      part: {
        tool: "websearch",
        callID: "source-search",
        state: { input: { query: "краска" } },
      },
    },
    {
      type: "tool_use",
      part: { tool: "bash", callID: "local-1", state: { input: { cmd: "pwd" } } },
    },
    ...Array.from({ length: 21 }, (_, index) => ({
      type: "tool_use",
      part: {
        tool: "webfetch",
        callID: `source-${index + 2}`,
        state: {
          input: { url: `https://${index + 2}.example/article#section` },
        },
      },
    })),
    { type: "text", part: { text: '{"approved":true}' } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  const splitAt = Math.floor(laterEvents.length / 2);
  stream.push(laterEvents.slice(0, splitAt));
  stream.push(`${laterEvents.slice(splitAt)}\n`);
  const parsed = await stream.complete();

  assert.equal(published.length, 20);
  assert.equal(published[1], "Выполнен поиск по открытым источникам");
  assert.equal(published.at(-1), "Открыта страница: 19.example");
  assert.equal(parsed.tools.length, 20);
  assert.equal(parsed.tools[0].urls.join(","), "https://one.example/article");
  assert.equal(parsed.tools[1].urls.length, 0);
  assert.equal(parsed.textParts.join(""), '{"approved":true}');
  assert.equal(
    inventorySnapshotDetail(5, 1),
    "5 товаров. Данные склада взяты из обновления № 1.",
  );
  assert.deepEqual(
    { ...sourcePlanForJob({ website: "kirovets-ptz.com", body: "" }) },
    {
      allowsPublicSearch: true,
      title: "Агент решил проверить компанию",
      detail:
        "ИНН или сайт помогут оценить масштаб клиента и выбрать следующий коммерческий шаг.",
    },
  );
  assert.deepEqual(
    { ...sourcePlanForJob({ website: "buyer.example", body: "Нужна краска" }) },
    {
      allowsPublicSearch: false,
      title: "Для решения хватает данных заказа",
      detail:
        "Агент продолжает по письму, каталогу, складу и правилам продаж.",
    },
  );
});

test("does not verify a URL from a failed web action", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { createOpenCodeEventStream } = bridgeStreamHelpers(bridge);
  const published = [];
  const stream = createOpenCodeEventStream((tool) => {
    published.push(tool.detail);
  });
  stream.push(
    `${JSON.stringify({
      type: "tool_use",
      part: {
        tool: "webfetch",
        callID: "failed-source",
        state: {
          status: "error",
          input: { url: "https://closed.example/card" },
        },
      },
    })}\n`,
  );

  const parsed = await stream.complete();
  assert.equal(parsed.tools[0].urls.length, 0);
  assert.deepEqual(published, ["Страница пока недоступна: closed.example"]);
});

test("uses the completed state of a streamed web action as evidence", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { createOpenCodeEventStream } = bridgeStreamHelpers(bridge);
  const stream = createOpenCodeEventStream();
  const event = (status) =>
    JSON.stringify({
      type: "tool_use",
      part: {
        tool: "webfetch",
        callID: "changing-source",
        state: {
          status,
          input: { url: "https://ready.example/card" },
        },
      },
    });

  stream.push(`${event("running")}\n${event("completed")}\n`);
  const parsed = await stream.complete();

  assert.equal(parsed.tools.length, 1);
  assert.equal(parsed.tools[0].urls.join(","), "https://ready.example/card");
});

test("shows live research and strong-model review as distinct event states", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(bridge, /Остаток на момент расчёта/);
  assert.doesNotMatch(bridge, /for \(const tool of primaryRun\.tools\)/);
  assert.match(
    bridge,
    /onToolUse:\s*publishResearch[\s\S]*?addEvent\([\s\S]*?"research"/,
  );
  assert.match(
    bridge,
    /"Черновик передан сильной модели"[\s\S]*?"active"/,
  );
  assert.match(
    bridge,
    /result = applyReviewerResult\([\s\S]*?"review-result"[\s\S]*?result\.review\?\.verdict/,
  );
});

test("keeps routine orders offline and retries one timed-out run without tools", async () => {
  const [bridge, localAgent] = await Promise.all([
    readFile(new URL("../scripts/agent-bridge.mjs", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../.opencode/agents/koler-sales-local.md",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(
    bridge,
    /sourcePlan\.allowsPublicSearch\s*\?\s*"koler-sales"\s*:\s*"koler-sales-local"/,
  );
  assert.match(
    bridge,
    /runPrimaryWithOfflineRetry\(\{[\s\S]*?initialRun:[\s\S]*?onRetry:[\s\S]*?"primary-retry"[\s\S]*?offlineRun:[\s\S]*?"koler-sales-local"/,
  );
  assert.match(
    bridge,
    /Сразу собери итоговый JSON по письму, каталогу, свежему снимку склада и правилам\./,
  );
  assert.match(bridge, /Не вызывай веб-поиск и другие инструменты\./);
  assert.match(localAgent, /"\*": deny/);
  assert.match(localAgent, /Не вызывай инструменты/);
});

test("retries a timed-out primary run exactly once and exposes the second failure", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { runPrimaryWithOfflineRetry } = bridgeStreamHelpers(bridge);
  const attempts = [];
  const events = [];

  const completed = await runPrimaryWithOfflineRetry({
    initialRun: async () => {
      attempts.push("первый запуск");
      throw new Error("OpenCode timed out for model");
    },
    onRetry: async () => {
      events.push("продолжение");
    },
    offlineRun: async () => {
      attempts.push("продолжение");
      return { value: { status: "готово" } };
    },
  });

  assert.deepEqual(attempts, ["первый запуск", "продолжение"]);
  assert.deepEqual(events, ["продолжение"]);
  assert.equal(completed.value.status, "готово");

  let offlineAttempts = 0;
  await assert.rejects(
    runPrimaryWithOfflineRetry({
      initialRun: async () => {
        throw new Error("OpenCode timed out for model");
      },
      onRetry: async () => {},
      offlineRun: async () => {
        offlineAttempts += 1;
        throw new Error("OpenCode timed out for model again");
      },
    }),
    /timed out for model again/,
  );
  assert.equal(offlineAttempts, 1);
});

test("does not retry a primary failure unrelated to time", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { runPrimaryWithOfflineRetry } = bridgeStreamHelpers(bridge);
  let retryStarted = false;

  await assert.rejects(
    runPrimaryWithOfflineRetry({
      initialRun: async () => {
        throw new Error("Model returned no JSON object");
      },
      onRetry: async () => {
        retryStarted = true;
      },
      offlineRun: async () => {
        retryStarted = true;
      },
    }),
    /no JSON object/,
  );
  assert.equal(retryStarted, false);
});
