import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_UPLOAD_BYTES,
  containsPersonalInference,
  normalizeVisionObservation,
  resolveVisionImageUrl,
  validateImageUpload,
} from "../lib/upload-guard.mjs";

test("privacy lexemes use Unicode letter boundaries", () => {
  for (const value of [
    "женщина в кадре",
    "женщина примерно 30 лет",
    "мальчик лет десяти",
    "девочка рядом со стеной",
    "a young woman",
    "middle-aged female",
    "teenage boy",
  ]) {
    assert.equal(containsPersonalInference(value), true, value);
  }
  for (const value of [
    "изображение стены",
    "предложение по краске",
    "снижение цены",
    "движение камеры",
    "Need twenty kilograms для стены",
  ]) {
    assert.equal(containsPersonalInference(value), false, value);
  }
});

test("vision stores a person neutrally instead of retaining relations or demographics", () => {
  for (const description of [
    "жена клиента",
    "его муж",
    "дочь клиента",
    "мальчик лет десяти",
    "middle-aged female",
    "teenage boy",
  ]) {
    const observation = normalizeVisionObservation({
      attachmentRef: "synthetic://privacy-check",
      relevance: "relevant",
      summary: description,
      targetCandidates: [
        { label: description, confidence: 0.8, evidence: description },
      ],
      visibleFacts: [description],
      uncertainties: [],
    });

    assert.equal(observation.summary, "человек", description);
    assert.deepEqual(observation.visibleFacts, ["человек"], description);
    assert.deepEqual(
      observation.targetCandidates,
      [{ label: "человек", confidence: 0.8, evidence: "человек" }],
      description,
    );
  }
});

test("privacy strips standalone demographic labels but keeps scene and product facts", () => {
  const observationFor = (fact) =>
    normalizeVisionObservation({
      attachmentRef: "synthetic://privacy-labels",
      relevance: "relevant",
      summary: fact,
      visibleFacts: [fact],
      targetCandidates: [{ label: fact, confidence: 0.8, evidence: fact }],
      scaleEvidence: [fact],
      uncertainties: [fact],
    });

  for (const fact of [
    "Age: 42",
    "42 years old",
    "Gender: nonbinary",
    "gender male/female",
    "Pronouns: they/them",
    "возраст 42",
    "пол мужской",
  ]) {
    const observation = observationFor(fact);
    assert.equal(observation.summary, "человек", fact);
    assert.deepEqual(observation.visibleFacts, ["человек"], fact);
    assert.deepEqual(
      observation.targetCandidates,
      [{ label: "человек", confidence: 0.8, evidence: "человек" }],
      fact,
    );
    assert.deepEqual(observation.scaleEvidence, ["человек"], fact);
    assert.deepEqual(observation.uncertainties, ["человек"], fact);
  }

  for (const fact of [
    "wall area 42 m²",
    "42 kg paint",
    "model year 2026",
    "детская кровать",
    "male connector / разъём «папа»",
  ]) {
    const observation = observationFor(fact);
    assert.equal(observation.summary, fact, fact);
    assert.deepEqual(observation.visibleFacts, [fact], fact);
    assert.deepEqual(
      observation.targetCandidates,
      [{ label: fact, confidence: 0.8, evidence: fact }],
      fact,
    );
    assert.deepEqual(observation.scaleEvidence, [fact], fact);
    assert.deepEqual(observation.uncertainties, [fact], fact);
  }
});

test("vision removes stray CJK fragments without losing surrounding facts", () => {
  const observation = normalizeVisionObservation({
    relevance: "relevant",
    summary: "Стена и плинтус, 作为 ориентир масштаба",
    visibleFacts: ["Плинтус 作为 ориентир"],
    targetCandidates: [
      { label: "Стена", confidence: 0.8, evidence: "墙 Стена в кадре" },
    ],
  });

  assert.equal(observation.summary, "Стена и плинтус, ориентир масштаба");
  assert.deepEqual(observation.visibleFacts, ["Плинтус ориентир"]);
  assert.deepEqual(observation.targetCandidates, [
    { label: "Стена", confidence: 0.8, evidence: "Стена в кадре" },
  ]);
});

test("preserves candidates until overflow, then selects semantic representatives", () => {
  const targetCandidates = [
    { label: "Стена", confidence: 0.91, evidence: "Стена занимает фон" },
    {
      label: "Поверхность стены",
      confidence: 0.82,
      evidence: "Поверхность стены видна на фото",
    },
    { label: "Потолок", confidence: 0.8, evidence: "Потолок виден" },
    { label: "Пол", confidence: 0.79, evidence: "Пол виден" },
    { label: "Дверь", confidence: 0.78, evidence: "Дверь видна" },
    { label: "Окно", confidence: 0.77, evidence: "Окно видно" },
    { label: "Фасад", confidence: 0.76, evidence: "Фасад виден" },
  ];
  const input = {
    relevance: "relevant",
    summary: "Сцена",
    targetCandidates,
  };

  const observation = normalizeVisionObservation(input);

  assert.deepEqual(
    observation.targetCandidates,
    [
      targetCandidates[0],
      targetCandidates[2],
      targetCandidates[3],
      targetCandidates[4],
      targetCandidates[5],
      targetCandidates[6],
    ],
  );
  assert.deepEqual(input.targetCandidates, targetCandidates);

  const withinCap = targetCandidates.slice(0, 6);
  const preserved = normalizeVisionObservation({
    relevance: "relevant",
    summary: "Сцена",
    targetCandidates: withinCap,
  });
  assert.deepEqual(preserved.targetCandidates, withinCap);

  const numbered = Array.from({ length: 7 }, (_, index) => ({
    label: `фрагмент ${index + 1}`,
    confidence: 0.9,
    evidence: `признак ${index + 1}`,
  }));
  const numberedObservation = normalizeVisionObservation({
    relevance: "relevant",
    summary: "Фрагменты",
    targetCandidates: numbered,
  });
  assert.deepEqual(
    numberedObservation.targetCandidates.map((candidate) => candidate.label),
    numbered.slice(0, 6).map((candidate) => candidate.label),
  );
  assert.deepEqual(numberedObservation.targetCandidates[0], numbered[0]);
  assert.deepEqual(numberedObservation.targetCandidates[5], numbered[5]);
});

test("fails closed for unknown metadata and oversized files", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  const validate = (overrides = {}) =>
    validateImageUpload({
      name: "photo.jpg",
      declaredType: "image/jpeg",
      size: 1024,
      head: jpeg,
      ...overrides,
    });

  assert.throws(
    () => validate({ declaredType: "" }),
    (error) => error?.code === "type_mismatch" && error?.status === 415,
  );
  assert.throws(
    () => validate({ head: Uint8Array.from([1, 2, 3]) }),
    (error) => error?.code === "type_mismatch" && error?.status === 415,
  );
  assert.throws(
    () => validate({ size: MAX_UPLOAD_BYTES + 1 }),
    (error) => error?.code === "file_too_large" && error?.status === 413,
  );
});

test("rejects protocol-relative attachment hosts", () => {
  assert.equal(
    resolveVisionImageUrl("//attacker.example/photo.jpg", "https://koler.test"),
    null,
  );
  assert.equal(
    resolveVisionImageUrl(
      "/api/uploads?key=customer-images%2F018fa79939e87903ba250514d02e70b8.jpg",
      "https://koler.test",
    ),
    "https://koler.test/api/uploads?key=customer-images%2F018fa79939e87903ba250514d02e70b8.jpg",
  );
});
