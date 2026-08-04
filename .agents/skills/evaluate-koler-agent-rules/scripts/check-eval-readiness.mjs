#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../../../..");

const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(["--help", "--json"]);
const unknownArgs = [...args].filter((arg) => !allowedArgs.has(arg));

if (unknownArgs.length > 0) {
  console.error(`Unknown option: ${unknownArgs.join(", ")}`);
  process.exitCode = 2;
} else if (args.has("--help")) {
  console.log(`Usage:
  node .agents/skills/evaluate-koler-agent-rules/scripts/check-eval-readiness.mjs [--json]

Read-only static check of eval contracts, model roles, corpus anchors, prompts,
history surfaces, and executable regression coverage. It does not run models,
read environment values, query production services, or modify files.`);
} else {
  const cache = new Map();
  const results = [];

  async function source(relativePath) {
    if (!cache.has(relativePath)) {
      cache.set(
        relativePath,
        readFile(resolve(projectRoot, relativePath), "utf8").catch(() => null),
      );
    }
    return cache.get(relativePath);
  }

  async function check(id, relativePath, patterns, purpose) {
    const text = await source(relativePath);
    const missing = [];

    if (text === null) {
      missing.push("file");
    } else {
      for (const pattern of patterns) {
        if (!pattern.test(text)) missing.push(pattern.toString());
      }
    }

    results.push({
      id,
      status: missing.length === 0 ? "PASS" : "FAIL",
      file: relativePath,
      purpose,
      missing,
    });
  }

  await check(
    "agent-result-contract",
    "lib/demo-engine.ts",
    [
      /export type AgentResult\s*=/u,
      /zone:\s*"green"\s*\|\s*"yellow"\s*\|\s*"red"/u,
      /decision:\s*"quote"\s*\|\s*"clarify"\s*\|\s*"escalate"/u,
      /route:\s*"ready"\s*\|\s*"needs_info"\s*\|\s*"manager"/u,
      /research\?:/u,
      /review:\s*\{/u,
    ],
    "Canonical observable result is present.",
  );
  await check(
    "guard-entry-points",
    "lib/agent-guard.mjs",
    [
      /export function normalizeAgentResult/u,
      /export function applyReviewerResult/u,
      /export function isCompleteAgentResult/u,
      /openedSourceUrls/u,
    ],
    "Live output has normalization, reviewer, completeness, and opened-source gates.",
  );
  await check(
    "canonical-scenario-families",
    "data/order-scenarios.ts",
    [
      /id:\s*"green"/u,
      /id:\s*"yellow"/u,
      /id:\s*"red"/u,
      /demoKind:\s*"fence-photo"/u,
      /КР-099/u,
      /^(?![\s\S]*ПРОТЕК)/u,
    ],
    "Active green/yellow/red, fence, and unknown-SKU inputs exist without a named legacy preset.",
  );
  await check(
    "secondary-shortage-regression",
    "tests/demo-engine.test.mjs",
    [
      /requestedKg,\s*620/u,
      /ourKg,\s*420/u,
      /доступно 260 кг/u,
      /stockKg,\s*700/u,
    ],
    "The old 620/420/260/700 arithmetic remains an anonymized executable regression.",
  );
  await check(
    "secondary-shortage-fallback",
    "tests/supplier-plan.test.mjs",
    [/снижении быстрого поставщика до 150 кг/iu],
    "The old 150 kg supplier fallback remains an anonymized executable regression.",
  );
  await check(
    "main-shortage-reference",
    ".agents/skills/operate-koler-webinar/references/canonical-scenario.md",
    [
      /КР-001/u,
      /2 000 кг/u,
      /300 кг/u,
      /1 700 кг/u,
      /ПромКолор Опт/u,
      /718 400/u,
      /secondary\/legacy/u,
    ],
    "Main operator reference is the 2 000/300 shortage scenario; PROTEK is secondary.",
  );
  await check(
    "main-shortage-scripts",
    ".agents/skills/operate-koler-webinar/scripts/check-main-scenario.mjs",
    [
      /SHORTAGE_SKU\s*=\s*"КР-001"/u,
      /REQUESTED_KG\s*=\s*2_000/u,
      /OWN_STOCK_KG\s*=\s*300/u,
      /DEFICIT_KG\s*=\s*1_700/u,
      /SHORTAGE_SUPPLIER\s*=\s*"ПромКолор Опт"/u,
      /TOTAL_RUB\s*=\s*718_400/u,
    ],
    "Main scenario checker encodes the shortage contract and exposes drift.",
  );
  await check(
    "manual-improvement-boundary",
    "public/prompts/improver.md",
    [
      /запускает эту инструкцию вручную/iu,
      /Не используй скрытые рассуждения моделей/iu,
      /проверку, которая докажет улучшение/iu,
    ],
    "Improvement remains manual, observable, and regression-driven.",
  );
  await check(
    "model-role-chain",
    "scripts/agent-bridge.mjs",
    [
      /const strongReviewer\s*=\s*"deepseek\/deepseek-v4-flash"/u,
      /const visionModel\s*=\s*"opencode-go\/mimo-v2\.5"/u,
      /runPrimaryWithRetry/u,
      /applyReviewerResult/u,
    ],
    "Primary, reviewer, vision, and retry stages remain separable.",
  );
  await check(
    "runtime-model-catalog",
    "data/models.json",
    [
      /deepseek\/deepseek-v4-flash/u,
      /"roles":\s*\["primary",\s*"reviewer"\]/u,
    ],
    "Primary and reviewer use the explicit Flash catalog entry.",
  );
  await check(
    "runtime-model-variants",
    "data/models.json",
    [
      /"default":\s*"deepseek\/deepseek-v4-flash"/u,
      /"id":\s*"deepseek\/deepseek-v4-flash"[\s\S]{0,220}"variant":\s*"max"/u,
    ],
    "Direct Flash primary and reviewer variant is exact and explicit.",
  );
  await check(
    "direct-deepseek-provider",
    "opencode.json",
    [
      /https:\/\/api\.deepseek\.com\/v1/u,
      /DEEPSEEK_API_KEY/u,
      /deepseek-v4-flash/u,
    ],
    "Primary provider uses the official DeepSeek API without embedding a secret.",
  );
  await check(
    "public-web-transport",
    ".opencode/agents/koler-sales.md",
    [
      /webfetch:\s*deny/u,
      /public_webfetch:\s*allow/u,
      /только custom tool `public_webfetch`/iu,
    ],
    "Builtin webfetch is denied and only custom public_webfetch is available.",
  );
  await check(
    "public-web-bounds",
    "lib/public-web-fetch.mjs",
    [
      /validatePublicHttpsUrl/u,
      /resolvePublicTarget/u,
      /pinnedAddress/u,
      /MAX_REDIRECTS/u,
      /MAX_RESPONSE_BYTES/u,
      /allowedContentTypes/u,
    ],
    "Public web egress validates HTTPS/DNS pinning and bounds redirects, size and type.",
  );
  await check(
    "model-chain-deadline",
    "scripts/agent-bridge.mjs",
    [
      /primaryOpenCodeTimeoutMs\s*=\s*600_000/u,
      /openCodeTimeoutMs\s*=\s*300_000/u,
      /visionOpenCodeTimeoutMs\s*=\s*180_000/u,
      /reviewerOpenCodeTimeoutMs\s*=\s*300_000/u,
      /jobDeadlineMs\s*=\s*650_000/u,
      /stageTimeoutForDeadline/u,
      /const jobStartedAtMs = performance\.now\(\);/u,
      /terminalPublicationReserveMs\s*=\s*agentApiTimeoutMs/u,
    ],
    "Primary, synthesis and reviewer are bounded by the shared 650 second deadline.",
  );
  await check(
    "result-history-surface",
    "lib/result-history.ts",
    [
      /orderResultHistory/u,
      /resultJson/u,
      /inventorySnapshotJson/u,
      /reviewerModel/u,
    ],
    "Recorded decisions retain enough observable context for replay.",
  );
  await check(
    "guard-regression-families",
    "tests/agent-guard.test.mjs",
    [
      /unknown SKU/iu,
      /fence photo request/iu,
      /researched floor/iu,
      /shortage/iu,
      /negative model review/iu,
      /opened URL/iu,
      /contradictory or partial live result/iu,
    ],
    "Safety and routing families have executable guard coverage.",
  );
  await check(
    "bridge-fallback-regressions",
    "tests/vision-bridge.test.mjs",
    [
      /opened URLs/iu,
      /failed web action/iu,
      /settles a timed-out OpenCode run/iu,
      /retries a timed-out primary once in synthesis mode/iu,
      /unrelated to time/iu,
    ],
    "Sources, timeout retry, and non-timeout failure paths are executable.",
  );
  await check(
    "deterministic-calculation-regressions",
    "tests/demo-engine.test.mjs",
    [
      /calculates fence paint/iu,
      /company profile/iu,
      /live stock change/iu,
      /payment terms/iu,
    ],
    "Calculation, PROTEK-like context, stock, and special terms are covered.",
  );
  await check(
    "ledger-observability",
    "tests/ledger-export.test.mjs",
    [
      /prepared agent email/iu,
      /manager decision/iu,
      /primary-retry/u,
      /vision-fallback/u,
      /formula protection/iu,
    ],
    "Observable events and safe export support evidence collection.",
  );
  await check(
    "role-honesty-regressions",
    "tests/model-role-honesty.test.mjs",
    [
      /uses the official DeepSeek Flash API for primary and reviewer/u,
      /uses DeepSeek V4 Flash in a separate review run/u,
      /keeps sales-agent web evidence direct, bounded, and purposeful/iu,
    ],
    "Model roles and source-opening contract have executable coverage.",
  );

  for (const relativePath of [
    "README.md",
    "docs/ARCHITECTURE-AND-WEBINAR.md",
    "docs/WEBINAR-RUNBOOK.md",
    ".opencode/agents/koler-sales.md",
    "scripts/agent-bridge.mjs",
  ]) {
    const text = await source(relativePath);
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
    results.push({
      id: `no-unsupported-flash-version-${relativePath}`,
      status: unsupportedDatedClaim ? "FAIL" : "PASS",
      file: relativePath,
      purpose: "Rolling alias is not presented as a claimed version.",
      missing: unsupportedDatedClaim ? ["active 0731 version claim"] : [],
    });
  }

  const failed = results.filter((result) => result.status === "FAIL");

  if (args.has("--json")) {
    console.log(
      JSON.stringify(
        {
          status: failed.length === 0 ? "PASS" : "FAIL",
          projectRoot,
          summary: {
            passed: results.length - failed.length,
            failed: failed.length,
            total: results.length,
          },
          checks: results,
        },
        null,
        2,
      ),
    );
  } else {
    for (const result of results) {
      console.log(`${result.status} ${result.id} — ${result.file}`);
      if (result.missing.length > 0) {
        console.log(`  Missing: ${result.missing.join(", ")}`);
      }
    }
    console.log(
      `\n${failed.length === 0 ? "PASS" : "FAIL"}: ${results.length - failed.length}/${results.length} eval readiness checks passed.`,
    );
  }

  if (failed.length > 0) process.exitCode = 1;
}
