#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const args = new Set(process.argv.slice(2));
const unknownArgs = [...args].filter(
  (argument) => !["--help", "--json"].includes(argument),
);

if (unknownArgs.length > 0) {
  process.stderr.write(`Unknown option: ${unknownArgs.join(", ")}\n`);
  process.exit(2);
}

if (args.has("--help")) {
  process.stdout.write(
    [
      "Usage: node .agents/skills/manage-koler-changes/scripts/check-change-contract.mjs [--json]",
      "",
      "Performs read-only static checks of the Koler cross-layer change contract.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const findings = [];

function record(level, id, message, location = "") {
  findings.push({ level, id, message, location });
}

async function source(path) {
  try {
    return await readFile(resolve(repoRoot, path), "utf8");
  } catch {
    record(
      "FAIL",
      "missing-file",
      `Required contract surface is unavailable: ${path}`,
      path,
    );
    return "";
  }
}

function lineOf(text, pattern) {
  const match = typeof pattern === "string" ? text.indexOf(pattern) : text.search(pattern);
  if (match < 0) return 1;
  return text.slice(0, match).split("\n").length;
}

function requirePattern(text, pattern, id, message, path) {
  if (pattern.test(text)) {
    record("PASS", id, message, `${path}:${lineOf(text, pattern)}`);
  } else {
    record("FAIL", id, `Missing: ${message}`, path);
  }
}

const paths = {
  engine: "lib/demo-engine.ts",
  guard: "lib/agent-guard.mjs",
  bridge: "scripts/agent-bridge.mjs",
  agentRoute: "app/api/agent/route.ts",
  orderRoute: "app/api/orders/route.ts",
  schema: "db/schema.ts",
  db: "db/index.ts",
  ledger: "lib/ledger-export.mjs",
  models: "data/models.json",
  provider: "opencode.json",
  salesProfile: ".opencode/agents/koler-sales.md",
  publicTool: ".opencode/tools/public_webfetch.js",
  publicFetch: "lib/public-web-fetch.mjs",
  scenario: "data/paint-demo.json",
  hosting: ".openai/hosting.json",
  package: "package.json",
};

const entries = await Promise.all(
  Object.entries(paths).map(async ([key, path]) => [key, await source(path)]),
);
const files = Object.fromEntries(entries);

requirePattern(
  files.engine,
  /export type AgentResult\s*=/u,
  "agent-result-type",
  "AgentResult has a canonical TypeScript surface",
  paths.engine,
);
requirePattern(
  files.guard,
  /export function isCompleteAgentResult/u,
  "complete-result",
  "Live results pass a completeness check",
  paths.guard,
);
requirePattern(
  files.guard,
  /export function normalizeAgentResult/u,
  "normalize-result",
  "Model output is normalized before persistence",
  paths.guard,
);
requirePattern(
  files.bridge,
  /const strongReviewer = "opencode-go\/deepseek-v4-pro"/u,
  "reviewer-role",
  "DeepSeek V4 Pro remains the separate reviewer",
  paths.bridge,
);
requirePattern(
  files.bridge,
  /const visionModel = "opencode-go\/mimo-v2\.5"/u,
  "vision-role",
  "MiMo remains the separate vision model",
  paths.bridge,
);
requirePattern(
  files.orderRoute,
  /canChangeOrder/u,
  "order-auth",
  "Order mutations retain owner/admin authorization",
  paths.orderRoute,
);
requirePattern(
  files.orderRoute,
  /action === "reserve"/u,
  "reserve-transition",
  "Reserve remains an explicit state transition",
  paths.orderRoute,
);
requirePattern(
  files.orderRoute,
  /action === "send"/u,
  "send-transition",
  "Send remains an explicit state transition",
  paths.orderRoute,
);
requirePattern(
  files.agentRoute,
  /eq\(orders\.status, "queued"\)/u,
  "atomic-claim-source",
  "Bridge claim is guarded by queued state",
  paths.agentRoute,
);
requirePattern(
  files.schema,
  /orderResultHistory/u,
  "history-schema",
  "Result history exists in the typed schema",
  paths.schema,
);
requirePattern(
  files.db,
  /PRAGMA table_info/u,
  "runtime-compat",
  "Runtime checks legacy D1 schema",
  paths.db,
);
requirePattern(
  files.ledger,
  /buildLedgerCsv/u,
  "ledger-export",
  "Observable history has a CSV projection",
  paths.ledger,
);
requirePattern(
  files.salesProfile,
  /webfetch:\s*deny[\s\S]{0,80}public_webfetch:\s*allow/u,
  "public-web-profile",
  "Sales profile denies builtin webfetch and allows only public_webfetch",
  paths.salesProfile,
);
requirePattern(
  files.publicTool,
  /fetchPublicWeb/u,
  "public-web-tool",
  "Custom public_webfetch is wired to the bounded transport",
  paths.publicTool,
);
requirePattern(
  files.publicFetch,
  /MAX_RESPONSE_BYTES[\s\S]{0,7000}export function validatePublicHttpsUrl[\s\S]{0,1600}url\.protocol !== "https:"[\s\S]{0,2600}export async function resolvePublicTarget[\s\S]{0,1800}addresses\.every\(isGlobalUnicastAddress\)[\s\S]{0,700}pinnedAddress: addresses\[0\][\s\S]{0,4000}lookup\(_hostname, options, callback\)[\s\S]{0,500}target\.pinnedAddress/u,
  "public-web-transport",
  "Public web transport validates HTTPS/DNS pinning and response bounds",
  paths.publicFetch,
);

try {
  const catalog = JSON.parse(files.models);
  const provider = JSON.parse(files.provider)?.provider?.deepseek;
  const ids = catalog.options?.map((item) => item.id) ?? [];
  const hasFlash = ids.includes("deepseek/deepseek-v4-flash");
  const primary = catalog.options?.find((item) => item.id === catalog.default);
  if (
    hasFlash &&
    ids.includes("opencode-go/deepseek-v4-pro") &&
    catalog.default === "deepseek/deepseek-v4-flash" &&
    primary?.variant === "max" &&
    provider?.api === "https://api.deepseek.com/v1" &&
    provider?.env?.includes("DEEPSEEK_API_KEY") &&
    provider?.models?.["deepseek-v4-flash"] &&
    !ids.some((id) => /gpt-5\.6|sol/iu.test(id))
  ) {
    record("PASS", "model-catalog", "Runtime uses direct DeepSeek Flash primary, separate Pro reviewer, and excludes Sol", paths.models);
  } else {
    record("FAIL", "model-catalog", "Runtime model catalog role boundary changed", paths.models);
  }
} catch {
  record("FAIL", "model-catalog-json", "data/models.json is not valid JSON", paths.models);
}

try {
  const scenario = JSON.parse(files.scenario);
  const product = scenario.products?.find((item) => item?.sku === "КР-001");
  const supplier = scenario.market?.find((item) => item?.competitor === "ПромКолор Опт");
  if (
    product?.stockKg === 300 &&
    supplier?.stockKg === 2_000 &&
    supplier?.pricePerKg === 361 &&
    supplier?.deliveryDays === 4
  ) {
    record("PASS", "main-shortage-seed", "Catalog contains the active 2 000/300 shortage seed", paths.scenario);
  } else {
    record("FAIL", "main-shortage-seed", "Catalog does not contain the active shortage seed", paths.scenario);
  }
} catch {
  record("FAIL", "main-shortage-json", "data/paint-demo.json is not valid JSON", paths.scenario);
}

try {
  const hosting = JSON.parse(files.hosting);
  if (hosting.d1 === "DB" && hosting.r2 === "UPLOADS") {
    record("PASS", "hosting-bindings", "Hosting binds DB and UPLOADS", paths.hosting);
  } else {
    record("FAIL", "hosting-bindings", "Expected DB/UPLOADS hosting bindings are missing", paths.hosting);
  }
} catch {
  record("FAIL", "hosting-json", ".openai/hosting.json is not valid JSON", paths.hosting);
}

try {
  const packageJson = JSON.parse(files.package);
  for (const script of ["lint", "typecheck", "test", "build"]) {
    if (!packageJson.scripts?.[script]) {
      record("FAIL", `package-${script}`, `Required package script is missing: ${script}`, paths.package);
    }
  }
  if (["lint", "typecheck", "test", "build"].every((script) => packageJson.scripts?.[script])) {
    record("PASS", "package-gate", "Full local verification gate is available", paths.package);
  }
} catch {
  record("FAIL", "package-json", "package.json is not valid JSON", paths.package);
}

const leaseMatch = files.agentRoute.match(/JOB_LEASE_SECONDS\s*=\s*(\d+)/u);
const timeoutValues = [...files.bridge.matchAll(/const (?:openCodeTimeoutMs|primaryOpenCodeTimeoutMs|reviewerOpenCodeTimeoutMs|modelChainDeadlineMs) = ([\d_]+);/gu)]
  .map((match) => Number(match[1].replaceAll("_", "")));
if (leaseMatch && timeoutValues.length >= 2) {
  const leaseMs = Number(leaseMatch[1]) * 1_000;
  const chainMs = Math.max(...timeoutValues);
  if (chainMs <= leaseMs) {
    record(
      "WARN",
      "bridge-lease-budget",
      `Model chain exceeds the ${leaseMatch[1]} second processing lease; renewal must remain active`,
      `${paths.agentRoute}:${lineOf(files.agentRoute, leaseMatch[0])}`,
    );
  } else {
    record("PASS", "bridge-lease-budget", "Processing lease is renewed while the 700 second model chain runs", paths.agentRoute);
  }
}

const orderPatchIndex = files.orderRoute.indexOf("export async function PATCH");
const orderPatchBody = orderPatchIndex >= 0 ? files.orderRoute.slice(orderPatchIndex) : "";
const jsonIndex = orderPatchBody.indexOf("request.json()");
const lengthIndex = orderPatchBody.indexOf("content-length");
if (jsonIndex >= 0 && (lengthIndex < 0 || lengthIndex > jsonIndex)) {
  record(
    "WARN",
    "orders-patch-body-bound",
    "PATCH /api/orders has no visible early content-length bound; run executable oversized/chunked tests when this route changes",
    `${paths.orderRoute}:${lineOf(files.orderRoute, "export async function PATCH")}`,
  );
}

const failures = findings.filter((item) => item.level === "FAIL");
const warnings = findings.filter((item) => item.level === "WARN");
const summary = {
  verdict: failures.length ? "BLOCK" : warnings.length ? "PASS WITH WARNINGS" : "PASS",
  pass: findings.filter((item) => item.level === "PASS").length,
  warnings: warnings.length,
  failures: failures.length,
  findings,
};

if (args.has("--json")) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  process.stdout.write(`${summary.verdict}\n`);
  for (const item of findings) {
    process.stdout.write(
      `[${item.level}] ${item.id}: ${item.message}${item.location ? ` (${item.location})` : ""}\n`,
    );
  }
}

process.exitCode = failures.length ? 1 : 0;
