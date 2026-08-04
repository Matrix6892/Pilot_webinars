import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  ambiguityReply,
  applyReviewerResult,
  isCompleteAgentResult,
  managerFallbackAgentResult,
  normalizeV2AgentResult,
  reviewerAllowedPathPrefixes,
  validateReviewerDecisionV2,
  reviewerDecisionValidationErrors,
} from "../lib/agent-guard.mjs";
import {
  containsPersonalInference,
  normalizeVisionObservation,
  resolveVisionImageUrl,
  uploadSource,
  visionPromptBlock,
} from "../lib/upload-guard.mjs";
import { isSearchResultUrl } from "../lib/public-web-url.mjs";

const key = "customer-images/018fa79939e87903ba250514d02e70b8.jpg";

function bridgeStreamHelpers(source) {
  const start = source.indexOf("function extractJson(");
  const end = source.indexOf("async function runOpenCode(", start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(
    `${source.slice(start, end)}
({
  inventorySnapshotDetail,
  createOpenCodeEventStream,
  runPrimaryWithRetry,
  stageTimeoutForDeadline,
  isCompleteFailClosedManager,
})`,
    { URL, createHash, isIP, isCompleteAgentResult, isSearchResultUrl },
  );
}

function childEnvironmentFromBridge(source, env, model) {
  const start = source.indexOf("function childEnvironment(");
  const end = source.indexOf("async function agentRequest(", start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(
    `${source.slice(start, end)}
childEnvironment(${JSON.stringify(model)})`,
    { process: { env } },
  );
}

function resultTransportHelpers(source) {
  const start = source.indexOf("function claimPayload(");
  const end = source.indexOf("function addEvent(", start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(
    `${source.slice(start, end)}
({ openedSourceUrlsFromTools, resultPayload })`,
  );
}

function bridgePromptHelpers(source) {
  const start = source.indexOf("function storedJobJson(");
  const end = source.indexOf("function childEnvironment(", start);
  const urlStart = source.indexOf("function isPrivateIpAddress(");
  const urlEnd = source.indexOf("function completedToolOpenedAt(", urlStart);
  assert.ok(start >= 0 && end > start);
  assert.ok(urlStart >= 0 && urlEnd > urlStart);
  return runInNewContext(
    `${source.slice(start, end)}
${source.slice(urlStart, urlEnd)}
({
  continuationContextForJob,
  reviewerOrderView,
  reviewerResultView
})`,
    { isIP, isSearchResultUrl, normalizeVisionObservation, URL },
  );
}

function reviewPromptFromBridge(
  source,
  reviewerOrderView,
  reviewerResultView,
) {
  const start = source.indexOf("function reviewPrompt(");
  const end = source.indexOf("async function processJob(", start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(
    `${source.slice(start, end)}
reviewPrompt`,
    {
      promptJson: (value) => JSON.stringify(value, null, 2),
      reviewerInstruction: "Проверь заказ.",
      reviewerOrderView,
      reviewerResultView,
      reviewerAllowedPathPrefixes,
    },
  );
}

function primaryPromptFromBridge(
  source,
  reviewerOrderView,
  salesInstruction = "Разбери заказ.",
) {
  const start = source.indexOf("function primaryPrompt(");
  const end = source.indexOf("function reviewPrompt(", start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(
    `${source.slice(start, end)}
primaryPrompt`,
    {
      continuationContextForJob: () => null,
      promptJson: (value) => JSON.stringify(value, null, 2),
      reviewerOrderView,
      salesInstruction,
      visionPromptBlock: () => "",
    },
  );
}

function compoundCoverageRetryPromptFromBridge(source, salesInstruction) {
  const start = source.indexOf("function compoundCoverageRetryPrompt(");
  const end = source.indexOf("function reviewPrompt(", start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(
    `${source.slice(start, end)}
compoundCoverageRetryPrompt`,
    {
      promptJson: (value) => JSON.stringify(value, null, 2),
      salesInstruction,
    },
  );
}

function reviewerFlowHelpers(source) {
  const start = source.indexOf("function reviewerRetryMetadata(");
  const end = source.indexOf("async function processJob(", start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(
    `${source.slice(start, end)}
({ reviewerDecisionWithRetry, reviewRetryPrompt })`,
    {
      promptText: (value, max) =>
        typeof value === "string"
          ? value.replace(/\s+/gu, " ").trim().slice(0, max)
          : "",
      reviewerInstruction: "Проверь решение.",
      telemetryWarning: () => {},
      reviewerAllowedPathPrefixes,
      reviewerDecisionValidationErrors,
      validateReviewerDecisionV2,
    },
  );
}

function runOpenCodeFromBridge(
  source,
  onSpawn,
  remove,
  { closes = true, closeCode = 0, createEventStream } = {},
) {
  const start = source.indexOf("async function runOpenCode(");
  const end = source.indexOf(
    "function storedVisionObservationForJob(",
    start,
  );
  assert.ok(start >= 0 && end > start);
  return runInNewContext(
    `${source.slice(start, end)}\nrunOpenCode`,
    {
      childEnvironment: () => ({}),
      clearTimeout,
      createOpenCodeEventStream:
        createEventStream ??
        (() => ({
          push() {},
          complete: async () => ({
            textParts: ['{"ok":true}'],
            tools: [],
          }),
        })),
      extractJson: JSON.parse,
      join: (...parts) => parts.join("/"),
      mkdtemp: async () => "/tmp/koler-agent-test",
      openCodeTerminationGraceMs: 5,
      openCodeTimeoutMs: 1_000,
      rm: remove,
      root: "/workspace",
      setTimeout,
      spawn: (_command, arguments_) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        onSpawn(arguments_, child);
        if (closes) queueMicrotask(() => child.emit("close", closeCode));
        return child;
      },
      tmpdir: () => "/tmp",
      writeFile: async () => {},
    },
  );
}

function visionObservationForJobFromBridge(source, overrides = {}) {
  const start = source.indexOf("async function visionObservationForJob(");
  const end = source.indexOf("function primaryPrompt(", start);
  assert.ok(start >= 0 && end > start);
  const { stageTimeoutForDeadline } = bridgeStreamHelpers(source);
  return runInNewContext(
    `${source.slice(start, end)}\nvisionObservationForJob`,
    {
      IMAGE_DOWNLOAD_TIMEOUT_MS: 15_000,
      addEvent: async () => {},
      console: { error() {} },
      downloadVisionImage: async () => ({
        directory: "/tmp/koler-vision-test",
        path: "/tmp/koler-vision-test/photo.jpg",
      }),
      jobDeadlineMs: 700_000,
      normalizeVisionObservation,
      openCodeTerminationGraceMs: 5_000,
      openCodeTimeoutMs: 90_000,
      visionOpenCodeTimeoutMs: 180_000,
      performance,
      resolveVisionImageUrl: () => "https://stand.example/api/uploads?key=test",
      rm: async () => {},
      stageTimeoutForDeadline,
      standUrl: "https://stand.example",
      storedJobJson: (value, fallback) => {
        try {
          return JSON.parse(value);
        } catch {
          return fallback;
        }
      },
      storedVisionObservationForJob: () => null,
      terminalPublicationReserveMs: 12_000,
      visionInstruction: "Опиши только видимые признаки.",
      visionModel: "opencode-go/mimo-v2.5",
      ...overrides,
    },
  );
}

function agentRequestRetryHelpers(source, overrides = {}) {
  const start = source.indexOf("function isRetryableAgentRequestError(");
  const end = source.indexOf("function claimPayload(", start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(
    `${source.slice(start, end)}\n({ isRetryableAgentRequestError, agentRequestWithRetry })`,
    {
      agentApiTimeoutMs: 12_000,
      agentRequest: async () => ({ ok: true }),
      performance,
      sleep: async () => {},
      ...overrides,
    },
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
      relevance: "uncertain",
      targetCandidates: [],
      visibleFacts: [
        "Поверхность неоднородная.",
        "Есть участки с потёртостями.",
      ],
      scaleEvidence: [],
      uncertainties: [
        "Материал основания нельзя подтвердить только по фото.",
      ],
    },
  );
  assert.equal(normalizeVisionObservation({ recommendation: "Купить" }), null);
});

test("treats an age as personal only in human context", () => {
  assert.equal(containsPersonalInference("срок службы покрытия 10 лет"), false);
  assert.equal(
    containsPersonalInference("покрытие с гарантией 15 лет"),
    false,
  );
  assert.equal(
    containsPersonalInference("15-летняя гарантия покрытия"),
    false,
  );
  assert.equal(containsPersonalInference("человеку примерно 25 лет"), true);
  assert.equal(containsPersonalInference("25-летний человек"), true);
});

test("marks vision output as untrusted evidence with only one possible blocker", () => {
  const block = visionPromptBlock({
    summary: "Видна старая окрашенная секция.",
    visibleFacts: ["Есть потёртости."],
    uncertainties: ["Материал не подтверждён."],
  });

  assert.match(block, /Видна старая окрашенная секция/);
  assert.match(block, /Явный текст клиента важнее визуальной гипотезы/);
  assert.match(block, /объект действия действительно неоднозначен/);
  assert.match(block, /не подтверждает свойства краски/);
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
    /downloadVisionImage\(\{[\s\S]*?attachment,[\s\S]*?standUrl,[\s\S]*?timeoutMs:\s*downloadTimeoutMs[\s\S]*?\}\)/,
  );
  assert.match(bridge, /files:\s*\[downloaded\.path\]/);
  assert.match(
    bridge,
    /Явный текст заявки[\s\S]*?subject:\s*String\(job\.subject[\s\S]*?body:\s*String\(job\.body/,
  );
  assert.match(
    bridge,
    /const visionObservation = await visionObservationForJob\(\s*job,\s*jobStartedAtMs,\s*\)[\s\S]*?primaryPrompt\([\s\S]*?job,[\s\S]*?liveDemoData,[\s\S]*?visionObservation,[\s\S]*?continuationContext/,
  );
  assert.match(bridge, /"Фото осмотрено"/);
  assert.match(prompt, /Материал описывай только через видимые признаки/iu);
  assert.match(prompt, /широкий диапазон[\s\S]*?площади/iu);
  assert.match(prompt, /Не рекомендуй краску и не обещай/);
});

test("retries one malformed MiMo result inside the shrinking vision budget", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  let nowMs = 0;
  const calls = [];
  const visionObservationForJob = visionObservationForJobFromBridge(bridge, {
    performance: { now: () => nowMs },
    runOpenCode: async (call) => {
      calls.push(call);
      if (calls.length === 1) {
        nowMs = 30_000;
        const error = new Error("No JSON result");
        error.completedMalformed = true;
        throw error;
      }
      nowMs = 31_000;
      return {
        value: {
          summary: "Видна окрашенная секция с потёртостями.",
          visibleFacts: ["Покрытие неоднородное."],
          uncertainties: ["Материал по фото не подтверждён."],
        },
      };
    },
  });

  const result = await visionObservationForJob(
    {
      id: "order-vision-retry",
      subject: "Нужно обновить покрытие",
      body: "Фото приложено.",
      attachmentJson: JSON.stringify({
        name: "photo.jpg",
        src: "/api/uploads?key=test",
      }),
    },
    0,
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].timeoutMs, 175_000);
  assert.equal(calls[1].timeoutMs, 145_000);
  assert.equal(Object.hasOwn(calls[0], "variant"), false);
  assert.equal(Object.hasOwn(calls[1], "variant"), false);
  assert.equal(result.attachmentRef, "/api/uploads?key=test");
  assert.equal(result.summary, "Видна окрашенная секция с потёртостями.");
});

test("bounds MiMo at two calls and skips retry without termination reserve", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const scenarios = [
    { name: "insufficient budget", afterFirstMs: 176_000, calls: 1 },
    { name: "second failure", afterFirstMs: 10_000, calls: 2 },
  ];

  for (const scenario of scenarios) {
    let nowMs = 0;
    const calls = [];
    const events = [];
    const visionObservationForJob = visionObservationForJobFromBridge(bridge, {
      addEvent: async (_job, ...event) => events.push(event),
      performance: { now: () => nowMs },
      runOpenCode: async (call) => {
        calls.push(call);
        nowMs = calls.length === 1 ? scenario.afterFirstMs : 20_000;
        throw new Error("No JSON result");
      },
    });

    const result = await visionObservationForJob(
      {
        id: `order-${scenario.name}`,
        subject: "Нужно обновить покрытие",
        body: "Фото приложено.",
        attachmentJson: JSON.stringify({
          name: "photo.jpg",
          src: "/api/uploads?key=test",
        }),
      },
      0,
    );

    assert.equal(result, null, scenario.name);
    assert.equal(calls.length, scenario.calls, scenario.name);
    assert.ok(
      calls.every((call) => !Object.hasOwn(call, "variant")),
      scenario.name,
    );
    assert.deepEqual(
      events.map(([stage]) => stage),
      ["vision", "vision-fallback"],
      scenario.name,
    );
  }
});

test("prompt contract specializes generic human candidates from specific visible facts", async () => {
  const [visionPrompt, salesPrompt] = await Promise.all([
    readFile(new URL("../public/prompts/vision-agent.md", import.meta.url), "utf8"),
    readFile(new URL("../public/prompts/sales-agent.md", import.meta.url), "utf8"),
  ]);
  const packet = {
    targetCandidates: [{ label: "человек", evidence: "виден человек" }],
    visibleFacts: ["Видна конкретная нейтральная деталь одежды человека."],
  };

  assert.deepEqual(Object.keys(packet), ["targetCandidates", "visibleFacts"]);
  for (const prompt of [visionPrompt, salesPrompt]) {
    assert.match(prompt, /targetCandidates[\s\S]*?visibleFacts/iu);
    assert.match(prompt, /человек[\s\S]*?нейтральн/iu);
    assert.match(prompt, /сам(?:ый|ого)[\s\S]*?конкретн/iu);
    assert.match(prompt, /не\s+(?:при|вы)думывай[\s\S]*?част[а-яё ]*тела/iu);
  }
});

test("keeps the primary draft compact and derives a complete AgentResult v2", async () => {
  const [instruction, demoData] = await Promise.all([
    readFile(
      new URL("../public/prompts/sales-agent.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../data/paint-demo.json", import.meta.url), "utf8").then(
      JSON.parse,
    ),
  ]);
  const compactSection = instruction.slice(
    instruction.indexOf("## Компактный JSON-draft"),
  );
  const coreExample = compactSection.split("```json")[1].split("```")[0];

  assert.doesNotMatch(
    coreExample,
    /"(?:zone|decision|route|understood|missing|visionObservation|market|research|businessContext|zoneReason|managerNote|checks|sources|decisionBasis|review|calculation|supplierPlan)"/u,
  );
  assert.match(compactSection, /Программный guard сам[\s\S]*?AgentResult v2/u);
  assert.match(compactSection, /Не возвращай производные/u);
  assert.match(
    compactSection,
    /resolved target[\s\S]*?неодушевлённ[а-яё -]*поверхност[\s\S]*?surface_area[\s\S]*?paint_quantity[\s\S]*?confirmBefore=production/iu,
  );

  const body = "Нужно 20 кг КР-004 для стены по штукатурке.";
  const minimalDraft = {
    schemaVersion: 2,
    resolvedIntent: {
      goal: "Поставить краску для штукатурной стены",
      target: {
        state: "resolved",
        label: "штукатурная стена",
        evidenceIds: ["message-task"],
      },
      evidence: [
        {
          id: "message-task",
          claim: "Клиенту нужны 20 кг КР-004 для штукатурной стены",
          confidence: 1,
          source: {
            kind: "message",
            roundNo: 1,
            quote: body,
          },
        },
      ],
      assumptions: [],
      blocker: null,
    },
    commitment: "commercial_offer",
    product: { sku: "КР-004", requestedKg: 20 },
  };

  const result = normalizeV2AgentResult(minimalDraft, demoData, {
    subject: "Краска для стены",
    body,
    roundNo: 1,
  });

  assert.equal(result.schemaVersion, 2);
  assert.equal(result.zone, "green");
  assert.equal(result.decision, "quote");
  assert.equal(result.route, "ready");
  assert.equal(result.product.name, "Моющаяся краска для стен");
  assert.equal(result.product.stockKg, 1_260);
  assert.equal(result.product.pricePerKg, 228);
  assert.equal(result.product.total, 4_560);
  assert.deepEqual(result.missing, []);
  assert.ok(result.understood.length > 0);
  assert.ok(result.decisionBasis.length > 0);
  const completed = applyReviewerResult(
    result,
    {
      approved: true,
      verdict: "Черновик подтверждён",
      notes: [],
      blockingIssues: [],
    },
    "deepseek/deepseek-v4-flash",
    demoData,
    { subject: "Краска для стены", body, roundNo: 1 },
  );
  assert.equal(isCompleteAgentResult(completed), true);
});

test("reuses a recorded vision observation only for the same attachment", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const start = bridge.indexOf("function storedJobJson(");
  const end = bridge.indexOf("async function visionObservationForJob(");
  const storedVisionObservationForJob = runInNewContext(
    `${bridge.slice(start, end)}
storedVisionObservationForJob`,
    { normalizeVisionObservation },
  );
  const attachmentRef = "/api/uploads?key=customer-images/photo.jpg";
  const job = {
    resultJson: JSON.stringify({
      visionObservation: {
        attachmentRef,
        summary: "Видна окрашиваемая стена.",
        visibleFacts: ["Перед стеной стоит человек."],
        uncertainties: ["Точный масштаб не подтверждён."],
      },
    }),
  };

  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        storedVisionObservationForJob(job, attachmentRef),
      ),
    ),
    {
      attachmentRef,
      summary: "Видна окрашиваемая стена.",
      relevance: "uncertain",
      targetCandidates: [],
      visibleFacts: ["Перед стеной стоит человек."],
      scaleEvidence: [],
      uncertainties: ["Точный масштаб не подтверждён."],
    },
  );
  assert.equal(
    storedVisionObservationForJob(job, "/api/uploads?key=other"),
    null,
  );
  assert.match(
    bridge,
    /let guardedJob = \{[\s\S]*?visionObservation,[\s\S]*?normalizeV2AgentResult\([\s\S]*?guardedJob/,
  );
});

test("reuses resolved context and opened pages after a target-blocker reply", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { continuationContextForJob } = bridgePromptHelpers(bridge);
  const attachmentRef = "/api/uploads?key=customer-images/photo.jpg";
  const culturalUrl = "https://culture.example/red-room";
  const supplierUrl = "https://supplier.example/paint";
  const priorOpenedUrl = "https://company.example/about";
  const job = {
    roundNo: 2,
    conversationJson: JSON.stringify([
      {
        role: "agent",
        body: "Что красим: стену или волосы человека?",
        createdAt: "2026-07-31T09:00:00Z",
      },
      {
        role: "customer",
        body: "Красим стену.",
        createdAt: "2026-07-31T09:05:00Z",
      },
    ]),
    resultJson: JSON.stringify({
      schemaVersion: 2,
      resolvedIntent: {
        goal: "Подобрать покрытие для объекта на фото",
        target: {
          state: "ambiguous",
          candidates: [
            {
              label: "стена",
              confidence: 0.7,
              evidenceIds: ["message", "vision"],
            },
            {
              label: "волосы человека",
              confidence: 0.6,
              evidenceIds: ["message", "vision"],
            },
          ],
        },
        evidence: [
          {
            id: "message",
            claim: "Клиент просит обработать объект на фото",
            confidence: 1,
            source: {
              kind: "message",
              roundNo: 1,
              quote: "Покрасьте это на фото",
            },
          },
          {
            id: "vision",
            claim: "В кадре видны стена и волосы человека",
            confidence: 0.7,
            source: {
              kind: "vision",
              attachmentRef,
              observation: "Возможны два объекта действия.",
            },
          },
          {
            id: "cultural-reference",
            claim: "Открыта страница цветового референса",
            confidence: 0.9,
            source: {
              kind: "web",
              url: culturalUrl,
              title: "Red Room",
              openedAt: "2026-07-31T08:55:00Z",
            },
          },
          {
            id: "old-inventory",
            claim: "В прошлом раунде был сохранён остаток",
            confidence: 1,
            source: {
              kind: "snapshot",
              dataset: "inventory",
              key: "КР-004",
              version: "old",
              checkedAt: "2026-07-31T08:50:00Z",
            },
          },
        ],
        assumptions: [
          {
            id: "area-range",
            claim: "Площадь оценивается широким диапазоном",
            basedOnEvidenceIds: ["vision"],
            confidence: 0.55,
            range: { min: 10, max: 18, unit: "м²" },
            confirmBefore: "commercial_offer",
          },
        ],
        blocker: {
          kind: "target_ambiguity",
          question: "Что красим: стену или волосы человека?",
          choices: ["стену", "волосы человека"],
        },
      },
      visionObservation: {
        attachmentRef,
        summary: "В кадре видны стена и человек.",
        relevance: "relevant",
        targetCandidates: [
          {
            label: "стена",
            confidence: 0.7,
            evidence: "занимает фон",
          },
        ],
        visibleFacts: ["Стена занимает фон"],
        scaleEvidence: [],
        uncertainties: ["Точный масштаб неизвестен"],
      },
      research: {
        checked: true,
        summary: "Открыт культурный референс.",
        sources: [
          {
            title: "Red Room",
            url: culturalUrl,
            checkedAt: "2026-07-31",
            fact: "Страница показывает цветовой референс.",
          },
        ],
      },
      supplierLeads: [{ url: supplierUrl }],
      openedSourceUrls: [priorOpenedUrl],
    }),
  };

  const context = JSON.parse(
    JSON.stringify(continuationContextForJob(job)),
  );
  assert.equal(context.latestCustomerReply.body, "Красим стену.");
  assert.equal(context.resolvedIntent.evidence.length, 4);
  assert.equal(context.resolvedIntent.assumptions[0].id, "area-range");
  assert.equal(
    context.visionObservation.attachmentRef,
    attachmentRef,
  );
  assert.equal(context.culturalResearch.sources[0].url, culturalUrl);
  assert.deepEqual(context.openedSourceUrls, [culturalUrl]);
  assert.equal(context.openedSourceUrls.includes(priorOpenedUrl), false);
  assert.equal(context.openedSourceUrls.includes(supplierUrl), false);

  const processJob = bridge.slice(
    bridge.indexOf("async function processJob"),
    bridge.indexOf("async function heartbeatLoop"),
  );
  assert.match(
    processJob,
    /const continuationContext = continuationContextForJob\(job\)[\s\S]*?visionObservationForJob\(\s*job,\s*jobStartedAtMs,\s*\)[\s\S]*?primaryPrompt\([\s\S]*?continuationContext/,
  );
  assert.match(
    processJob,
    /continuationOpenedSourceUrls[\s\S]*?verifiedOpenedSourceUrls[\s\S]*?attemptOpenedSourceUrls\s*=\s*openedSourceUrlsFromTools\(primaryRun\.tools\)[\s\S]*?resultPayload\(/,
  );
});

test("captures only current completed public web tools in the result transport", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { openedSourceUrlsFromTools, resultPayload } =
    resultTransportHelpers(bridge);
  const observedUrl = "https://current.example/page";
  const modelOnlyUrl = "https://model-only.example/page";
  const observedUrls = openedSourceUrlsFromTools([
    {
      tool: "public_webfetch",
      completed: true,
      failed: false,
      urls: [observedUrl],
    },
    {
      tool: "public_webfetch",
      completed: false,
      failed: false,
      urls: ["https://incomplete.example/page"],
    },
    {
      tool: "public_webfetch",
      completed: true,
      failed: true,
      urls: ["https://failed.example/page"],
    },
    {
      tool: "webfetch",
      completed: true,
      failed: false,
      urls: ["https://legacy.example/page"],
    },
  ]);
  const result = {
    schemaVersion: 2,
    resolvedIntent: {
      evidence: [
        {
          source: { kind: "web", url: modelOnlyUrl },
        },
      ],
    },
    research: { sources: [{ url: modelOnlyUrl }] },
    supplierLeads: [{ url: modelOnlyUrl }],
  };
  const payload = resultPayload(
    { id: "order-current", roundNo: 4, claimId: "claim-current" },
    result,
    observedUrls,
    "primary-model",
    "reviewer-model",
    {
      stage: "review-result",
      title: "Проверка завершена",
      detail: "Факты подтверждены.",
    },
  );

  assert.deepEqual(Object.keys(payload), [
    "action",
    "orderId",
    "roundNo",
    "claimId",
    "result",
    "openedSourceUrls",
    "agentModel",
    "reviewerModel",
    "reviewerProvenance",
  ]);
  assert.equal(payload.action, "result");
  assert.equal(payload.orderId, "order-current");
  assert.equal(payload.roundNo, 4);
  assert.equal(payload.claimId, "claim-current");
  assert.deepEqual(Array.from(payload.openedSourceUrls), [observedUrl]);
  assert.equal(payload.openedSourceUrls.includes(modelOnlyUrl), false);
  assert.equal(payload.openedSourceUrls.includes("https://legacy.example/page"), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(payload.reviewerProvenance)),
    {
      stage: "review-result",
      title: "Проверка завершена",
      detail: "Факты подтверждены.",
    },
  );
});

test("sends an explicit empty evidence array for no-web and preserves active claim fields", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { openedSourceUrlsFromTools, resultPayload } =
    resultTransportHelpers(bridge);
  const payload = resultPayload(
    { id: "order-active", roundNo: 2, claimId: "claim-active" },
    { schemaVersion: 2 },
    openedSourceUrlsFromTools([]),
    "primary-model",
    "reviewer-model",
    {
      stage: "review-skipped",
      title: "Безопасный результат уже сформирован",
      detail: "Повторная проверка не требуется.",
    },
  );

  assert.deepEqual(Array.from(payload.openedSourceUrls), []);
  assert.equal(payload.orderId, "order-active");
  assert.equal(payload.roundNo, 2);
  assert.equal(payload.claimId, "claim-active");
  assert.equal(payload.reviewerProvenance.stage, "review-skipped");
  assert.match(
    bridge,
    /resultPayload\([\s\S]*?verifiedOpenedSourceUrls[\s\S]*?primaryModel[\s\S]*?reviewerModel[\s\S]*?reviewerProvenance/u,
  );
  assert.match(
    bridge,
    /attemptOpenedSourceUrls\s*=\s*openedSourceUrlsFromTools\(primaryRun\.tools\)[\s\S]*?verifiedOpenedSourceUrls[\s\S]*?catch \(primaryError\)[\s\S]*?attemptOpenedSourceUrls\s*=\s*openedSourceUrlsFromTools\([\s\S]*?verifiedOpenedSourceUrls[\s\S]*?resultPayload\(/u,
  );
});

test("reviewer compact intent keeps six target candidates and choices", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { reviewerResultView } = bridgePromptHelpers(bridge);
  const candidates = Array.from({ length: 7 }, (_, index) => ({
    label: `фрагмент ${index + 1}`,
    confidence: 0.9,
    evidenceIds: ["vision"],
  }));
  const compact = reviewerResultView({
    schemaVersion: 2,
    resolvedIntent: {
      goal: "Покрасить выбранный фрагмент.",
      target: { state: "ambiguous", candidates },
      evidence: [{
        id: "vision",
        claim: "Видны фрагменты.",
        confidence: 0.9,
        source: { kind: "vision", attachmentRef: "synthetic://compact", observation: "Видны фрагменты." },
      }],
      assumptions: [],
      blocker: {
        kind: "target_ambiguity",
        question: "Что красим?",
        choices: candidates.map(({ label }) => label),
      },
    },
  });

  assert.equal(compact.resolvedIntent.target.candidates.length, 6);
  assert.equal(compact.resolvedIntent.blocker.choices.length, 6);
});

test("reviewer receives only allowlisted order and result views", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { reviewerOrderView, reviewerResultView } =
    bridgePromptHelpers(bridge);
  const reviewPrompt = reviewPromptFromBridge(
    bridge,
    reviewerOrderView,
    reviewerResultView,
  );
  const job = {
    id: "internal-order-id",
    company: "Тестовый клиент",
    website: "https://client.example",
    subject: "Покрасить стену",
    body: "Нужна предварительная оценка.",
    roundNo: 2,
    actionTokenHash: "super-secret-action-hash",
    claimId: "secret-claim",
    claimedBy: "internal-worker",
    leaseUntil: "2099-01-01",
    attemptNo: 9,
    status: "processing",
    resultJson: '{"internal":"stored-result"}',
    inventorySnapshotJson: '{"internal":"stored-inventory"}',
    attachmentJson: JSON.stringify({
      name: "wall.jpg",
      src: "/fence-demo.jpg",
      alt: "Стена",
      actionTokenHash: "nested-attachment-secret",
    }),
    conversationJson: JSON.stringify([
      {
        role: "customer",
        body: "Красим стену.",
        createdAt: "2026-07-31T09:05:00Z",
        claimId: "nested-conversation-secret",
      },
    ]),
  };

  const view = JSON.parse(JSON.stringify(reviewerOrderView(job)));
  assert.deepEqual(Object.keys(view), [
    "company",
    "website",
    "subject",
    "body",
    "attachment",
    "conversation",
    "round",
  ]);
  assert.deepEqual(Object.keys(view.attachment), ["name", "src", "alt"]);
  assert.deepEqual(Object.keys(view.conversation[0]), [
    "role",
    "body",
    "createdAt",
  ]);

  const draft = {
    schemaVersion: 2,
    zone: "yellow",
    route: "ready",
    commitment: "estimate",
    confidence: 0.82,
    resolvedIntent: {
      goal: "Оценить покраску стены",
      target: {
        state: "resolved",
        label: "стена",
        evidenceIds: ["message-target"],
      },
      evidence: [
        {
          id: "message-target",
          claim: "Клиент явно указал стену",
          confidence: 1,
          source: {
            kind: "message",
            roundNo: 2,
            quote: "Красим стену.",
          },
        },
      ],
      assumptions: [],
      blocker: null,
    },
    estimates: [{ metric: "surface_area" }],
    supplierLeads: [{ supplier: "Поставщик" }],
    product: { sku: "КР-004" },
    supplierPlan: { supplierName: "ПромКолор Опт" },
    options: [{ title: "Сделать выкрас" }],
    reply: { body: "Дам диапазон и следующий шаг." },
    decision: "derived-decision-secret",
    understood: ["derived-understood-secret"],
    missing: ["derived-missing-secret"],
    visionObservation: { summary: "derived-vision-secret" },
    market: [{ fact: "derived-market-secret" }],
    research: { summary: "derived-research-secret" },
    businessContext: "derived-context-secret",
    zoneReason: "derived-zone-secret",
    managerNote: "derived-manager-secret",
    checks: ["derived-checks-secret"],
    sources: ["derived-sources-secret"],
    decisionBasis: ["derived-basis-secret"],
    review: { verdict: "derived-review-secret" },
    calculation: { total: "derived-calculation-secret" },
  };
  const resultView = JSON.parse(
    JSON.stringify(reviewerResultView(draft)),
  );
  assert.deepEqual(Object.keys(resultView), [
    "schemaVersion",
    "zone",
    "route",
    "commitment",
    "confidence",
    "resolvedIntent",
    "estimates",
    "supplierLeads",
    "product",
    "supplierPlan",
    "options",
    "reply",
  ]);
  assert.deepEqual(resultView.supplierPlan.source, {
    kind: "snapshot",
    dataset: "supplier",
    key: "ПромКолор Опт",
  });

  const prompt = reviewPrompt(
    job,
    draft,
    { products: [], market: [] },
  );
  const packet = {
    order: reviewerOrderView(job),
    result: resultView,
  };
  const allowedPathMap = JSON.stringify(reviewerAllowedPathPrefixes(packet));
  const productionPrompt = reviewPrompt(
    job,
    draft,
    { products: [], market: [] },
    packet,
  );
  const { reviewRetryPrompt } = reviewerFlowHelpers(bridge);
  const productionRetryPrompt = reviewRetryPrompt(packet, {
    schemaVersion: { type: "number", value: 2 },
    approved: false,
    blockingIssueCount: 1,
    validationErrors: ["reviewer.issue[0].path_not_allowed"],
  });
  assert.match(productionPrompt, new RegExp(allowedPathMap.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(productionRetryPrompt, new RegExp(allowedPathMap.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(productionRetryPrompt, /path_not_allowed/iu);
  for (const forbidden of [
    "actionTokenHash",
    "super-secret-action-hash",
    "claimId",
    "secret-claim",
    "claimedBy",
    "leaseUntil",
    "attemptNo",
    "resultJson",
    "inventorySnapshotJson",
    "attachmentJson",
    "conversationJson",
    "nested-attachment-secret",
    "nested-conversation-secret",
    "derived-decision-secret",
    "derived-understood-secret",
    "derived-missing-secret",
    "derived-vision-secret",
    "derived-market-secret",
    "derived-research-secret",
    "derived-context-secret",
    "derived-zone-secret",
    "derived-manager-secret",
    "derived-checks-secret",
    "derived-sources-secret",
    "derived-basis-secret",
    "derived-review-secret",
    "derived-calculation-secret",
  ]) {
    assert.doesNotMatch(prompt, new RegExp(forbidden, "u"));
  }
  assert.match(prompt, /Красим стену/);
  assert.match(prompt, /dataset["']?:["']supplier/u);
  assert.match(prompt, /supplierPlan\.source/u);
});

test("primary prompt turns ordinary unknowns into assumptions and requires public supplier leads", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { reviewerOrderView } = bridgePromptHelpers(bridge);
  const primaryPrompt = primaryPromptFromBridge(
    bridge,
    reviewerOrderView,
  );
  const prompt = primaryPrompt(
    {
      subject: "Нужна краска",
      body: "Посчитайте ориентир.",
      company: "Тестовый клиент",
      roundNo: 1,
      attachmentJson: "null",
      conversationJson: "[]",
    },
    { products: [], market: [] },
    null,
    null,
  );

  assert.match(
    prompt,
    /не превращай неизвестные размеры, материал основания, назначение помещения, режим уборки или нагрузку в blocker/iu,
  );
  assert.match(prompt, /запиши их как явные assumptions/iu);
  assert.match(
    prompt,
    /при дефиците обязательно найди и открой публичные страницы возможных поставщиков/iu,
  );
  assert.match(prompt, /верни их как supplierLeads/iu);
  assert.match(
    prompt,
    /подтверждённые цена, остаток и срок берутся только из текущего supplier snapshot\/API/iu,
  );
  assert.match(prompt, /не возвращай supplierPlan[\s\S]*?построит guard/iu);
  assert.match(prompt, /компактный primary draft/iu);
  assert.doesNotMatch(
    prompt,
    /задай один вопрос о материале, назначении, уборке и нагрузке/iu,
  );
});

test("compound requests receive the complete catalog and keep every explicit ask", async () => {
  const [bridge, salesInstruction, reviewerInstruction, demoData] =
    await Promise.all([
      readFile(new URL("../scripts/agent-bridge.mjs", import.meta.url), "utf8"),
      readFile(new URL("../public/prompts/sales-agent.md", import.meta.url), "utf8"),
      readFile(new URL("../public/prompts/reviewer.md", import.meta.url), "utf8"),
      readFile(new URL("../data/paint-demo.json", import.meta.url), "utf8").then(
        JSON.parse,
      ),
    ]);
  const { reviewerOrderView, reviewerResultView } = bridgePromptHelpers(bridge);
  const job = {
    subject: "Вопросики",
    body: "Добрый день! Хочу покрасить забор деревянный, на даче и еще скажите сколько будет стоить покрасить кремль в москве и какой цвет выбрать лучше?",
    company: "",
    website: "",
    roundNo: 1,
    attachmentJson: "null",
    conversationJson: "[]",
  };
  const liveData = {
    products: demoData.products,
    market: demoData.market,
    rules: demoData.rules,
    inventorySnapshot: { version: 5, capturedAt: "2026-08-04T06:18:33Z" },
  };
  const primaryPrompt = primaryPromptFromBridge(
    bridge,
    reviewerOrderView,
    salesInstruction,
  )(job, liveData, null, null);
  const sourceHeading = "## Демонстрационные источники истины\n";
  const primarySources = primaryPrompt
    .slice(primaryPrompt.indexOf(sourceHeading) + sourceHeading.length)
    .split("\n## ", 1)[0];

  assert.match(primarySources, /"sku":\s*"КР-005"/u);
  assert.ok(
    Math.max(...primarySources.split("\n").map((line) => line.length)) < 2_000,
    "OpenCode must not truncate the catalog before the final product",
  );
  assert.match(
    primaryPrompt,
    /кажд[а-яё]* явно выраженн[а-яё]* просьб[а-яё]*[\s\S]*?клиентск[а-яё]* ответ/iu,
  );

  const reviewPrompt = reviewPromptFromBridge(
    bridge,
    reviewerOrderView,
    reviewerResultView,
  )(
    job,
    {},
    liveData,
    {
      order: reviewerOrderView(job),
      result: {
        schemaVersion: 2,
        zone: "yellow",
        route: "ready",
        commitment: "estimate",
        resolvedIntent: {
          target: { state: "resolved", label: "Деревянный забор" },
          blocker: null,
        },
        estimates: [],
        supplierLeads: [],
        options: [],
        reply: { subject: "Ответ", body: "Черновик" },
      },
    },
  );
  const reviewHeading = "## Каталог, склад, прайс и правила\n";
  const reviewSources = reviewPrompt
    .slice(reviewPrompt.indexOf(reviewHeading) + reviewHeading.length)
    .split("\n## ", 1)[0];

  assert.match(reviewSources, /"sku":\s*"КР-005"/u);
  assert.ok(
    Math.max(...reviewSources.split("\n").map((line) => line.length)) < 2_000,
    "reviewer must see the same complete catalog as primary",
  );
  assert.match(
    reviewerInstruction,
    /кажд[а-яё]* явно выраженн[а-яё]* просьб[а-яё]*[\s\S]*?blocking/iu,
  );

  const coverageRetryPrompt = compoundCoverageRetryPromptFromBridge(
    bridge,
    salesInstruction,
  )(
    primaryPrompt,
    {
      schemaVersion: 2,
      resolvedIntent: {
        goal: "Оценить забор и мысленный сценарий для Кремля",
      },
      estimates: [],
      reply: { subject: "Забор", body: "Оценка только забора" },
    },
    ["мысленный сценарий для Кремля"],
    ["https://ru.wikipedia.org/wiki/Московский_Кремль"],
  );
  assert.match(
    coverageRetryPrompt,
    /если пропущенная часть требует внешнего факта/iu,
  );
  assert.match(coverageRetryPrompt, /один целевой discovery-поиск/iu);
  assert.match(coverageRetryPrompt, /одну прямую\s+страницу/iu);
  assert.doesNotMatch(coverageRetryPrompt, /Не вызывай инструменты/u);
  assert.match(coverageRetryPrompt, /мысленный сценарий для Кремля/u);
  assert.match(
    coverageRetryPrompt,
    /каждой пропущенной[\s\S]*?grounded estimates[\s\S]*?названия объекта/iu,
  );
  assert.match(
    coverageRetryPrompt,
    /reply явно назови и закрой каждую подзадачу[\s\S]*?рекомендацию цвета/iu,
  );
  assert.match(
    coverageRetryPrompt,
    /необычн[а-яё]*, защищённ[а-яё]* или некоммерческ[а-яё]* неодушевлённ[а-яё]* объект[\s\S]*?surface_area[\s\S]*?paint_quantity[\s\S]*?budget/iu,
  );
  assert.match(
    coverageRetryPrompt,
    /вопрос о стоимости[\s\S]*?не закрыт[\s\S]*?budget estimate/iu,
  );
  assert.match(
    coverageRetryPrompt,
    /правовую и коммерческую границу[\s\S]*?отдельно/iu,
  );
  const coverageBlockStart = bridge.indexOf("const coverageRun =");
  const coverageBlock = bridge.slice(
    coverageBlockStart,
    bridge.indexOf("const repairedResult", coverageBlockStart),
  );
  assert.ok(coverageBlockStart >= 0);
  assert.match(coverageBlock, /agent: "koler-sales"/u);
  assert.match(coverageBlock, /publishResearch: true/u);
  assert.match(
    coverageBlock,
    /openedSourceUrlsFromTools\(\s*coverageRun\.tools/iu,
  );
  assert.match(
    coverageBlock,
    /openedSourcesFromTools\(coverageRun\.tools\)/iu,
  );
});

test("sales prompt keeps resolved inanimate surface estimates useful without exact scale or material", async () => {
  const prompt = await readFile(
    new URL("../public/prompts/sales-agent.md", import.meta.url),
    "utf8",
  );

  assert.match(
    prompt,
    /resolved[\s\S]*?(?:неодушевлённ|нежив)[а-яё -]*поверхност/iu,
  );
  assert.match(
    prompt,
    /масштаб[\s\S]*?неизвестн/iu,
  );
  assert.match(
    prompt,
    /материал[\s\S]*?неизвестн/iu,
  );
  assert.match(
    prompt,
    /отсутствие[\s\S]*?не отменяет[\s\S]*?estimate/iu,
  );
  assert.match(
    prompt,
    /(?:точный масштаб|материал)[\s\S]*?(?:неизвестен|неизвестны)/iu,
  );
  assert.match(
    prompt,
    /(?:широк[а-яё -]*диапазон|bounded plausible range)[\s\S]*?surface_area[\s\S]*?paint_quantity/iu,
  );
  assert.match(
    prompt,
    /(?:assumption|допущен)[\s\S]*?confirmBefore["`:= ]*["`]?production/iu,
  );
  assert.match(
    prompt,
    /площадь в м²[\s\S]*?estimate[\s\S]*?paint_quantity[\s\S]*?manager\s*\/\s*red\s*\/\s*estimate/iu,
  );
  assert.match(
    prompt,
    /(?:исключ|не применя)[\s\S]*?(?:человек|част[а-яё -]*тел)[\s\S]*?(?:неоднозначност[а-яё -]*цел|нерелевантн|опасн|бессмыслен)/iu,
  );
});

test("production bridge primary prompt includes the current sales postcondition", async () => {
  const [bridge, salesInstruction] = await Promise.all([
    readFile(new URL("../scripts/agent-bridge.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/prompts/sales-agent.md", import.meta.url), "utf8"),
  ]);
  const { reviewerOrderView } = bridgePromptHelpers(bridge);
  const primaryPrompt = primaryPromptFromBridge(
    bridge,
    reviewerOrderView,
    salesInstruction,
  );
  const prompt = primaryPrompt(
    {
      subject: "Нужна краска",
      body: "Сделайте это.",
      company: "Тестовый клиент",
      roundNo: 1,
      attachmentJson: "null",
      conversationJson: "[]",
    },
    { products: [], market: [] },
    null,
    null,
  );

  assert.match(prompt, /## Postcondition для неоднозначной визуальной цели/iu);
  assert.match(prompt, /targetCandidates[\s\S]*?наблюдения, а не готовое решение/iu);
  assert.match(prompt, /summary[\s\S]*?visibleFacts[\s\S]*?uncertainties/iu);
  assert.match(prompt, /человек[\s\S]*?контекст[\s\S]*?не[\s\S]*?целью/iu);
});

test("named external references require opened web resolution without photo substitution", async () => {
  const [bridge, salesInstruction, profile] = await Promise.all([
    readFile(new URL("../scripts/agent-bridge.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/prompts/sales-agent.md", import.meta.url), "utf8"),
    readFile(new URL("../.opencode/agents/koler-sales.md", import.meta.url), "utf8"),
  ]);

  assert.match(salesInstruction, /названн[\s\S]{0,180}референс требует[\s\S]*?поиск/iu);
  assert.match(salesInstruction, /фото[\s\S]*?не[\s\S]*?(?:идентичност|каноническ|смысл)/iu);
  assert.match(salesInstruction, /direct\s+HTTPS URL/iu);
  assert.match(salesInstruction, /(?:бренд|произведен|мест|эпох|культурн|эстетическ)/iu);
  assert.match(salesInstruction, /обычный\s+описательный\s+цвет[\s\S]*?поиска не требует/iu);
  assert.match(salesInstruction, /широк[а-яё ]+направлен[а-яё ]+[\s\S]*?пробн[а-яё ]+выкрас/iu);
  assert.match(salesInstruction, /без RAL[\s\S]*?вымышленного кода/iu);
  assert.doesNotMatch(salesInstruction, /Porsche|Twin Peaks|Red Room|Fandom/iu);
  assert.doesNotMatch(profile, /Porsche|Twin Peaks|Red Room|Fandom/iu);

  const prompt = primaryPromptFromBridge(
    bridge,
    bridgePromptHelpers(bridge).reviewerOrderView,
    salesInstruction,
  )(
    {
      subject: "Нужна краска",
      body: "Сделайте это.",
      company: "Тестовый клиент",
      roundNo: 1,
      attachmentJson: "null",
      conversationJson: "[]",
    },
    { products: [], market: [] },
    null,
    null,
  );
  assert.match(prompt, /названн[\s\S]{0,180}референс требует[\s\S]*?поиск/iu);
  assert.doesNotMatch(prompt, /Porsche|Twin Peaks|Red Room|Fandom/iu);
});

test("primary prompt names the supplier snapshot source explicitly", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { reviewerOrderView } = bridgePromptHelpers(bridge);
  const primaryPrompt = primaryPromptFromBridge(bridge, reviewerOrderView);
  const prompt = primaryPrompt(
    { subject: "Дефицит краски", body: "Нужно 2000 кг.", roundNo: 1 },
    {
      products: [],
      market: [
        {
          competitor: "ПромКолор Опт",
          stockKg: 2000,
          pricePerKg: 361,
          deliveryDays: 4,
        },
      ],
      rules: {},
      inventorySnapshot: {},
    },
    null,
    null,
  );
  const heading = "## Демонстрационные источники истины\n";
  const sourceBlock = JSON.parse(
    prompt.slice(prompt.indexOf(heading) + heading.length).split("\n## ", 1)[0],
  );

  assert.equal(sourceBlock.market, undefined);
  assert.equal(sourceBlock.supplierSnapshot[0].competitor, "ПромКолор Опт");
  assert.equal(sourceBlock.supplierSnapshot[0].stockKg, 2000);
  assert.equal(sourceBlock.supplierSnapshot[0].pricePerKg, 361);
  assert.equal(sourceBlock.supplierSnapshot[0].deliveryDays, 4);
});

test("cultural research contract retries a canonical language variant and keeps snippets out of evidence", async () => {
  const [prompt, profile, reviewer] = await Promise.all([
    readFile(new URL("../public/prompts/sales-agent.md", import.meta.url), "utf8"),
    readFile(new URL("../.opencode/agents/koler-sales.md", import.meta.url), "utf8"),
    readFile(new URL("../public/prompts/reviewer.md", import.meta.url), "utf8"),
  ]);
  assert.match(prompt, /shortage[\s\S]*?до тр[её]х страниц[\s\S]*?origin\/homepage[\s\S]*?deep URL/iu);
  assert.doesNotMatch(prompt, /Для shortage[\s\S]*?не больше двух\s+прямых\s+страниц/iu);
  assert.match(prompt, /культурн[а-яё ]+референс[\s\S]*?до тр[её]х кандидатов/iu);
  assert.match(prompt, /Search page[\s\S]*?не являются evidence/iu);
  assert.match(
    prompt,
    /официальная, справочная или энциклопедическая страница/iu,
  );
  assert.match(prompt, /открывай direct[\s\S]*?последовательно[\s\S]*?первом содержательно подходящем/iu);
  assert.match(prompt, /ошибка/iu);
  assert.match(prompt, /verification\/challenge-interstitial/iu);
  assert.match(prompt, /ровно один первый content-valid web source/iu);
  assert.match(prompt, /не найден[\s\S]*?без веб-факта/iu);
  assert.match(prompt, /локальн[а-яё ]+энциклопедическ[а-яё ]+страниц[а-яё ]+[\s\S]*?международн[а-яё ]+язык[а-яё ]+/iu);
  assert.match(profile, /локальн[а-яё ]+энциклопедическ[а-яё ]+страниц[а-яё ]+[\s\S]*?международн[а-яё ]+язык[а-яё ]+/iu);
  assert.match(prompt, /не перенос[а-яё ]+[\s\S]*?(?:discovery|сниппет)[\s\S]*?message evidence[\s\S]*?(?:reply|ответ)/iu);
  assert.match(reviewer, /message[\s\S]*?claim[\s\S]*?quote[\s\S]*?внешн[\s\S]*?unsupported_claim/iu);
  assert.match(
    prompt,
    /язык формулировки клиента и прямой страницы[\s\S]*?минимум два[\s\S]*?минимум двумя[\s\S]*?бирюзовые арки[\s\S]*?turquoise arches[\s\S]*?золотой туман[\s\S]*?golden fog/iu,
  );
});

test("sales prompt contract cross-checks ambiguous vision facts before choosing a target", async () => {
  const prompt = await readFile(
    new URL("../public/prompts/sales-agent.md", import.meta.url),
    "utf8",
  );
  assert.match(prompt, /targetCandidates[\s\S]*?наблюдения, а не готовое решение/iu);
  assert.match(prompt, /неименованн[а-яё ]*цел[а-яё ]*[\s\S]*?summary[\s\S]*?visibleFacts[\s\S]*?uncertainties/iu);
  assert.match(prompt, /выбери разумный окрашиваемый объект[\s\S]*?строительных покрытий/iu);
  assert.match(prompt, /человек[\s\S]*?контекст[\s\S]*?не[\s\S]*?целью строительной окраски/iu);
  assert.match(prompt, /ровно один blocker[\s\S]*?choices[\s\S]*?product[\s\S]*?estimates/iu);
  assert.match(prompt, /два одинаково правдоподобных неодушевлённых объекта/iu);
  assert.match(prompt, /явное свежее называние цели имеет приоритет/iu);

  assert.doesNotMatch(
    prompt,
    /resolved:[\s\S]*?обычн[а-яё ]*каталожн[а-яё ]*[\s\S]*?confidence 0\.7[\s\S]*?visibleFacts[\s\S]*?человек/iu,
  );
});

test("passes max effort to separate direct Flash text runs, not MiMo, and settles before cleanup", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const spawned = [];
  const neverCompletes = new Promise(() => {});
  const runOpenCode = runOpenCodeFromBridge(
    bridge,
    (arguments_) => spawned.push(arguments_),
    () => neverCompletes,
  );

  const reviewerResult = await runOpenCode({
    model: "deepseek/deepseek-v4-flash",
    variant: "max",
    prompt: "test",
    title: "reviewer",
    agent: "koler-reviewer",
  });
  const flashResult = await runOpenCode({
    model: "deepseek/deepseek-v4-flash",
    variant: "max",
    prompt: "test",
    title: "flash",
    agent: "koler-sales",
  });
  const visionResult = await runOpenCode({
    model: "opencode-go/mimo-v2.5",
    prompt: "test",
    title: "vision",
    agent: "koler-reviewer",
  });

  assert.equal(reviewerResult.value.ok, true);
  assert.equal(flashResult.value.ok, true);
  assert.equal(visionResult.value.ok, true);
  assert.deepEqual(
    Array.from(
      spawned[0].slice(
        spawned[0].indexOf("-m"),
        spawned[0].indexOf("--format"),
      ),
    ),
    ["-m", "deepseek/deepseek-v4-flash", "--variant", "max"],
  );
  assert.deepEqual(
    Array.from(
      spawned[1].slice(
        spawned[1].indexOf("-m"),
        spawned[1].indexOf("--format"),
      ),
    ),
    ["-m", "deepseek/deepseek-v4-flash", "--variant", "max"],
  );
  assert.deepEqual(
    Array.from(
      spawned[2].slice(
        spawned[2].indexOf("-m"),
        spawned[2].indexOf("--format"),
      ),
    ),
    ["-m", "opencode-go/mimo-v2.5"],
  );
  assert.match(
    bridge,
    /model:\s*primaryModel,\s*variant:\s*primaryVariant/,
  );
  assert.match(
    bridge,
    /model:\s*reviewerModel,\s*variant:\s*reviewerVariant/,
  );
  assert.equal(spawned[0][spawned[0].indexOf("--agent") + 1], "koler-reviewer");
  assert.equal(spawned[1][spawned[1].indexOf("--agent") + 1], "koler-sales");
  assert.match(
    bridge,
    /catch \(primaryError\)[\s\S]*?managerFallbackAgentResult\(guardedJob/,
  );
  assert.match(
    bridge,
    /isCompleteFailClosedManager\(result\)[\s\S]*?review-skipped[\s\S]*?else\s*\{[\s\S]*?agent:\s*"koler-reviewer"/u,
  );
  assert.doesNotMatch(
    bridge,
    /isFailClosedTargetAmbiguity\(result\)|markSafeTargetAmbiguityReviewSkipped/u,
  );
  assert.match(
    bridge,
    /const completeFailClosedManager = isCompleteFailClosedManager\(result\)[\s\S]*?if \(completeFailClosedManager\)[\s\S]*?else \{[\s\S]*?agent:\s*"koler-reviewer"/u,
  );
  const visionRun = bridge.slice(
    bridge.indexOf("async function visionObservationForJob"),
    bridge.indexOf("function primaryPrompt"),
  );
  assert.match(visionRun, /model:\s*visionModel/);
  assert.doesNotMatch(visionRun, /variant:/);
});

test("child env scopes the official DeepSeek key to the direct primary", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const env = {
    HOME: "/synthetic/home",
    PATH: "/synthetic/bin",
    OPENCODE_API_KEY: "provider-secret",
    OPENCODE_GO_API_KEY: "provider-secret",
    DEEPSEEK_API_KEY: "deepseek-secret",
    BRIDGE_TOKEN: "bridge-secret",
    KOLER_ADMIN_CODE: "admin-secret",
    DATABASE_URL: "database-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    APP_PASSWORD: "password-secret",
    SESSION_TOKEN: "token-secret",
  };
  const directEnvironment = childEnvironmentFromBridge(
    bridge,
    env,
    "deepseek/deepseek-v4-flash",
  );
  const reviewerEnvironment = childEnvironmentFromBridge(
    bridge,
    env,
    "deepseek/deepseek-v4-flash",
  );
  const visionEnvironment = childEnvironmentFromBridge(
    bridge,
    env,
    "opencode-go/mimo-v2.5",
  );

  assert.equal(directEnvironment.HOME, "/synthetic/home");
  assert.equal(directEnvironment.PATH, "/synthetic/bin");
  assert.equal(directEnvironment.OPENCODE_API_KEY, "provider-secret");
  assert.equal(directEnvironment.OPENCODE_GO_API_KEY, "provider-secret");
  assert.equal(directEnvironment.DEEPSEEK_API_KEY, "deepseek-secret");
  assert.equal(reviewerEnvironment.DEEPSEEK_API_KEY, "deepseek-secret");
  assert.equal(visionEnvironment.DEEPSEEK_API_KEY, undefined);
  for (const secretName of [
    "BRIDGE_TOKEN",
    "KOLER_ADMIN_CODE",
    "DATABASE_URL",
    "AWS_SECRET_ACCESS_KEY",
    "APP_PASSWORD",
    "SESSION_TOKEN",
  ]) {
    assert.equal(directEnvironment[secretName], undefined, secretName);
  }
});

test("settles a timed-out OpenCode run even when the child never closes", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const runOpenCode = runOpenCodeFromBridge(
    bridge,
    () => {},
    async () => {},
    {
      closes: false,
      createEventStream: () => ({
        push() {},
        complete: async () => ({
          textParts: ['{"captured":"timeout"}'],
          tools: [
            {
              tool: "public_webfetch",
              urls: ["https://source.example/direct"],
            },
          ],
        }),
      }),
    },
  );

  await assert.rejects(
    runOpenCode({
      model: "deepseek/deepseek-v4-flash",
      variant: "max",
      prompt: "test",
      title: "timeout",
      agent: "koler-sales",
      timeoutMs: 1,
    }),
    (error) => {
      assert.match(error.message, /OpenCode timed out/iu);
      assert.deepEqual(error.partialRun.tools[0].urls, [
        "https://source.example/direct",
      ]);
      assert.deepEqual(error.partialRun.textParts, ['{"captured":"timeout"}']);
      return true;
    },
  );
});

test("settles an OpenCode run when temporary-directory cleanup rejects", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const runOpenCode = runOpenCodeFromBridge(
    bridge,
    () => {},
    async () => {
      throw new Error("cleanup failed");
    },
  );

  await assert.doesNotReject(
    runOpenCode({
      model: "deepseek/deepseek-v4-flash",
      variant: "max",
      prompt: "test",
      title: "cleanup failure",
      agent: "koler-sales",
    }),
  );
});

test("keeps captured text and completed public URLs when telemetry publication rejects", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { createOpenCodeEventStream } = bridgeStreamHelpers(bridge);
  const stream = createOpenCodeEventStream(async () => {
    throw new Error("event endpoint unavailable");
  });
  stream.push(
    `${JSON.stringify({
      type: "tool_use",
      part: {
        tool: "public_webfetch",
        callID: "public-source",
        state: {
          status: "completed",
          input: { url: "https://public.example/card" },
        },
      },
    })}\n${JSON.stringify({
      type: "text",
      part: { text: '{"schemaVersion":2}' },
    })}\n`,
  );

  const captured = await stream.complete();
  assert.deepEqual(Array.from(captured.textParts), ['{"schemaVersion":2}']);
  assert.deepEqual(Array.from(captured.tools[0].urls), [
    "https://public.example/card",
  ]);
});

test("uses the final public_webfetch URL after a safe redirect", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { createOpenCodeEventStream } = bridgeStreamHelpers(bridge);
  const stream = createOpenCodeEventStream();
  stream.push(
    `${JSON.stringify({
      type: "tool_use",
      part: {
        tool: "public_webfetch",
        callID: "redirected-source",
        state: {
          status: "completed",
          input: { url: "https://requested.example/start" },
          output: JSON.stringify({
            url: "https://final.example/article#source",
            redirects: 1,
            text: "Public reference",
          }),
        },
      },
    })}\n`,
  );

  const captured = await stream.complete();
  assert.deepEqual(Array.from(captured.tools[0].urls), [
    "https://final.example/article",
  ]);
  assert.equal(
    captured.tools[0].urls.includes("https://requested.example/start"),
    false,
  );
  assert.match(captured.tools[0].detail, /final\.example/u);
});

test("fingerprints the bounded public excerpt that crosses the guard boundary", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { createOpenCodeEventStream } = bridgeStreamHelpers(bridge);
  const stream = createOpenCodeEventStream();
  const fullText =
    `中文 日本語 ${"Кремлёвская стена: 2235 метров. ".repeat(500)}`;
  stream.push(
    `${JSON.stringify({
      type: "tool_use",
      part: {
        tool: "public_webfetch",
        callID: "long-public-source",
        state: {
          status: "completed",
          input: { url: "https://public.example/kremlin" },
          output: JSON.stringify({
            url: "https://public.example/kremlin",
            text: fullText,
            sha256: createHash("sha256").update(fullText).digest("hex"),
          }),
        },
      },
    })}\n`,
  );

  const captured = await stream.complete();
  const [tool] = captured.tools;
  assert.equal(tool.excerpt.length, 12_000);
  assert.doesNotMatch(tool.excerpt, /[\p{Script=Han}\p{Script=Hiragana}]/u);
  assert.match(tool.excerpt, /Кремлёвская стена: 2235 метров/u);
  assert.equal(
    tool.sha256,
    createHash("sha256").update(tool.excerpt).digest("hex"),
  );
});

test("does not wait for a never-resolving telemetry publisher", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { createOpenCodeEventStream } = bridgeStreamHelpers(bridge);
  const stream = createOpenCodeEventStream(() => new Promise(() => {}));
  stream.push(
    `${JSON.stringify({
      type: "tool_use",
      part: {
        tool: "public_webfetch",
        callID: "never-resolving-publisher",
        state: {
          status: "completed",
          input: { url: "https://public.example/card" },
        },
      },
    })}\n${JSON.stringify({
      type: "text",
      part: { text: '{"captured":true}' },
    })}\n`,
  );

  const captured = await Promise.race([
    stream.complete(),
    new Promise((resolve) => setTimeout(() => resolve(null), 25)),
  ]);
  assert.ok(captured);
  assert.deepEqual(Array.from(captured.textParts), ['{"captured":true}']);
});

test("publishes up to twenty unique web actions and keeps opened URLs", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const {
    createOpenCodeEventStream,
    inventorySnapshotDetail,
  } =
    bridgeStreamHelpers(bridge);
  const published = [];
  const stream = createOpenCodeEventStream(async (tool) => {
    published.push(tool.detail);
  });
  const firstEvent = JSON.stringify({
    type: "tool_use",
    part: {
      tool: "public_webfetch",
      callID: "source-1",
      state: {
        status: "completed",
        time: { end: 1785488400000 },
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
        tool: "public_webfetch",
        callID: `source-${index + 2}`,
        state: {
          status: "completed",
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
  assert.equal(parsed.tools[0].openedAt, "2026-07-31T09:00:00.000Z");
  assert.equal(parsed.tools[1].urls.length, 0);
  assert.equal(parsed.textParts.join(""), '{"approved":true}');
  assert.equal(
    inventorySnapshotDetail(5, 1),
    "5 товаров. Данные склада взяты из обновления № 1.",
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
        tool: "public_webfetch",
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

test("uses search-result pages only for discovery, never as opened evidence", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { createOpenCodeEventStream } = bridgeStreamHelpers(bridge);

  for (const url of [
    "https://www.google.com/search?q=paint",
    "https://duckduckgo.com/?q=paint",
    "https://shop.example/search/?q=paint",
  ]) {
    const published = [];
    const stream = createOpenCodeEventStream((tool) => {
      published.push(tool.detail);
    });
    stream.push(
      `${JSON.stringify({
        type: "tool_use",
        part: {
          tool: "public_webfetch",
          callID: url,
          state: { status: "completed", input: { url } },
        },
      })}\n`,
    );
    const parsed = await stream.complete();
    assert.deepEqual(Array.from(parsed.tools[0].urls), []);
    assert.deepEqual(published, ["Выполнен поиск по открытым источникам"]);
  }
});

test("legacy webfetch events remain telemetry-only and cannot create evidence", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { createOpenCodeEventStream } = bridgeStreamHelpers(bridge);
  const stream = createOpenCodeEventStream();
  stream.push(
    `${JSON.stringify({
      type: "tool_use",
      part: {
        tool: "webfetch",
        callID: "legacy-source",
        state: {
          status: "completed",
          input: { url: "https://legacy.example/card" },
        },
      },
    })}\n`,
  );
  const captured = await stream.complete();
  assert.deepEqual(Array.from(captured.tools[0].urls), []);
  assert.match(captured.tools[0].detail, /Устаревший webfetch/iu);
});

test("records only completed public HTTPS URLs without credentials", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { createOpenCodeEventStream } = bridgeStreamHelpers(bridge);
  const rejectedUrls = [
    "http://public.example/card",
    "https://localhost/card",
    "https://127.0.0.1/card",
    "https://10.0.0.1/card",
    "https://169.254.169.254/latest",
    "https://[::1]/card",
    "https://[fd00::1]/card",
    "https://user:pass@public.example/card",
    "https://public.example/search?q=paint",
  ];

  for (const [index, url] of rejectedUrls.entries()) {
    const stream = createOpenCodeEventStream();
    stream.push(
      `${JSON.stringify({
        type: "tool_use",
        part: {
          tool: "public_webfetch",
          callID: `rejected-${index}`,
          state: { status: "completed", input: { url } },
        },
      })}\n`,
    );
    const captured = await stream.complete();
    assert.deepEqual(Array.from(captured.tools[0].urls), [], url);
  }

  const stream = createOpenCodeEventStream();
  stream.push(
    `${JSON.stringify({
      type: "tool_use",
      part: {
        tool: "public_webfetch",
        callID: "accepted-public",
        state: {
          status: "completed",
          input: { url: "https://public.example/card#section" },
        },
      },
    })}\n`,
  );
  const captured = await stream.complete();
  assert.deepEqual(Array.from(captured.tools[0].urls), [
    "https://public.example/card",
  ]);
});

test("does not treat a missing or non-completed status as opened URL evidence", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { createOpenCodeEventStream } = bridgeStreamHelpers(bridge);

  for (const status of [undefined, "running", "success", "succeeded"]) {
    const stream = createOpenCodeEventStream();
    stream.push(
      `${JSON.stringify({
        type: "tool_use",
        part: {
          tool: "public_webfetch",
          callID: `source-${status ?? "missing"}`,
          state: {
            ...(status ? { status } : {}),
            input: { url: "https://unconfirmed.example/card" },
          },
        },
      })}\n`,
    );
    const parsed = await stream.complete();
    assert.equal(parsed.tools.length, 1);
    assert.deepEqual(Array.from(parsed.tools[0].urls), []);
  }
});

test("uses the completed state of a streamed web action as evidence", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { createOpenCodeEventStream } = bridgeStreamHelpers(bridge);
  const published = [];
  const stream = createOpenCodeEventStream((tool) => {
    published.push(tool.detail);
  });
  const event = (status) =>
    JSON.stringify({
      type: "tool_use",
      part: {
        tool: "public_webfetch",
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
  assert.deepEqual(published, [
    "Открывается страница: ready.example",
    "Открыта страница: ready.example",
  ]);
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
    /"Черновик передан модели проверки"[\s\S]*?"active"/,
  );
  assert.match(
    bridge,
    /result = applyReviewerResult\([\s\S]*?"review-result"[\s\S]*?result\.review\?\.verdict/,
  );
});

test("keeps photo and non-photo work inside one 700 second job budget", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const processJob = bridge.slice(
    bridge.indexOf("async function processJob"),
    bridge.indexOf("async function heartbeatLoop"),
  );

  assert.match(
    processJob,
    /runPrimaryWithRetry\(\{[\s\S]*?agent:\s*"koler-sales"[\s\S]*?publishResearch:\s*true/,
  );
  assert.doesNotMatch(processJob, /allowsPublicSearch/);
  assert.doesNotMatch(
    bridge,
    /mentionsInn|businessContextCanChangeDecision|shouldCheckCompany/,
  );
  assert.match(bridge, /const primaryOpenCodeTimeoutMs = 600_000/u);
  assert.match(bridge, /const reviewerOpenCodeTimeoutMs = 300_000/u);
  assert.match(bridge, /const jobDeadlineMs = 700_000/u);
  assert.match(bridge, /const terminalPublicationReserveMs = agentApiTimeoutMs/u);
  assert.match(
    processJob,
    /await agentRequestWithRetry\(\s*resultPayload\(/u,
  );
  assert.match(
    processJob,
    /await agentRequestWithRetry\(\s*\{\s*action:\s*"error"/u,
  );
  assert.match(
    processJob,
    /const jobStartedAtMs = performance\.now\(\);[\s\S]*?visionObservationForJob\(\s*job,\s*jobStartedAtMs,\s*\)/u,
  );
  assert.match(
    bridge,
    /downloadVisionImage\(\{[\s\S]*?timeoutMs:\s*downloadTimeoutMs/u,
  );
  assert.match(
    bridge,
    /agent:\s*"koler-reviewer",[\s\S]*?files:\s*\[downloaded\.path\],[\s\S]*?timeoutMs:\s*attemptTimeoutMs/u,
  );
  assert.match(
    processJob,
    /const primaryTimeoutMs = stageTimeoutForDeadline\([\s\S]*?primaryOpenCodeTimeoutMs[\s\S]*?agent:\s*"koler-sales",\s*timeoutMs:\s*primaryTimeoutMs/u,
  );
  assert.match(
    processJob,
    /retry:\s*\(partialRun\)[\s\S]*?const synthesisTimeoutMs = stageTimeoutForDeadline\([\s\S]*?openCodeTimeoutMs[\s\S]*?agent:\s*"koler-sales-local",\s*timeoutMs:\s*synthesisTimeoutMs[\s\S]*?primaryRetryPrompt\(prompt, partialRun\)/u,
  );
  assert.match(bridge, /const openCodeTimeoutMs = 300_000/u);
  assert.match(bridge, /const visionOpenCodeTimeoutMs = 180_000/u);
  assert.match(
    bridge,
    /const visionTimeoutMs = stageTimeoutForDeadline\([\s\S]{0,300}visionOpenCodeTimeoutMs/u,
  );
  assert.match(
    processJob,
    /agent:\s*"koler-reviewer",\s*timeoutMs:\s*reviewerTimeoutMs/u,
  );
  assert.match(
    processJob,
    /const reviewerTimeoutMs = stageTimeoutForDeadline\([\s\S]*?jobStartedAtMs[\s\S]*?reviewerOpenCodeTimeoutMs[\s\S]*?jobDeadlineMs[\s\S]*?terminalPublicationReserveMs[\s\S]*?openCodeTerminationGraceMs/u,
  );
  assert.match(
    processJob,
    /catch \(reviewError\)[\s\S]*?approved:\s*false,\s*unavailable:\s*true/u,
  );

  const { stageTimeoutForDeadline } = bridgeStreamHelpers(bridge);
  const timeout = (nowMs, capMs, reserveMs, terminationGraceMs) =>
    stageTimeoutForDeadline(
      0,
      nowMs,
      capMs,
      700_000,
      reserveMs,
      terminationGraceMs,
    );

  // No photo: primary may use its full cap, reviewer gets only the remaining
  // model budget, and the terminal API still owns the final 12 seconds.
  assert.equal(
    timeout(0, 600_000, 12_000, 5_000),
    600_000,
  );
  assert.equal(
    timeout(600_000, 300_000, 12_000, 5_000),
    83_000,
  );
  assert.equal(
    timeout(688_000, 12_000, 0, 0),
    12_000,
  );

  // Photo: download and vision consume the same clock, so primary is capped
  // by what remains instead of receiving a fresh 700 second window.
  assert.equal(
    timeout(0, 15_000, 12_000, 0),
    15_000,
  );
  assert.equal(
    timeout(15_000, 180_000, 12_000, 5_000),
    180_000,
  );
  assert.equal(
    timeout(200_000, 600_000, 12_000, 5_000),
    483_000,
  );
  assert.equal(
    timeout(688_000, 300_000, 12_000, 5_000),
    0,
  );
});

test("retries transient terminal publication failures inside one API budget", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  let calls = 0;
  const { agentRequestWithRetry, isRetryableAgentRequestError } =
    agentRequestRetryHelpers(bridge, {
      agentRequest: async () => {
        calls += 1;
        if (calls < 3) throw new TypeError("fetch failed");
        return { ok: true };
      },
    });

  assert.equal(isRetryableAgentRequestError(new TypeError("fetch failed")), true);
  assert.equal(
    isRetryableAgentRequestError(new Error("Agent API 503: unavailable")),
    true,
  );
  assert.equal(
    isRetryableAgentRequestError(new Error("Agent API 400: invalid result")),
    false,
  );
  assert.deepEqual(
    await agentRequestWithRetry({ action: "result" }),
    { ok: true },
  );
  assert.equal(calls, 3);
});

test("skips reviewer only for a complete fail-closed manager boundary", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { isCompleteFailClosedManager } = bridgeStreamHelpers(bridge);
  const fallback = managerFallbackAgentResult(
    {
      body: "Нужно проверить свободную заявку.",
      roundNo: 1,
    },
    { reviewerModel: "deepseek/deepseek-v4-flash" },
  );

  assert.equal(isCompleteFailClosedManager(fallback), true);
  assert.equal(
    isCompleteFailClosedManager({
      ...fallback,
      review: { model: "", verdict: "", notes: [] },
    }),
    false,
    "an unreviewed manager draft still needs reviewer",
  );
  assert.equal(
    isCompleteFailClosedManager({
      ...fallback,
      zone: "yellow",
      decision: "clarify",
      route: "ready",
      commitment: "estimate",
      estimates: [{ metric: "surface_area" }],
    }),
    false,
    "estimate still needs reviewer",
  );
  assert.equal(
    isCompleteFailClosedManager({
      ...fallback,
      commitment: "commercial_offer",
      product: { sku: "КР-004" },
      supplierPlan: { supplierName: "Публичный поставщик" },
    }),
    false,
    "shortage plan still needs reviewer",
  );
  assert.equal(
    isCompleteFailClosedManager({
      ...fallback,
      zone: "green",
      decision: "quote",
      route: "ready",
      commitment: "commercial_offer",
      product: { sku: "КР-004" },
    }),
    false,
    "commercial offer still needs reviewer",
  );
  assert.equal(
    isCompleteFailClosedManager({
      ...fallback,
      resolvedIntent: {
        ...fallback.resolvedIntent,
        blocker: { kind: "target_ambiguity" },
      },
    }),
    false,
    "a blocker is not fail-closed complete",
  );
});

test("retries a timed-out primary once in synthesis mode and keeps opened sources", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { runPrimaryWithRetry } = bridgeStreamHelpers(bridge);
  let researchAttempts = 0;
  let synthesisAttempts = 0;
  const events = [];
  const openedTool = {
    tool: "public_webfetch",
    urls: ["https://source.example/direct"],
  };

  const completed = await runPrimaryWithRetry({
    run: async () => {
      researchAttempts += 1;
      const error = new Error("OpenCode timed out for model");
      error.partialRun = { textParts: [], tools: [openedTool] };
      throw error;
    },
    retry: async (partialRun) => {
      synthesisAttempts += 1;
      assert.equal(partialRun.tools[0], openedTool);
      return { value: { status: "готово" }, tools: [] };
    },
    onRetry: async (partialRun) => {
      assert.equal(partialRun.tools[0], openedTool);
      events.push("продолжение");
    },
  });

  assert.equal(researchAttempts, 1);
  assert.equal(synthesisAttempts, 1);
  assert.deepEqual(events, ["продолжение"]);
  assert.equal(completed.value.status, "готово");
  assert.equal(completed.tools[0], openedTool);

  let attemptsAfterTimeout = 0;
  await assert.rejects(
    runPrimaryWithRetry({
      run: async () => {
        attemptsAfterTimeout += 1;
        throw new Error("OpenCode timed out for model");
      },
      onRetry: async () => {},
    }),
    /timed out for model/,
  );
  assert.equal(attemptsAfterTimeout, 2);
});

test("merges primary and synthesis partial text only when the combined JSON is complete", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { runPrimaryWithRetry } = bridgeStreamHelpers(bridge);
  const openedTool = {
    tool: "public_webfetch",
    urls: ["https://source.example/direct"],
  };
  let synthesisAttempts = 0;

  const completed = await runPrimaryWithRetry({
    run: async () => {
      const error = new Error("OpenCode timed out for model");
      error.partialRun = {
        textParts: ['{"schemaVersion":2,'],
        tools: [openedTool],
      };
      throw error;
    },
    retry: async () => {
      synthesisAttempts += 1;
      const error = new Error("synthesis ended with partial text");
      error.partialRun = {
        textParts: ['"status":"complete"}'],
        tools: [openedTool],
      };
      throw error;
    },
    onRetry: async () => {
      throw new Error("retry event publication rejected");
    },
  });

  assert.equal(synthesisAttempts, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(completed.value)), {
    schemaVersion: 2,
    status: "complete",
  });
  assert.deepEqual(Array.from(completed.tools), [openedTool]);
});

test("uses complete JSON observed before timeout without a synthesis call", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { runPrimaryWithRetry } = bridgeStreamHelpers(bridge);
  let synthesisAttempts = 0;
  let retryEvents = 0;
  const completed = await runPrimaryWithRetry({
    run: async () => {
      const error = new Error("OpenCode timed out for model");
      error.partialRun = {
        textParts: ["preface", '```json\n{"schemaVersion":2}\n```'],
        tools: [
          { tool: "public_webfetch", urls: ["https://source.example/direct"] },
        ],
      };
      throw error;
    },
    retry: async () => {
      synthesisAttempts += 1;
      return { value: {}, tools: [] };
    },
    onRetry: async () => {
      retryEvents += 1;
    },
  });

  assert.equal(completed.value.schemaVersion, 2);
  assert.equal(completed.tools.length, 1);
  assert.equal(synthesisAttempts, 0);
  assert.equal(retryEvents, 0);
});

test("does not retry a primary failure unrelated to time", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { runPrimaryWithRetry } = bridgeStreamHelpers(bridge);
  let retryStarted = false;

  await assert.rejects(
    runPrimaryWithRetry({
      run: async () => {
        throw new Error("Model returned no JSON object");
      },
      onRetry: async () => {
        retryStarted = true;
      },
    }),
    /no JSON object/,
  );
  assert.equal(retryStarted, false);
});

test("repairs a complete v2 draft when root keys slip into resolvedIntent", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { runPrimaryWithRetry } = bridgeStreamHelpers(bridge);
  const malformed =
    '{"schemaVersion":2,"resolvedIntent":{"goal":"Оценить два объекта","target":{"state":"resolved","label":"Забор","evidenceIds":["ev-msg"]},"evidence":[{"id":"ev-msg","claim":"Клиент назвал забор","confidence":1,"source":{"kind":"message","roundNo":1,"quote":"забор"}}],"assumptions":[],"commitment":"estimate","estimates":[],"reply":{"subject":"Расчёт","body":"Готовый ответ"}}';
  let retries = 0;

  const completed = await runPrimaryWithRetry({
    run: async () => {
      throw Object.assign(new Error("Model returned malformed JSON"), {
        completedMalformed: true,
        partialRun: { textParts: [malformed], tools: [] },
      });
    },
    retry: async () => {
      retries += 1;
      return { value: null, tools: [] };
    },
  });

  assert.equal(retries, 0);
  assert.equal(completed.value.commitment, "estimate");
  assert.equal(completed.value.reply.body, "Готовый ответ");
  assert.equal(completed.value.resolvedIntent.commitment, undefined);
});

test("retries one malformed or empty transport primary result", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { runPrimaryWithRetry } = bridgeStreamHelpers(bridge);

  for (const error of [
    Object.assign(new Error("Model returned malformed JSON"), {
      completedMalformed: true,
      partialRun: { textParts: ['{"schemaVersion":2'], tools: [] },
    }),
    Object.assign(new Error("OpenCode exited with 1"), {
      partialRun: { textParts: [], tools: [] },
    }),
  ]) {
    let retries = 0;
    const completed = await runPrimaryWithRetry({
      run: async () => {
        throw error;
      },
      retry: async () => {
        retries += 1;
        return { value: { schemaVersion: 2 }, tools: [] };
      },
    });

    assert.equal(retries, 1, error.message);
    assert.equal(completed.value.schemaVersion, 2, error.message);
  }
});

test("retries partial web research once when it ends without JSON", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { runPrimaryWithRetry } = bridgeStreamHelpers(bridge);
  const openedTool = {
    tool: "public_webfetch",
    urls: ["https://source.example/direct"],
  };

  const completed = await runPrimaryWithRetry({
    run: async () => {
      const error = new Error("Model returned no JSON object");
      error.partialRun = { textParts: [], tools: [openedTool] };
      throw error;
    },
    retry: async () => ({ value: { status: "готово" }, tools: [] }),
    onRetry: async () => {},
  });

  assert.equal(completed.value.status, "готово");
  assert.equal(completed.tools[0], openedTool);
});

test("keeps completed tool evidence when OpenCode exits nonzero", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const openedTool = {
      tool: "public_webfetch",
    urls: ["https://source.example/direct"],
  };
  const runOpenCode = runOpenCodeFromBridge(
    bridge,
    () => {},
    async () => {},
    {
      closeCode: 1,
      createEventStream: () => ({
        push() {},
        complete: async () => ({ textParts: [], tools: [openedTool] }),
      }),
    },
  );

  await assert.rejects(
    runOpenCode({
      model: "deepseek/deepseek-v4-flash",
      variant: "max",
      prompt: "test",
      title: "partial research",
      agent: "koler-sales",
    }),
    (error) => {
      assert.equal(error.partialRun.tools[0].urls[0], openedTool.urls[0]);
      return true;
    },
  );
});

test("marks a close-zero reviewer parser failure as completed malformed", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const runOpenCode = runOpenCodeFromBridge(
    bridge,
    () => {},
    async () => {},
    {
      closeCode: 0,
      createEventStream: () => ({
        push() {},
        complete: async () => ({ textParts: ["No JSON result"], tools: [] }),
      }),
    },
  );

  await assert.rejects(
    runOpenCode({
      model: "deepseek/deepseek-v4-flash",
      variant: "max",
      prompt: "review",
      title: "malformed reviewer",
      agent: "koler-reviewer",
    }),
    (error) => {
      assert.equal(error.completedMalformed, true);
      assert.equal(error.partialRun.textParts[0], "No JSON result");
      return true;
    },
  );
});

test("accepts complete JSON from nonzero close and child error before retry classification", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { runPrimaryWithRetry } = bridgeStreamHelpers(bridge);
  const openedTool = {
    tool: "public_webfetch",
    urls: ["https://source.example/direct"],
  };
  const captured = {
    textParts: ['{"schemaVersion":2,"status":"captured"}'],
    tools: [openedTool],
  };
  const runNonzero = runOpenCodeFromBridge(
    bridge,
    () => {},
    async () => {},
    {
      closeCode: 1,
      createEventStream: () => ({
        push() {},
        complete: async () => captured,
      }),
    },
  );
  let nonzeroRetry = false;
  const nonzeroResult = await runPrimaryWithRetry({
    run: () =>
      runNonzero({
        model: "deepseek/deepseek-v4-flash",
        prompt: "test",
        title: "nonzero complete",
        agent: "koler-sales",
      }),
    retry: async () => {
      nonzeroRetry = true;
      return { value: {}, tools: [] };
    },
    onRetry: async () => {
      nonzeroRetry = true;
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(nonzeroResult.value)), {
    schemaVersion: 2,
    status: "captured",
  });
  assert.deepEqual(Array.from(nonzeroResult.tools), [openedTool]);
  assert.equal(nonzeroRetry, false);

  const childError = new Error("spawn failed");
  const runChild = runOpenCodeFromBridge(
    bridge,
    (_arguments_, child) => {
      queueMicrotask(() => child.emit("error", childError));
    },
    async () => {},
    {
      closes: false,
      createEventStream: () => ({
        push() {},
        complete: async () => captured,
      }),
    },
  );
  await assert.rejects(
    runChild({
      model: "deepseek/deepseek-v4-flash",
      prompt: "test",
      title: "child error",
      agent: "koler-sales",
    }),
    (error) => {
      assert.deepEqual(JSON.parse(JSON.stringify(error.partialRun)), captured);
      return true;
    },
  );
});

test("keeps first-round ambiguity under independent review and gives it the full latest message", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    bridge,
    /targetAmbiguityOnly|markSafeTargetAmbiguityReviewSkipped/u,
  );
  assert.match(
    bridge,
    /if \(completeFailClosedManager\)[\s\S]*?else \{[\s\S]*?agent:\s*"koler-reviewer"/u,
  );
  const { reviewerOrderView } = bridgePromptHelpers(bridge);
  const prompt = reviewPromptFromBridge(bridge, reviewerOrderView, (value) => value);
  const latest = "На фото два объекта: прибор и автомобиль. Покрасьте ровно X; объект — прибор.";
  const rendered = prompt(
    {
      body: latest,
      conversationJson: JSON.stringify([{ role: "customer", body: latest }]),
      roundNo: 1,
    },
    { resolvedIntent: { blocker: { kind: "target_ambiguity" } } },
    { products: [], market: [], rules: {} },
  );
  assert.match(rendered, /На фото два объекта: прибор и автомобиль\. Покрасьте ровно X; объект — прибор\./u);
  assert.match(rendered, /Последнее сообщение клиента целиком/u);
});

function shortageReviewCandidate() {
  return {
    schemaVersion: 2,
    zone: "red",
    decision: "escalate",
    route: "manager",
    commitment: "commercial_offer",
    product: {
      sku: "КР-004",
      requestedKg: 2_000,
      stockKg: 300,
      pricePerKg: 361,
      total: 722_000,
    },
    supplierPlan: {
      supplierName: "ПромКолор Опт",
      ourKg: 300,
      supplierKg: 1_700,
      total: 718_400,
      deliveryDays: 4,
      stockCheckedAt: "2026-07-31T09:00:00Z",
    },
    options: [],
    reply: {
      subject: "План поставки",
      body: "Руководитель подтвердит совместную поставку.",
    },
    review: { model: "", verdict: "", notes: [] },
  };
}

function reviewPacketFor(candidate) {
  return Object.freeze({
    order: { body: "Нужна партия покрытия." },
    result: {
      supplierPlan: {
        supplierName: candidate.supplierPlan.supplierName,
        supplierKg: candidate.supplierPlan.supplierKg,
        total: candidate.supplierPlan.total,
      },
      reply: { body: candidate.reply.body },
    },
  });
}

function ambiguityReviewPacket() {
  return Object.freeze({
    order: { body: "На фото два возможных объекта." },
    result: {
      zone: "yellow",
      route: "needs_info",
      commitment: "none",
      resolvedIntent: {
        target: {
          state: "ambiguous",
          candidates: [
            { label: "inanimate surface" },
            { label: "visible human feature" },
          ],
        },
        blocker: { kind: "target_ambiguity", question: "Что красим?" },
      },
      product: null,
      estimates: [],
      supplierLeads: [],
      options: [],
      reply: {
        body: ambiguityReply("Что красим?", [
          "inanimate surface",
          "visible human feature",
        ]).body,
      },
    },
  });
}

function candidateOnlyAmbiguityDecision(rule) {
  return {
    schemaVersion: 2,
    approved: false,
    verdict: "reject",
    notes: [],
    blockingIssues: [{
      rule,
      path: "/result/resolvedIntent/target/candidates/1/label",
      quote: "visible human feature",
      detail: "Кандидат сам по себе не является рекомендацией покрытия.",
    }],
  };
}

function canonicalReplyAmbiguityDecision(rule, packet) {
  return {
    schemaVersion: 2,
    approved: false,
    verdict: "reject",
    notes: [],
    blockingIssues: [{
      rule,
      path: "/result/reply/body",
      quote: packet.result.reply.body,
      detail: "Нейтральный кандидат якобы является рекомендацией материала.",
    }],
  };
}

test("retries an invalid legacy or missing-plan reviewer once and preserves a valid shortage approval", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { reviewerDecisionWithRetry } = reviewerFlowHelpers(bridge);
  const candidate = shortageReviewCandidate();
  const packet = reviewPacketFor(candidate);
  const validApproval = {
    schemaVersion: 2,
    approved: true,
    verdict: "Проверка завершена",
    notes: ["Дефицит и план поставки сохранены."],
    blockingIssues: [],
  };

  for (const invalidFirst of [
    {
      approved: true,
      verdict: "legacy verdict",
      notes: [],
      blockingIssues: [],
    },
    {
      schemaVersion: 2,
      approved: true,
      verdict: "missing plan verdict",
      notes: [],
    },
  ]) {
    const calls = [];
    let retryEvents = 0;
    const outcome = await reviewerDecisionWithRetry({
      packet,
      prompt: "first review",
      run: async (call) => {
        calls.push(call);
        return { value: calls.length === 1 ? invalidFirst : validApproval };
      },
      onRetry: () => {
        retryEvents += 1;
      },
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].packet, packet);
    assert.equal(calls[1].packet, packet);
    assert.equal(retryEvents, 1);
    assert.match(calls[1].prompt, /не прошёл ReviewerDecisionV2/u);
    assert.match(calls[1].prompt, /Не вызывай инструменты и не начинай новый поиск/u);
    assert.equal(outcome.review.approved, true);

    const applied = applyReviewerResult(
      structuredClone(candidate),
      outcome.review,
      "deepseek/deepseek-v4-flash",
      {},
      {},
    );
    assert.equal(applied.product.requestedKg, 2_000);
    assert.equal(applied.supplierPlan.supplierKg, 1_700);
    assert.equal(applied.supplierPlan.total, 718_400);
  }
});

test("reconciles candidate-only ambiguity aliases once and fails closed after a second invalid result", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { reviewerDecisionWithRetry } = reviewerFlowHelpers(bridge);
  const validApproval = {
    schemaVersion: 2,
    approved: true,
    verdict: "Проверка завершена",
    notes: [],
    blockingIssues: [],
  };

  for (const rule of ["human_safety", "target_consistency", "privacy"]) {
    const packet = ambiguityReviewPacket();
    const calls = [];
    let retryEvents = 0;
    const outcome = await reviewerDecisionWithRetry({
      packet,
      prompt: "first review",
      run: async (call) => {
        calls.push(call);
        return {
          value: calls.length === 1
            ? candidateOnlyAmbiguityDecision(rule)
            : validApproval,
        };
      },
      onRetry: () => {
        retryEvents += 1;
      },
    });

    assert.equal(calls.length, 2, rule);
    assert.equal(retryEvents, 1, rule);
    assert.equal(outcome.retried, true, rule);
    assert.equal(outcome.review.approved, true, rule);
  }

  const packet = ambiguityReviewPacket();
  const calls = [];
  const outcome = await reviewerDecisionWithRetry({
    packet,
    prompt: "first review",
    run: async (call) => {
      calls.push(call);
      return { value: candidateOnlyAmbiguityDecision("target_consistency") };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(outcome.retried, true);
  assert.equal(outcome.review.unavailable, true);
});

test("reconciles a canonical ambiguity reply mutant for every reviewer alias", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { reviewerDecisionWithRetry } = reviewerFlowHelpers(bridge);
  const validApproval = {
    schemaVersion: 2,
    approved: true,
    verdict: "Проверка завершена",
    notes: [],
    blockingIssues: [],
  };

  for (const rule of [
    "target_consistency",
    "privacy",
    "unsupported_claim",
  ]) {
    const packet = ambiguityReviewPacket();
    const calls = [];
    let retryEvents = 0;
    const outcome = await reviewerDecisionWithRetry({
      packet,
      prompt: "first review",
      run: async (call) => {
        calls.push(call);
        return {
          value: calls.length === 1
            ? canonicalReplyAmbiguityDecision(rule, packet)
            : validApproval,
        };
      },
      onRetry: () => {
        retryEvents += 1;
      },
    });

    assert.equal(calls.length, 2, rule);
    assert.equal(retryEvents, 1, rule);
    assert.equal(outcome.review.approved, true, rule);
  }

  const packet = ambiguityReviewPacket();
  const calls = [];
  const outcome = await reviewerDecisionWithRetry({
    packet,
    prompt: "first review",
    run: async (call) => {
      calls.push(call);
      return {
        value: canonicalReplyAmbiguityDecision("unsupported_claim", packet),
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(outcome.retried, true);
  assert.equal(outcome.review.unavailable, true);
});

test("bridge reconciles only a completed malformed reviewer result once", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { reviewerDecisionWithRetry } = reviewerFlowHelpers(bridge);
  const packet = reviewPacketFor(shortageReviewCandidate());
  const validApproval = {
    schemaVersion: 2,
    approved: true,
    verdict: "Проверка завершена",
    notes: [],
    blockingIssues: [],
  };
  const calls = [];
  const secret = "Bearer first-review-secret";
  const outcome = await reviewerDecisionWithRetry({
    packet,
    prompt: "first review",
    run: async (call) => {
      calls.push(call);
      if (calls.length === 1) {
        const error = new Error("No JSON result");
        error.completedMalformed = true;
        error.partialRun = { textParts: [secret], tools: [] };
        throw error;
      }
      return { value: validApproval };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(outcome.review.approved, true);
  assert.doesNotMatch(calls[1].prompt, /Bearer|first-review-secret/iu);
});

test("does not echo credential-like reviewer output into the retry prompt", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { reviewerDecisionWithRetry } = reviewerFlowHelpers(bridge);
  const packet = reviewPacketFor(shortageReviewCandidate());
  const validApproval = {
    schemaVersion: 2,
    approved: true,
    verdict: "Проверка завершена",
    notes: [],
    blockingIssues: [],
  };
  const calls = [];
  const outcome = await reviewerDecisionWithRetry({
    packet,
    prompt: "first review",
    run: async (call) => {
      calls.push(call);
      return calls.length === 1
        ? {
            value: {
              schemaVersion: 2,
              approved: false,
              verdict: "Bearer abcdefghijkl",
              notes: ["secret-note"],
              blockingIssues: [
                {
                  rule: "privacy",
                  path: "/result/reply/body",
                  quote: "token-secret",
                  detail: "secret-detail",
                },
              ],
            },
          }
        : { value: validApproval };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(outcome.review.approved, true);
  assert.match(
    calls[1].prompt,
    /"schemaVersion":\{"type":"number","value":2\}/u,
  );
  assert.match(calls[1].prompt, /"approved":false/u);
  assert.match(calls[1].prompt, /"blockingIssueCount":1/u);
  assert.match(calls[1].prompt, /не прошёл ReviewerDecisionV2/u);
  assert.doesNotMatch(calls[1].prompt, /Bearer|token|secret|abcdefghijkl/iu);
});

test("does not retry a valid grounded reject and sends the result to the manager", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { reviewerDecisionWithRetry } = reviewerFlowHelpers(bridge);
  const candidate = shortageReviewCandidate();
  const packet = reviewPacketFor(candidate);
  const validReject = {
    schemaVersion: 2,
    approved: false,
    verdict: "Нужна ручная проверка",
    notes: ["Ответ нельзя отправлять автоматически."],
    blockingIssues: [
      {
        rule: "material_utility",
        path: "/result/reply/body",
        quote: packet.result.reply.body,
        detail: "Следующий шаг для клиента не подтверждён.",
      },
    ],
  };
  const calls = [];
  let retryEvents = 0;
  const outcome = await reviewerDecisionWithRetry({
    packet,
    prompt: "first review",
    run: async (call) => {
      calls.push(call);
      return { value: validReject };
    },
    onRetry: () => {
      retryEvents += 1;
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(retryEvents, 0);
  assert.equal(outcome.review.approved, false);
  assert.deepEqual(outcome.review.blockingIssues, [
    "Следующий шаг для клиента не подтверждён.",
  ]);

  const applied = applyReviewerResult(
    structuredClone(candidate),
    outcome.review,
    "deepseek/deepseek-v4-flash",
    {},
    {},
  );
  assert.equal(applied.route, "manager");
  assert.equal(applied.commitment, "none");
  assert.equal(applied.product, null);
  assert.equal(applied.supplierPlan, undefined);
});

test("fails closed after the second invalid review, no remaining time, or timeout without a third call", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const { reviewerDecisionWithRetry } = reviewerFlowHelpers(bridge);
  const packet = reviewPacketFor(shortageReviewCandidate());
  const invalid = {
    schemaVersion: 2,
    approved: true,
    verdict: "still invalid",
    notes: [],
  };
  const cases = [
    { name: "second invalid" },
    { name: "no remaining time" },
    { name: "timeout" },
  ];

  for (const scenario of cases) {
    const calls = [];
    let retryEvents = 0;
    const outcome = await reviewerDecisionWithRetry({
      packet,
      prompt: "first review",
      run: async (call) => {
        calls.push(call);
        if (scenario.name === "no remaining time" && calls.length === 2) {
          throw new Error("OpenCode timed out before reviewer: job deadline exhausted");
        }
        if (scenario.name === "timeout") {
          throw new Error("OpenCode timed out for deepseek/deepseek-v4-flash");
        }
        return { value: invalid };
      },
      onRetry: () => {
        retryEvents += 1;
      },
    });

    assert.equal(outcome.review.unavailable, true, scenario.name);
    assert.ok(calls.length <= 2, scenario.name);
    assert.equal(
      retryEvents,
      scenario.name === "timeout" ? 0 : 1,
      scenario.name,
    );
  }
});

test("publishes one review-retry event and one terminal result after reconciliation", async () => {
  const bridge = await readFile(
    new URL("../scripts/agent-bridge.mjs", import.meta.url),
    "utf8",
  );
  const processJob = bridge.slice(
    bridge.indexOf("async function processJob"),
    bridge.indexOf("async function heartbeatLoop"),
  );
  const publisherStart = processJob.indexOf(
    "onRetry: () =>",
    processJob.indexOf("const reviewOutcome"),
  );
  const publisherEnd = processJob.indexOf("\n        });", publisherStart);
  assert.ok(publisherStart >= 0 && publisherEnd > publisherStart);
  const publisherSource = processJob
    .slice(processJob.indexOf("() =>", publisherStart), publisherEnd)
    .trim()
    .replace(/,$/u, "");
  const events = [];
  const publishRetry = runInNewContext(`(${publisherSource})`, {
    addEvent: async (...event) => events.push(event),
    job: { id: "synthetic-order" },
  });

  await publishRetry();

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], [
    { id: "synthetic-order" },
    "review-retry",
    "Повторная проверка reviewer",
    "Первый ответ не прошёл ReviewerDecisionV2; повтор использует тот же неизменяемый пакет без инструментов и нового поиска.",
    "active",
  ]);
  assert.equal((processJob.match(/resultPayload\(/gu) ?? []).length, 1);
  assert.equal(
    (processJob.match(/agentRequestWithRetry\(\s*resultPayload/gu) ?? [])
      .length,
    1,
  );
  assert.doesNotMatch(processJob, /reviewRun\.value/u);
  assert.doesNotMatch(processJob, /reviewerRetryReason/u);
});
