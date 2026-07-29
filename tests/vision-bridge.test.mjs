import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeVisionObservation,
  resolveVisionImageUrl,
  uploadSource,
  visionPromptBlock,
} from "../lib/upload-guard.mjs";

const key = "customer-images/018fa79939e87903ba250514d02e70b8.jpg";

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
