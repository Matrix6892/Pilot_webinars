import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyReviewerResult,
  askCoverageGaps,
  isCompleteAgentResult,
  managerFallbackAgentResult,
  normalizeV2AgentResult,
  reviewerAllowedPathPrefixes,
  reviewerDecisionValidationErrors,
  validateReviewerDecisionV2,
} from "../lib/agent-guard.mjs";
import {
  normalizeVisionObservation,
  resolveVisionImageUrl,
  visionPromptBlock,
} from "../lib/upload-guard.mjs";
import {
  downloadVisionImage,
  IMAGE_DOWNLOAD_TIMEOUT_MS,
} from "../lib/upload-vision.mjs";
import { isSearchResultUrl } from "../lib/public-web-url.mjs";

const root = resolve(import.meta.dirname, "..");

async function loadLocalEnv() {
  try {
    const raw = await readFile(resolve(root, ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } catch {
    // ponytail: the launcher may supply the same values.
  }
}

await loadLocalEnv();

const standUrl = (process.env.STAND_URL ?? "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const bridgeToken = process.env.BRIDGE_TOKEN?.trim();
if (!bridgeToken) {
  throw new Error("BRIDGE_TOKEN is required in .env.local");
}
const demoData = JSON.parse(
  await readFile(resolve(root, "data/paint-demo.json"), "utf8"),
);
const modelCatalog = JSON.parse(
  await readFile(resolve(root, "data/models.json"), "utf8"),
);
const salesInstruction = await readFile(
  resolve(root, "public/prompts/sales-agent.md"),
  "utf8",
);
const reviewerInstruction = await readFile(
  resolve(root, "public/prompts/reviewer.md"),
  "utf8",
);
const visionInstruction = await readFile(
  resolve(root, "public/prompts/vision-agent.md"),
  "utf8",
);
const allowedPrimaryModels = new Set(
  modelCatalog.options
    .filter((model) => model.roles?.includes("primary"))
    .map((model) => model.id),
);
const modelOption = (id) =>
  modelCatalog.options.find((model) => model.id === id);
const modelLabel = (id) =>
  modelOption(id)?.label ?? id;
const modelVariant = (id) => modelOption(id)?.variant;
const requestedPrimary =
  process.env.OPENCODE_PRIMARY_MODEL ?? modelCatalog.default;
const fallbackPrimary = allowedPrimaryModels.has(requestedPrimary)
  ? requestedPrimary
  : modelCatalog.default;
const strongReviewer = "deepseek/deepseek-v4-flash";
const visionModel = "opencode-go/mimo-v2.5";
const bridgeWorkerId = `bridge-${crypto.randomUUID()}`;
const agentApiTimeoutMs = 12_000;
const openCodeTimeoutMs = 300_000;
const visionOpenCodeTimeoutMs = 180_000;
const primaryOpenCodeTimeoutMs = 600_000;
const reviewerOpenCodeTimeoutMs = 300_000;
const jobDeadlineMs = 650_000;
const openCodeTerminationGraceMs = 5_000;
const terminalPublicationReserveMs = agentApiTimeoutMs;
const MAX_OPENED_SOURCE_EXCERPT_CHARS = 12_000;
const leaseRenewalMs = 30_000;

function bridgeConcurrencyFrom(value) {
  const candidate = String(value ?? "1").trim();
  if (!/^\d+$/u.test(candidate)) {
    throw new Error("BRIDGE_CONCURRENCY must be an integer from 1 to 10");
  }
  const concurrency = Number(candidate);
  if (concurrency < 1 || concurrency > 10) {
    throw new Error("BRIDGE_CONCURRENCY must be an integer from 1 to 10");
  }
  return concurrency;
}

const bridgeConcurrency = bridgeConcurrencyFrom(
  process.env.BRIDGE_CONCURRENCY,
);

let stopped = false;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function selectedModel(job) {
  return allowedPrimaryModels.has(job.requestedModel)
    ? job.requestedModel
    : fallbackPrimary;
}

function reviewerFor() {
  return strongReviewer;
}

function demoDataForJob(job) {
  if (typeof job?.inventorySnapshotJson !== "string") return demoData;

  try {
    const snapshot = JSON.parse(job.inventorySnapshotJson);
    const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
    const stockBySku = new Map(
      items
        .filter(
          (item) =>
            typeof item?.sku === "string" &&
            Number.isFinite(Number(item?.stockKg)),
        )
        .map((item) => [
          item.sku,
          {
            stockKg: Math.max(0, Number(item.stockKg)),
            stockRevision: Number.isFinite(Number(item?.revision)) &&
              Number(item.revision) > 0
                ? Number(item.revision)
                : undefined,
            stockUpdatedAt: typeof item?.updatedAt === "string"
              ? item.updatedAt
              : undefined,
          },
        ]),
    );

    return {
      ...demoData,
      market: Array.isArray(snapshot?.market)
        ? snapshot.market
        : demoData.market,
      products: demoData.products.map((product) => {
        const liveStock = stockBySku.get(product.sku);
        return {
          ...product,
          stockKg: liveStock?.stockKg ?? product.stockKg,
          stockRevision:
            liveStock?.stockRevision ?? product.stockRevision,
          stockUpdatedAt:
            liveStock?.stockUpdatedAt ?? product.stockUpdatedAt,
        };
      }),
      inventorySnapshot: {
        version:
          typeof snapshot?.version === "string" ||
          typeof snapshot?.version === "number"
            ? String(snapshot.version)
            : "текущая",
        capturedAt:
          typeof snapshot?.capturedAt === "string"
            ? snapshot.capturedAt
            : "",
      },
    };
  } catch {
    return demoData;
  }
}

function storedJobJson(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function promptText(value, max) {
  return typeof value === "string"
    ? value.replace(/\s+/gu, " ").trim().slice(0, max)
    : "";
}

function promptJson(value) {
  // ponytail: pretty JSON prevents OpenCode from truncating one giant line.
  return JSON.stringify(value, null, 2);
}

function promptStringList(value, limit, max) {
  return Array.isArray(value)
    ? value
        .map((item) => promptText(item, max))
        .filter(Boolean)
        .slice(0, limit)
    : [];
}

function promptHttpUrl(value) {
  const url = canonicalHttpUrl(value);
  return url && !isSearchResultUrl(url) ? url : "";
}

function promptAttachment(job) {
  const value = storedJobJson(job?.attachmentJson, null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const name = promptText(value.name, 160);
  const src = promptText(value.src, 240);
  const alt = promptText(value.alt, 240);
  return name && src && alt ? { name, src, alt } : null;
}

function promptConversation(job) {
  const value = storedJobJson(job?.conversationJson, []);
  if (!Array.isArray(value)) return [];
  return value
    .map((message) => {
      if (
        !message ||
        typeof message !== "object" ||
        !["agent", "customer"].includes(message.role)
      ) {
        return null;
      }
      const body = promptText(message.body, 2_000);
      if (!body) return null;
      return {
        role: message.role,
        body,
        createdAt: promptText(message.createdAt, 80),
      };
    })
    .filter(Boolean)
    .slice(-20);
}

function reviewerOrderView(job) {
  return {
    company: promptText(job?.company, 200),
    website: promptText(job?.website, 240),
    subject: promptText(job?.subject, 300),
    body: promptText(job?.body, 6_000),
    attachment: promptAttachment(job),
    conversation: promptConversation(job),
    round: Math.max(1, Number(job?.roundNo) || 1),
  };
}

function promptEvidenceSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (value.kind === "message") {
    const quote = promptText(value.quote, 420);
    const roundNo = Number(value.roundNo);
    return quote && Number.isSafeInteger(roundNo) && roundNo > 0
      ? { kind: "message", roundNo, quote }
      : null;
  }
  if (value.kind === "vision") {
    const attachmentRef = promptText(value.attachmentRef, 240);
    const observation = promptText(value.observation, 320);
    return attachmentRef && observation
      ? { kind: "vision", attachmentRef, observation }
      : null;
  }
  if (value.kind === "web") {
    const url = promptHttpUrl(value.url);
    const title = promptText(value.title, 200);
    const openedAt = promptText(value.openedAt, 80);
    const excerpt = promptText(value.excerpt, 12_000);
    const sha256 = /^[a-f0-9]{64}$/u.test(String(value.sha256 ?? ""))
      ? String(value.sha256)
      : "";
    return url && title && openedAt
      ? {
          kind: "web",
          url,
          title,
          openedAt,
          ...(excerpt
            ? {
                excerptLength: excerpt.length,
                excerptSha256:
                  sha256 || createHash("sha256").update(excerpt).digest("hex"),
                guardGrounded: Boolean(
                  sha256 &&
                    createHash("sha256").update(excerpt).digest("hex") === sha256,
                ),
              }
            : {}),
        }
      : null;
  }
  if (
    value.kind === "snapshot" &&
    ["catalog", "inventory", "supplier"].includes(value.dataset)
  ) {
    const key = promptText(value.key, 140);
    const version = promptText(value.version, 100);
    const checkedAt = promptText(value.checkedAt, 80);
    return key && version && checkedAt
      ? {
          kind: "snapshot",
          dataset: value.dataset,
          key,
          version,
          checkedAt,
        }
      : null;
  }
  return null;
}

function promptResolvedIntent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const evidence = Array.isArray(value.evidence)
    ? value.evidence
        .map((item) => {
          const source = promptEvidenceSource(item?.source);
          const id = promptText(item?.id, 100);
          const claim = promptText(item?.claim, 360);
          const confidence = Number(item?.confidence);
          return id &&
            claim &&
            Number.isFinite(confidence) &&
            confidence >= 0 &&
            confidence <= 1 &&
            source
            ? { id, claim, confidence, source }
            : null;
        })
        .filter(Boolean)
        .slice(0, 16)
    : [];
  const assumptions = Array.isArray(value.assumptions)
    ? value.assumptions
        .map((item) => {
          const id = promptText(item?.id, 100);
          const claim = promptText(item?.claim, 360);
          const confidence = Number(item?.confidence);
          const confirmBefore = [
            "never",
            "commercial_offer",
            "reserve",
            "production",
          ].includes(item?.confirmBefore)
            ? item.confirmBefore
            : "";
          if (
            !id ||
            !claim ||
            !Number.isFinite(confidence) ||
            confidence < 0 ||
            confidence > 1 ||
            !confirmBefore
          ) {
            return null;
          }
          const basedOnEvidenceIds = promptStringList(
            item.basedOnEvidenceIds,
            12,
            100,
          );
          const min = Number(item.range?.min);
          const max = Number(item.range?.max);
          const unit = promptText(item.range?.unit, 24);
          return {
            id,
            claim,
            basedOnEvidenceIds,
            confidence,
            ...(Number.isFinite(min) &&
            Number.isFinite(max) &&
            max >= min &&
            unit
              ? { range: { min, max, unit } }
              : {}),
            confirmBefore,
          };
        })
        .filter(Boolean)
        .slice(0, 12)
    : [];
  let asks = Array.isArray(value.asks)
    ? value.asks
        .map((item) => {
          const id = promptText(item?.id, 64);
          const request = promptText(item?.request, 240);
          const evidenceIds = promptStringList(item?.evidenceIds, 4, 100);
          return /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(id) &&
            request &&
            evidenceIds.length
            ? { id, request, evidenceIds }
            : null;
        })
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const target =
    value.target?.state === "resolved"
      ? {
          state: "resolved",
          label: promptText(value.target.label, 160),
          evidenceIds: promptStringList(
            value.target.evidenceIds,
            12,
            100,
          ),
        }
      : value.target?.state === "ambiguous"
        ? {
            state: "ambiguous",
            candidates: Array.isArray(value.target.candidates)
              ? value.target.candidates
                  .map((candidate) => {
                    const label = promptText(candidate?.label, 160);
                    const confidence = Number(candidate?.confidence);
                    return label &&
                      Number.isFinite(confidence) &&
                      confidence >= 0 &&
                      confidence <= 1
                      ? {
                          label,
                          confidence,
                          evidenceIds: promptStringList(
                            candidate.evidenceIds,
                            12,
                            100,
                          ),
                        }
                      : null;
                  })
                  .filter(Boolean)
                  .slice(0, 6)
              : [],
          }
        : null;
  const blocker =
    value.blocker?.kind === "target_ambiguity"
      ? {
          kind: "target_ambiguity",
          question: promptText(value.blocker.question, 320),
          choices: promptStringList(value.blocker.choices, 6, 120),
        }
      : null;
  const goal = promptText(value.goal, 320);
  if (!asks.length && goal && evidence.some((item) => item.source.kind === "message")) {
    const messageEvidence = evidence.find((item) => item.source.kind === "message");
    asks = [
      {
        id: "legacy-request",
        request: goal.slice(0, 240),
        evidenceIds: [messageEvidence.id],
      },
    ];
  }
  return goal && target && evidence.length
    ? { goal, asks, target, evidence, assumptions, blocker }
    : null;
}

function reviewerResultView(result) {
  const supplierPlan = result?.supplierPlan
    ? {
        supplierName: result.supplierPlan.supplierName,
        ourKg: result.supplierPlan.ourKg,
        supplierKg: result.supplierPlan.supplierKg,
        ourPricePerKg: result.supplierPlan.ourPricePerKg,
        supplierPricePerKg: result.supplierPlan.supplierPricePerKg,
        total: result.supplierPlan.total,
        deliveryDays: result.supplierPlan.deliveryDays,
        supplierStockKg: result.supplierPlan.supplierStockKg,
        stockCheckedAt: result.supplierPlan.stockCheckedAt,
        source: {
          kind: "snapshot",
          dataset: "supplier",
          key: result.supplierPlan.supplierName,
          checkedAt: result.supplierPlan.stockCheckedAt,
        },
      }
    : undefined;
  return {
    schemaVersion: result?.schemaVersion,
    zone: result?.zone,
    route: result?.route,
    commitment: result?.commitment,
    confidence: result?.confidence,
    resolvedIntent: promptResolvedIntent(result?.resolvedIntent),
    estimates: result?.estimates,
    supplierLeads: Array.isArray(result?.supplierLeads)
      ? result.supplierLeads.map((lead) => ({
          supplier: lead.supplier,
          url: lead.url,
          openedAt: lead.openedAt,
          observedClaims: lead.observedClaims,
          confirmationNeeded: lead.confirmationNeeded,
        }))
      : [],
    product: result?.product,
    supplierPlan,
    options: Array.isArray(result?.options)
      ? result.options.map((option) => ({
          id: option.id,
          title: promptText(option.title, 160),
          rationale: promptText(option.rationale, 260),
          tradeoff: promptText(option.tradeoff, 260),
          reply: promptText(option.reply, 260),
          followUpActor: option.followUpActor,
        }))
      : [],
    reply: result?.reply,
  };
}

function promptResearch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const sources = Array.isArray(value.sources)
    ? value.sources
        .map((source) => {
          const title = promptText(source?.title, 200);
          const url = promptHttpUrl(source?.url);
          const checkedAt = promptText(source?.checkedAt, 80);
          const fact = promptText(source?.fact, 360);
          return title && url && checkedAt && fact
            ? { title, url, checkedAt, fact }
            : null;
        })
        .filter(Boolean)
        .slice(0, 3)
    : [];
  if (!sources.length) return null;
  return {
    checked: value.checked === true,
    summary: promptText(value.summary, 700),
    sources,
  };
}

function continuationContextForJob(job) {
  const previousResult = storedJobJson(job?.resultJson, null);
  const conversation = promptConversation(job);
  const latestCustomerReply = [...conversation]
    .reverse()
    .find((message) => message.role === "customer");
  const currentRound = Number(job?.roundNo);
  const priorMessageRound = Math.max(
    1,
    ...(Array.isArray(previousResult?.resolvedIntent?.evidence)
      ? previousResult.resolvedIntent.evidence
          .filter((item) => item?.source?.kind === "message")
          .map((item) => Number(item.source.roundNo))
          .filter((roundNo) => Number.isSafeInteger(roundNo) && roundNo > 0)
      : []),
  );
  if (
    !Number.isSafeInteger(currentRound) ||
    currentRound <= priorMessageRound ||
    previousResult?.schemaVersion !== 2 ||
    previousResult?.resolvedIntent?.blocker?.kind !==
      "target_ambiguity" ||
    !latestCustomerReply
  ) {
    return null;
  }

  const resolvedIntent = promptResolvedIntent(
    previousResult.resolvedIntent,
  );
  if (!resolvedIntent) return null;
  const culturalResearch = promptResearch(previousResult.research);
  const visionObservation =
    normalizeVisionObservation(previousResult.visionObservation) ?? null;
  const openedSources = (Array.isArray(previousResult.resolvedIntent?.evidence)
    ? previousResult.resolvedIntent.evidence
    : [])
    .map((item) => item?.source)
    .filter(
      (source) =>
        source?.kind === "web" &&
        source.excerpt &&
        /^[a-f0-9]{64}$/u.test(source.sha256 ?? ""),
    )
    .map(({ url, openedAt, excerpt, sha256 }) => ({
      url,
      openedAt,
      excerpt,
      sha256,
    }));
  const openedSourceUrls = [
    ...resolvedIntent.evidence
      .filter((item) => item.source.kind === "web")
      .map((item) => item.source.url),
    ...(culturalResearch?.sources.map((source) => source.url) ?? []),
  ].filter(Boolean);

  return {
    previousRound: currentRound - 1,
    latestCustomerReply,
    resolvedIntent,
    visionObservation,
    culturalResearch,
    openedSourceUrls: [...new Set(openedSourceUrls)],
    openedSources,
  };
}

function childEnvironment(model) {
  const names = [
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "NO_COLOR",
    "OPENCODE_API_KEY",
    "OPENCODE_ENABLE_EXA",
    "OPENCODE_GO_API_KEY",
    "OPENAI_API_KEY",
    "PATH",
    "SHELL",
    "TERM",
    "TMPDIR",
    "USER",
    "XDG_CONFIG_HOME",
  ];
  if (String(model).startsWith("deepseek/")) {
    names.push("DEEPSEEK_API_KEY");
  }
  return Object.fromEntries(
    names
      .filter((name) => typeof process.env[name] === "string")
      .map((name) => [name, process.env[name]]),
  );
}

async function agentRequest(
  payload,
  method = "POST",
  timeoutMs = agentApiTimeoutMs,
  workerId = bridgeWorkerId,
) {
  const response = await fetch(`${standUrl}/api/agent`, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      "content-type": "application/json",
      "x-bridge-worker-id": workerId,
    },
    ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
  });
  if (!response.ok) {
    throw new Error(`Agent API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function isRetryableAgentRequestError(error) {
  return /fetch failed|aborted due to timeout|Agent API (?:408|425|429|5\d\d):/iu.test(
    String(error instanceof Error ? error.message : error ?? ""),
  );
}

async function agentRequestWithRetry(
  payload,
  method = "POST",
  totalTimeoutMs = agentApiTimeoutMs,
  maxAttempts = 3,
) {
  const startedAtMs = performance.now();
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingMs = Math.floor(
      totalTimeoutMs - (performance.now() - startedAtMs),
    );
    if (remainingMs <= 0) break;
    try {
      return await agentRequest(payload, method, remainingMs);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryableAgentRequestError(error)) {
        throw error;
      }
      const delayMs = Math.min(
        attempt * 200,
        Math.max(0, remainingMs - 1),
      );
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw lastError ?? new Error("Agent API retry budget exhausted");
}

function claimPayload(job) {
  return {
    orderId: job.id,
    roundNo: Number(job.roundNo),
    claimId: job.claimId,
  };
}

function openedSourceUrlsFromTools(tools) {
  return [
    ...new Set(
      (Array.isArray(tools) ? tools : [])
        .filter(
          (tool) =>
            tool?.tool === "public_webfetch" &&
            tool.completed === true &&
            tool.failed !== true,
        )
        .flatMap((tool) =>
          Array.isArray(tool.urls)
            ? tool.urls.filter((url) => typeof url === "string")
            : [],
        ),
    ),
  ];
}

function openedSourcesFromTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => tool?.tool === "public_webfetch" && tool.completed === true && tool.failed !== true)
    .flatMap((tool) => (Array.isArray(tool.urls) ? tool.urls : []).map((url) => ({
      url,
      openedAt: tool.openedAt,
      excerpt: typeof tool.excerpt === "string" ? tool.excerpt.slice(0, MAX_OPENED_SOURCE_EXCERPT_CHARS) : "",
      sha256: typeof tool.sha256 === "string" ? tool.sha256 : "",
    })))
    .filter((source) => source.url && source.openedAt && source.excerpt && /^[a-f0-9]{64}$/u.test(source.sha256))
    .slice(0, 20);
}

function resultPayload(
  job,
  result,
  openedSourceUrls,
  agentModel,
  reviewerModel,
  reviewerProvenance,
  openedSources,
) {
  return {
    action: "result",
    ...claimPayload(job),
    result,
    openedSourceUrls: [
      ...new Set(
        Array.isArray(openedSourceUrls)
          ? openedSourceUrls.filter((url) => typeof url === "string")
          : [],
      ),
    ],
    ...(Array.isArray(openedSources) && openedSources.some((source) => source?.excerpt && source?.sha256)
      ? { openedSources: openedSources.filter((source) => source?.excerpt && source?.sha256).slice(0, 20) }
      : {}),
    agentModel,
    reviewerModel,
    reviewerProvenance,
  };
}

function addEvent(job, stage, title, detail, state = "done") {
  let publication;
  try {
    publication = agentRequest({
      action: "event",
      ...claimPayload(job),
      stage,
      title,
      detail,
      state,
    });
  } catch {
    telemetryWarning(`event publication failed: ${stage}`);
    return Promise.resolve(false);
  }
  return publication.then(
    () => true,
    () => {
      telemetryWarning(`event publication failed: ${stage}`);
      return false;
    },
  );
}

async function addConfirmedEvent(job, stage, title, detail, state = "done") {
  await agentRequest({
    action: "event",
    ...claimPayload(job),
    stage,
    title,
    detail,
    state,
  });
}

function startLeaseRenewal(job) {
  const timer = setInterval(() => {
    agentRequest({ action: "renew", ...claimPayload(job) }).catch((error) => {
      console.error(`[bridge] lease ${job.id}:`, error.message);
    });
  }, leaseRenewalMs);
  return () => clearInterval(timer);
}

function extractJson(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return parseJsonOrCompleteDraft(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("Model returned no JSON object");
    }
    return parseJsonOrCompleteDraft(cleaned.slice(start, end + 1));
  }
}

function parseJsonOrCompleteDraft(source) {
  try {
    return JSON.parse(source);
  } catch (error) {
    const repaired = completeCompactDraftAtEof(source);
    if (repaired) return repaired;
    throw error;
  }
}

function completeCompactDraftAtEof(source) {
  // ponytail: only close a finished v2 object; every other malformed result retries.
  for (const suffix of ["}", "}}"]) {
    let draft;
    try {
      draft = JSON.parse(`${source}${suffix}`);
    } catch {
      continue;
    }
    const intent = draft?.resolvedIntent;
    if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
      continue;
    }
    for (const key of [
      "commitment",
      "reply",
      "estimates",
      "product",
      "supplierLeads",
      "route",
      "options",
    ]) {
      if (draft[key] === undefined && intent[key] !== undefined) {
        draft[key] = intent[key];
        delete intent[key];
      }
    }
    if (
      draft.schemaVersion === 2 &&
      typeof draft.commitment === "string" &&
      typeof draft.reply?.subject === "string" &&
      typeof draft.reply?.body === "string" &&
      typeof intent.goal === "string" &&
      intent.target &&
      Array.isArray(intent.evidence) &&
      Array.isArray(intent.assumptions)
    ) {
      return draft;
    }
  }
  return null;
}

function telemetryWarning(scope) {
  globalThis.console?.warn?.(`[bridge] ${scope}`);
}

function safeJobErrorDetail(error) {
  const message = String(error instanceof Error ? error.message : error ?? "");
  if (/timed out|deadline exhausted/iu.test(message)) {
    return "Истёк общий лимит времени обработки. Письмо и журнал сохранены; этот же заказ можно запустить снова.";
  }
  if (/explicit request part|invalid result|schemaVersion|contract|JSON/iu.test(message)) {
    return "Ответ модели не прошёл проверку полноты и не был показан клиенту. Письмо и журнал сохранены; заказ можно повторить.";
  }
  if (/fetch failed|network|Agent API|ECONN|socket/iu.test(message)) {
    return "Не удалось подтвердить следующий этап через API. Письмо и журнал сохранены; этот же заказ можно запустить снова.";
  }
  return "Запуск остановился до подтверждённого результата. Письмо и журнал сохранены; этот же заказ можно запустить снова.";
}

function partialRunResult(partialRun) {
  const text = Array.isArray(partialRun?.textParts)
    ? partialRun.textParts
        .filter((part) => typeof part === "string")
        .join("\n")
    : "";
  return {
    value: extractJson(text),
    tools: Array.isArray(partialRun?.tools) ? partialRun.tools : [],
  };
}

function toolSummaryKey(tool) {
  return JSON.stringify([
    tool?.tool,
    Array.isArray(tool?.urls) ? tool.urls : [],
    tool?.openedAt,
    tool?.completed,
    tool?.failed,
    tool?.detail,
  ]);
}

function mergeToolSummaries(...runs) {
  const seen = new Set();
  return runs
    .flatMap((run) => (Array.isArray(run?.tools) ? run.tools : []))
    .filter((tool) => {
      const key = toolSummaryKey(tool);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

function mergePartialRuns(...runs) {
  return {
    textParts: runs.flatMap((run) =>
      Array.isArray(run?.textParts) ? run.textParts : [],
    ),
    tools: mergeToolSummaries(...runs),
  };
}

function safeManagerOptions(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
    return false;
  }
  const ids = new Set();
  return value.every((option) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      return false;
    }
    const fields = [
      option.id,
      option.title,
      option.rationale,
      option.tradeoff,
      option.reply,
    ];
    if (
      fields.some((field) => typeof field !== "string" || !field.trim()) ||
      !["supplier", "internal", "none"].includes(option.followUpActor) ||
      ids.has(option.id)
    ) {
      return false;
    }
    ids.add(option.id);
    return true;
  });
}

function isCompleteFailClosedManager(result) {
  return Boolean(
    isCompleteAgentResult(result) &&
      result?.schemaVersion === 2 &&
      result.zone === "red" &&
      result.decision === "escalate" &&
      result.route === "manager" &&
      result.commitment === "none" &&
      result.product === null &&
      Array.isArray(result.estimates) &&
      result.estimates.length === 0 &&
      result.resolvedIntent?.blocker === null &&
      safeManagerOptions(result.options),
  );
}

function isOpenCodeTimeout(error) {
  return /OpenCode timed out/iu.test(
    String(error instanceof Error ? error.message : error ?? ""),
  );
}

function hasReusablePrimaryResearch(error) {
  return (error?.partialRun?.tools ?? []).some(
    (tool) => Array.isArray(tool?.urls) && tool.urls.length > 0,
  );
}

function hasRetryablePrimaryTransportFailure(error) {
  const partialRun = error?.partialRun;
  return error?.completedMalformed === true || (
    Boolean(partialRun) &&
    (partialRun.textParts ?? []).length === 0 &&
    (partialRun.tools ?? []).length === 0 &&
    /OpenCode exited with \d+/iu.test(String(error?.message ?? ""))
  );
}

function stageTimeoutForDeadline(
  jobStartedAtMs,
  nowMs,
  capMs,
  deadlineMs,
  reservedMs,
  terminationGraceMs,
) {
  const elapsedMs = Math.max(0, nowMs - jobStartedAtMs);
  return Math.max(
    0,
    Math.min(
      capMs,
      Math.floor(
        deadlineMs - elapsedMs - reservedMs - terminationGraceMs,
      ),
    ),
  );
}

function isJobDeadlineExceeded(error) {
  return /job deadline exhausted/iu.test(
    String(error instanceof Error ? error.message : error ?? ""),
  );
}

async function runPrimaryWithRetry({ run, retry = run, onRetry }) {
  try {
    return await run();
  } catch (error) {
    const partialRun = error?.partialRun;
    if (partialRun) {
      try {
        return partialRunResult(partialRun);
      } catch {
        // A complete JSON result was not observable before classification.
      }
    }
    if (isJobDeadlineExceeded(error)) {
      throw error;
    }
    if (
      !isOpenCodeTimeout(error) &&
      !hasReusablePrimaryResearch(error) &&
      !hasRetryablePrimaryTransportFailure(error)
    ) {
      throw error;
    }
    const primaryPartialRun = partialRun ?? { textParts: [], tools: [] };
    try {
      if (typeof onRetry === "function") {
        void Promise.resolve(onRetry(primaryPartialRun)).catch(() => {
          telemetryWarning("retry event publication failed");
        });
      }
    } catch {
      telemetryWarning("retry event publication failed");
    }
    try {
      const completed = await retry(primaryPartialRun);
      return {
        ...completed,
        tools: mergeToolSummaries(primaryPartialRun, completed),
      };
    } catch (retryError) {
      const retryPartial = retryError?.partialRun ?? {
        textParts: [],
        tools: [],
      };
      const mergedPartialRun = mergePartialRuns(
        primaryPartialRun,
        retryPartial,
      );
      try {
        return partialRunResult(mergedPartialRun);
      } catch {
        // Only a complete JSON document may cross the model boundary.
      }
      const surfacedError =
        retryError instanceof Error
          ? retryError
          : new Error(String(retryError ?? "Primary retry failed"));
      surfacedError.partialRun = mergedPartialRun;
      throw surfacedError;
    }
  }
}

function isPrivateIpAddress(value) {
  const address = String(value ?? "")
    .replace(/^\[|\]$/gu, "")
    .toLocaleLowerCase();
  const version = isIP(address);
  if (version === 4) {
    const [first, second, third, fourth] = address.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0 && (third === 0 || third === 2)) ||
      (first === 198 && second >= 18 && second <= 19) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 240 ||
      (first === 255 && second === 255 && third === 255 && fourth === 255)
    );
  }
  if (version !== 6) return false;
  if (address.startsWith("::ffff:")) {
    return isPrivateIpAddress(address.slice("::ffff:".length));
  }
  return (
    address === "::" ||
    address === "::1" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    address.startsWith("fe8") ||
    address.startsWith("fe9") ||
    address.startsWith("fea") ||
    address.startsWith("feb")
  );
}

function isPrivateHost(value) {
  const hostname = String(value ?? "")
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLocaleLowerCase();
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "local" ||
    hostname.endsWith(".local") ||
    hostname === "internal" ||
    hostname.endsWith(".internal") ||
    isPrivateIpAddress(hostname)
  );
}

function canonicalHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      isPrivateHost(url.hostname)
    ) {
      return "";
    }
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function completedToolOpenedAt(state) {
  const raw = state?.time?.end;
  const numeric = Number(raw);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric)
    : new Date(String(raw ?? ""));
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function structuredToolOutput(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function toolSummary(event) {
  const tool = String(event.part?.tool ?? "web");
  const state = event.part?.state ?? {};
  const input = state.input ?? {};
  const output = structuredToolOutput(state.output);
  const inputUrls = [
    input.url,
    input.href,
    ...(Array.isArray(input.urls) ? input.urls : []),
  ];
  const outputUrls = [
    output.url,
    output.finalUrl,
    output.redirectedUrl,
  ];
  const rawUrls = outputUrls.some(Boolean) ? outputUrls : inputUrls;
  const observedUrls = [
    ...new Set(rawUrls.map(canonicalHttpUrl).filter(Boolean)),
  ];
  const status = String(state.status ?? "").trim().toLocaleLowerCase();
  const completed = status === "completed";
  const failed = /^(?:error|failed)$/iu.test(status);
  const evidenceTool = tool === "public_webfetch";
  const legacyWebTool = tool === "webfetch";
  const urls =
    evidenceTool && completed
      ? observedUrls.filter((url) => !isSearchResultUrl(url))
      : [];
  const openedAt = urls.length ? completedToolOpenedAt(state) : "";
  const discoveryOnly =
    observedUrls.length > 0 && observedUrls.every(isSearchResultUrl);
  const query =
    typeof input.query === "string" && input.query.trim()
      ? input.query.trim()
      : "";
  const isWebAction =
    observedUrls.length > 0 ||
    query ||
    /(?:web|search|fetch|browse|http)/iu.test(tool);
  if (!isWebAction) return null;

  let host = "";
  try {
    host = observedUrls[0] ? new URL(observedUrls[0]).hostname : "";
  } catch {
    host = "";
  }
  const evidenceText = typeof output.text === "string"
    ? output.text
        .replace(
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/gu,
          " ",
        )
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 12_000)
    : "";
  const sha256 = evidenceText
    ? createHash("sha256").update(evidenceText, "utf8").digest("hex")
    : "";
  return {
    tool,
    urls,
    openedAt,
    excerpt: urls.length && completed && !failed ? evidenceText : "",
    sha256: urls.length && completed && !failed ? sha256 : "",
    completed,
    failed,
    detail: failed && host
      ? `Страница пока недоступна: ${host}`
      : legacyWebTool
        ? "Устаревший webfetch: URL не используется как evidence"
      : discoveryOnly
        ? "Выполнен поиск по открытым источникам"
      : !completed && host
        ? `Открывается страница: ${host}`
        : host
        ? `Открыта страница: ${host}`
      : "Выполнен поиск по открытым источникам",
  };
}

function toolEventKey(event, summary) {
  const callId =
    event.part?.callID ?? event.part?.callId ?? event.part?.id ?? "";
  const input = event.part?.state?.input ?? {};
  const inputKey = [
    input.url,
    input.href,
    ...(Array.isArray(input.urls) ? input.urls : []),
    input.query,
  ]
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  return callId
    ? `${summary.tool}:${String(callId)}`
    : JSON.stringify([summary.tool, inputKey]);
}

function createOpenCodeEventStream(onToolUse) {
  let buffer = "";
  const textParts = [];
  const tools = [];
  const toolIndexes = new Map();
  function publish(summary) {
    if (typeof onToolUse !== "function") return;
    void Promise.resolve()
      .then(() => onToolUse(summary))
      .catch(() => {
        telemetryWarning("event publication callback rejected");
      });
  }

  function acceptLine(line) {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === "text" && typeof event.part?.text === "string") {
        textParts.push(event.part.text);
      }
      if (event.type !== "tool_use") return;

      const summary = toolSummary(event);
      if (!summary) return;
      const key = toolEventKey(event, summary);
      const existingIndex = toolIndexes.get(key);
      if (existingIndex !== undefined) {
        const previous = tools[existingIndex];
        if (previous.completed) return;
        tools[existingIndex] = summary;
        if (
          (!previous.completed && summary.completed) ||
          (!previous.failed && summary.failed)
        ) {
          publish(summary);
        }
        return;
      }
      if (tools.length >= 20) return;
      toolIndexes.set(key, tools.length);
      tools.push(summary);
      publish(summary);
    } catch {
      // Ignore non-event diagnostics.
    }
  }

  function push(chunk) {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) acceptLine(line);
  }

  async function waitForPublished() {
    return undefined;
  }

  async function complete() {
    if (buffer.trim()) acceptLine(buffer);
    buffer = "";
    await waitForPublished();
    return { textParts, tools };
  }

  return { push, waitForPublished, complete };
}

async function runOpenCode({
  model,
  prompt,
  title,
  agent,
  files = [],
  onToolUse,
  timeoutMs = openCodeTimeoutMs,
  variant,
}) {
  const promptDirectory = await mkdtemp(join(tmpdir(), "koler-agent-"));
  const promptPath = join(promptDirectory, "request.md");
  await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
  const fileArguments = [promptPath, ...files].flatMap((path) => ["-f", path]);

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      "opencode",
      [
        "run",
        "--pure",
        "--agent",
        agent,
        "-m",
        model,
        ...(variant ? ["--variant", variant] : []),
        "--format",
        "json",
        "--title",
        title,
        "Выполни приложенную задачу и верни только JSON.",
        ...fileArguments,
      ],
      {
        cwd: root,
        env: childEnvironment(model),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    let finished = false;
    let timedOut = false;
    let forceKillTimer;
    let timer;
    const eventStream = createOpenCodeEventStream(onToolUse);

    async function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      void rm(promptDirectory, { recursive: true, force: true }).catch(
        () => {},
      );
      if (error) {
        rejectRun(error);
        return;
      }
      resolveRun(value);
    }

    async function finishTimeout() {
      if (finished) return;
      const partialRun = await eventStream.complete().catch(() => ({
        textParts: [],
        tools: [],
      }));
      const error = new Error(`OpenCode timed out for ${model}`);
      error.partialRun = partialRun;
      await finish(error);
    }

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
        void finishTimeout();
      }, openCodeTerminationGraceMs);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      eventStream.push(chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", async (error) => {
      const partialRun = await eventStream.complete().catch(() => ({
        textParts: [],
        tools: [],
      }));
      error.partialRun = partialRun;
      await finish(error);
    });
    child.on("close", async (code) => {
      if (timedOut) {
        await finishTimeout();
        return;
      }
      if (code !== 0) {
        const partialRun = await eventStream.complete().catch(() => ({
          textParts: [],
          tools: [],
        }));
        const error = new Error(
          stderr.trim() || `OpenCode exited with ${code}`,
        );
        error.partialRun = partialRun;
        await finish(error);
        return;
      }

      try {
        const partialRun = await eventStream.complete();
        const { textParts, tools } = partialRun;
        let value;
        try {
          value = extractJson(textParts.join("\n"));
        } catch (error) {
          error.partialRun = partialRun;
          error.completedMalformed = true;
          throw error;
        }
        await finish(null, {
          value,
          tools,
        });
      } catch (error) {
        await finish(error);
      }
    });
  });
}

function storedVisionObservationForJob(job, attachmentRef) {
  const previousResult = storedJobJson(job.resultJson, null);
  if (
    previousResult?.visionObservation?.attachmentRef === attachmentRef
  ) {
    const storedObservation = normalizeVisionObservation(
      previousResult.visionObservation,
    );
    if (storedObservation) {
      return { ...storedObservation, attachmentRef };
    }
  }
  return null;
}

async function visionObservationForJob(job, jobStartedAtMs) {
  const attachment = storedJobJson(job.attachmentJson, null);
  if (!resolveVisionImageUrl(attachment?.src, standUrl)) return null;
  const attachmentRef = String(attachment.src);
  const storedObservation = storedVisionObservationForJob(
    job,
    attachmentRef,
  );
  if (storedObservation) {
    await addEvent(
      job,
      "vision-result",
      "Сохранённое наблюдение по фото добавлено",
      "Вложение не изменилось, поэтому агент продолжает с уже проверенными видимыми фактами.",
    );
    return storedObservation;
  }

  let downloaded;
  await addEvent(
    job,
    "vision",
    "Модель для фото изучает снимок",
    "Отдельная модель отмечает только видимые признаки.",
    "active",
  );
  try {
    const downloadTimeoutMs = stageTimeoutForDeadline(
      jobStartedAtMs,
      performance.now(),
      IMAGE_DOWNLOAD_TIMEOUT_MS,
      jobDeadlineMs,
      terminalPublicationReserveMs,
      0,
    );
    if (downloadTimeoutMs <= 0) {
      throw new Error(
        "Image download timed out before vision: job deadline exhausted",
      );
    }
    downloaded = await downloadVisionImage({
      attachment,
      standUrl,
      timeoutMs: downloadTimeoutMs,
    });
    if (!downloaded) return null;
    const visionStageStartedAtMs = performance.now();
    const visionTimeoutMs = stageTimeoutForDeadline(
      jobStartedAtMs,
      visionStageStartedAtMs,
      visionOpenCodeTimeoutMs,
      jobDeadlineMs,
      terminalPublicationReserveMs,
      openCodeTerminationGraceMs,
    );
    if (visionTimeoutMs <= 0) {
      throw new Error(
        "OpenCode timed out before vision: job deadline exhausted",
      );
    }
    const prompt = `${visionInstruction}

## Имя вложения

${JSON.stringify(String(attachment?.name ?? "photo"))}

## Явный текст заявки

Текст ниже помогает выбрать объект действия и важнее визуальной гипотезы:
${JSON.stringify({
  subject: String(job.subject ?? ""),
  body: String(job.body ?? ""),
})}`;
    let observation;
    let visionError;
    // ponytail: one retry shares the original vision window.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const attemptTimeoutMs = stageTimeoutForDeadline(
        visionStageStartedAtMs,
        performance.now(),
        visionTimeoutMs,
        visionTimeoutMs,
        0,
        openCodeTerminationGraceMs,
      );
      if (attemptTimeoutMs <= 0) break;
      try {
        const run = await runOpenCode({
          model: visionModel,
          prompt,
          title: `Колер · фото ${job.id.slice(-6)}`,
          agent: "koler-reviewer",
          files: [downloaded.path],
          timeoutMs: attemptTimeoutMs,
        });
        observation = normalizeVisionObservation(run.value);
        if (observation) break;
        visionError = new Error("Vision model returned no observation");
      } catch (error) {
        visionError = error;
      }
    }
    if (!observation) {
      throw visionError ?? new Error("Vision model returned no observation");
    }
    const storedObservation = { ...observation, attachmentRef };
    await addEvent(
      job,
      "vision-result",
      "Фото осмотрено",
      observation.summary || "Видимые признаки добавлены в задачу.",
    );
    return storedObservation;
  } catch (error) {
    console.error(
      `[bridge] vision ${job.id}:`,
      error instanceof Error ? error.message : error,
    );
    await addEvent(
      job,
      "vision-fallback",
      "Фото временно недоступно модели",
      "Агент продолжает по тексту и не использует необработанное фото как доказательство.",
    ).catch(() => {});
    return null;
  } finally {
    if (downloaded) {
      await rm(downloaded.directory, { recursive: true, force: true }).catch(
        () => {},
      );
    }
  }
}

function primaryPrompt(
  job,
  liveDemoData,
  visionObservation,
  continuationContext = continuationContextForJob(job),
) {
  const visionBlock = visionPromptBlock(visionObservation);
  const promptContext = continuationContext
    ? { ...continuationContext }
    : null;
  if (promptContext) delete promptContext.openedSources;
  const continuationBlock = promptContext
    ? `## Сохранённый контекст прошлого раунда

${promptJson(promptContext)}

- Свежий ответ клиента разрешает прежний blocker и имеет приоритет.
- Переиспользуй прежние intent, evidence, assumptions, vision-наблюдение и открытые публичные источники; не задавай тот же вопрос повторно.
- Evidence из прежних inventory/supplier snapshots историческое. Цену, остаток, срок и подтверждённый supplier plan построй заново только по текущим snapshots ниже.`
    : "";
  return `${salesInstruction}

## Текущий заказ

${promptJson(reviewerOrderView(job))}

${continuationBlock}

## Демонстрационные источники истины

${promptJson({
    products: liveDemoData.products,
    supplierSnapshot: liveDemoData.market,
    rules: liveDemoData.rules,
    inventorySnapshot: liveDemoData.inventorySnapshot,
  })}

${visionBlock}

## Уточнения запуска

- Верни один компактный primary draft без Markdown: обязательное ядро из
  инструкции и только действительно применимые optional-поля. Не генерируй
  производные поля полного AgentResult — их добавит guard.
- Числа продукта возьми только из снимка склада внутри демонстрационных источников.
- Пропусти веб-поиск для доменов .example и рутинной зелёной заявки.
- Сайт и ИНН дают точное совпадение. По одному названию компании ищи осторожно и помечай каждый результат словами «Совпадение по названию».
- Не запрашивай факты, которые клиент уже сообщил. Не превращай неизвестные размеры, материал основания, назначение помещения, режим уборки или нагрузку в blocker: запиши их как явные assumptions, дай полезный широкий диапазон и укажи границу подтверждения.
- Единственный вопрос клиенту допустим только при настоящей неоднозначности объекта действия.
- При дефиците обязательно найди и открой публичные страницы возможных поставщиков, верни их как supplierLeads и включи руководителю выполнимый вариант с followUpActor="supplier". Публичная страница даёт только lead и список для подтверждения.
- Подтверждённые цена, остаток и срок берутся только из текущего supplier snapshot/API. Не возвращай supplierPlan: его программно построит guard. Не выдавай публичный supplier lead за подтверждённый факт.
- Не обещай ГОСТ, GMP, ISO, СанПиН, санитарную обработку, дезинфекцию или химическую стойкость без точного подтверждения в карточке товара с документом и источником.
- При реальном домене исследуй компанию, когда масштаб, профиль или надёжность могут изменить жёлтое или красное решение.
- Каждый использованный внешний факт свяжи с web evidence внутри resolvedIntent; отдельный research не возвращай.
- В составном запросе перечисли каждую подзадачу в goal и reply. Для каждого отдельного вопроса о стоимости верни свой набор estimates; начни method с названия объекта и расположи основной target первым. Если клиент просит выбрать цвет, дай конкретную рекомендацию из подтверждённой палитры и честную границу для остальных объектов.
- Пиши активным русским языком без оправданий и риторических противопоставлений.`;
}

function primaryRetryPrompt(prompt, partialRun) {
  const contextStart = prompt.indexOf("## Текущий заказ");
  const compactContext =
    contextStart >= 0 ? prompt.slice(contextStart) : prompt.slice(-24_000);
  const contractStart = salesInstruction.indexOf("## Компактный JSON-draft");
  const compactContract =
    contractStart >= 0
      ? salesInstruction.slice(contractStart)
      : salesInstruction.slice(-12_000);
  const openedSourceUrls = [
    ...new Set(partialRun.tools.flatMap((tool) => tool.urls)),
  ];
  const partialDraft = (partialRun.textParts ?? [])
    .join("\n")
    .slice(-8_000);
  return `# Завершение primary draft

${compactContract}

${compactContext}

## Завершение незаконченного исследования

Первый запуск уже открыл эти прямые страницы:
${promptJson(openedSourceUrls)}

${
  partialDraft
    ? `Незавершённый видимый черновик первого запуска:\n${promptJson(partialDraft)}`
    : ""
}

- Не вызывай инструменты и не начинай новый поиск.
- Сразу собери компактный primary draft: schemaVersion, confidence,
  resolvedIntent, commitment и только применимые estimates, product,
  supplierLeads, route, options или reply. Полный AgentResult построит guard.
- Не возвращай zone, decision, understood, missing, visionObservation, market,
  research, businessContext, zoneReason, managerNote, checks, sources,
  decisionBasis, review, calculation или supplierPlan.
- Если открытая страница не даёт точного кода или свойства, сохрани широкое
  направление либо честную границу знания; не продолжай поиск точности.
- Не используй внешнее утверждение, которое нельзя связать с одной из ссылок
  выше.`;
}

function compoundCoverageRetryPrompt(
  prompt,
  draft,
  coverageGaps,
  openedSourceUrls,
) {
  const contextStart = prompt.indexOf("## Текущий заказ");
  const compactContext =
    contextStart >= 0 ? prompt.slice(contextStart) : prompt.slice(-24_000);
  const contractStart = salesInstruction.indexOf("## Компактный JSON-draft");
  const compactContract =
    contractStart >= 0
      ? salesInstruction.slice(contractStart)
      : salesInstruction.slice(-12_000);
  return `# Дополнение составного primary draft

${compactContract}

${compactContext}

## Черновик, который потерял часть запроса

${promptJson(draft)}

## Что обязательно восстановить

${promptJson(coverageGaps)}

Уже открытые прямые страницы:
${promptJson(openedSourceUrls)}

- Если пропущенная часть требует внешнего факта, которого нет среди уже
  открытых страниц, выполни один целевой discovery-поиск и открой одну прямую
  страницу. Если подходящая страница уже открыта, не ищи повторно.
- Верни заново один полный компактный primary draft, а не патч.
- Сохрани подтверждённые evidence и assumptions. Для каждой пропущенной
  числовой подзадачи добавь отдельные grounded estimates; начни method с
  названия объекта. Не выдумывай точность сверх открытых фактов.
- Необычный, защищённый или некоммерческий неодушевлённый объект не отменяет
  мысленную оценку: по открытому масштабу и явным assumptions дай широкие
  surface_area, paint_quantity и budget; правовую и коммерческую границу укажи
  отдельно.
- Вопрос о стоимости не закрыт без отдельного budget estimate, method которого
  начинается с названия соответствующего объекта.
- В asks[].evidenceIds оставь только ID evidence с source.kind="message";
  vision, web и snapshot ID там недопустимы.
- Если составной запрос называет несколько объектов покраски и спрашивает
  стоимость хотя бы одного, восстанови отдельный budget для каждого объекта.
- Если общий вопрос о цвете следует после нескольких объектов покраски, явно
  назови каждый объект и дай ему отдельную рекомендацию.
- В reply явно назови и закрой каждую подзадачу, включая рекомендацию цвета,
  если её просил клиент. Не задавай вопрос вместо безопасной широкой оценки.`;
}

function reviewPrompt(
  job,
  draft,
  liveDemoData,
  packet = Object.freeze({
    order: reviewerOrderView(job),
    result: reviewerResultView(draft),
  }),
) {
  const order = packet.order;
  const latestCustomerMessage =
    [...order.conversation].reverse().find((message) => message.role === "customer")?.body ??
    order.body;
  const reviewerTargetAmbiguityBoundary = (result) => Boolean(
    result?.zone === "yellow" &&
      result.route === "needs_info" &&
      result.commitment === "none" &&
      result.resolvedIntent?.target?.state === "ambiguous" &&
      result.resolvedIntent?.blocker?.kind === "target_ambiguity" &&
      result.product === null &&
      Array.isArray(result.estimates) &&
      result.estimates.length === 0 &&
      Array.isArray(result.supplierLeads) &&
      result.supplierLeads.length === 0 &&
      Array.isArray(result.options) &&
      result.options.length === 0
  );
  const targetAmbiguityBoundary = reviewerTargetAmbiguityBoundary(packet.result);
  const allowedPathPrefixes = reviewerAllowedPathPrefixes(packet);
  return `${reviewerInstruction}

## Заказ

${promptJson({ ...order, attachment: undefined })}

## Последнее сообщение клиента целиком

${promptJson(latestCustomerMessage.slice(0, 2_000))}

## Каталог, склад, прайс и правила

${promptJson({
    products: liveDemoData.products,
    market: liveDemoData.market,
    rules: liveDemoData.rules,
    inventorySnapshot: liveDemoData.inventorySnapshot,
  })}

## Машинный источник supplierPlan

${JSON.stringify({
    kind: "snapshot",
    dataset: "supplier",
    key: packet.result.supplierPlan?.supplierName ?? null,
    checkedAt: packet.result.supplierPlan?.stockCheckedAt ?? null,
  })}

Если tuple supplierPlan.source совпадает с текущим market/supplier snapshot,
это программно выведенный trusted plan. Не отклоняй его за отсутствие
дублирующего model evidence; несовпадающие числа, ключ или checkedAt по-прежнему
отклоняй.

## Машинная граница неоднозначной цели

${promptJson({
    targetAmbiguityBoundary,
    candidateIsNotRecommendation: targetAmbiguityBoundary,
  })}

При targetAmbiguityBoundary=true candidate/choice не является применением или
рекомендацией товара. Reject по human_safety, основанный только на таком
candidate/choice, структурно недействителен; допускаются только grounded
privacy, target inconsistency или другое реальное нарушение.

## Разрешённые пути по правилам (authoritative runtime map)

${JSON.stringify(allowedPathPrefixes)}

Для каждого issue: issue.path должен быть равен одному из перечисленных префиксов
для этого rule или находиться ниже него. Если для rule нет разрешённого
подтверждённого нарушения, одобри решение с blockingIssues=[]. Никогда не
выдумывай и не изменяй детерминированные факты packet.

## Черновик агента

${promptJson(packet.result)}

Верни только JSON по схеме инструкции.`;
}

function reviewerRetryMetadata(review, packet) {
  const schemaVersion = review?.schemaVersion;
  return {
    schemaVersion: {
      type: typeof schemaVersion,
      ...(typeof schemaVersion === "number" &&
      Number.isFinite(schemaVersion) &&
      Math.abs(schemaVersion) <= 100
        ? { value: schemaVersion }
        : {}),
    },
    approved:
      typeof review?.approved === "boolean" ? review.approved : null,
    blockingIssueCount: Array.isArray(review?.blockingIssues)
      ? review.blockingIssues.length
      : 0,
    validationErrors: reviewerDecisionValidationErrors(review, packet),
  };
}

function reviewRetryPrompt(packet, reviewMetadata) {
  const reviewerTargetAmbiguityBoundary = (result) => Boolean(
    result?.zone === "yellow" &&
      result.route === "needs_info" &&
      result.commitment === "none" &&
      result.resolvedIntent?.target?.state === "ambiguous" &&
      result.resolvedIntent?.blocker?.kind === "target_ambiguity" &&
      result.product === null &&
      Array.isArray(result.estimates) &&
      result.estimates.length === 0 &&
      Array.isArray(result.supplierLeads) &&
      result.supplierLeads.length === 0 &&
      Array.isArray(result.options) &&
      result.options.length === 0
  );
  const targetAmbiguityBoundary = reviewerTargetAmbiguityBoundary(packet.result);
  const allowedPathPrefixes = reviewerAllowedPathPrefixes(packet);
  return `${reviewerInstruction}

## Повторная проверка

Первый ответ не прошёл ReviewerDecisionV2. Исправь только перечисленные безопасные ошибки.
Безопасная структурная сводка первого ответа:
${JSON.stringify(reviewMetadata)}

## Машинная граница неоднозначной цели

${JSON.stringify({
    targetAmbiguityBoundary,
    candidateIsNotRecommendation: targetAmbiguityBoundary,
  })}

При targetAmbiguityBoundary=true candidate/choice не является применением или
рекомендацией товара. Ошибку path_not_allowed исправляй безопасно: не создавай
raw verdict/reasoning и не отклоняй только за human_safety по candidate/choice.

## Разрешённые пути по правилам (authoritative runtime map)

${JSON.stringify(allowedPathPrefixes)}

Для каждого issue: issue.path должен быть равен одному из перечисленных префиксов
для этого rule или находиться ниже него. Ошибку path_not_allowed исправляй,
выбирая только существующий путь из карты; если для rule нет разрешённого
подтверждённого нарушения, одобри решение с blockingIssues=[]. Никогда не
выдумывай и не изменяй детерминированные факты packet.

## Неизменяемый пакет

${JSON.stringify(packet)}

- Используй только этот пакет.
- Не вызывай инструменты и не начинай новый поиск.
- Верни только ReviewerDecisionV2 по схеме инструкции.
- Не возвращай reasoning, credentials или другие секреты.`;
}

function legacyReviewerDecision(decision) {
  return {
    approved: decision.approved,
    verdict: decision.verdict,
    notes: decision.notes,
    blockingIssues: decision.blockingIssues.map((issue) => issue.detail),
  };
}

function unavailableReviewerDecision() {
  return {
    approved: false,
    unavailable: true,
    verdict: "Руководитель получил пункты для решения",
    notes: ["Черновик сохранён для проверки руководителем."],
    blockingIssues: ["Требуется ручная проверка перед отправкой."],
  };
}

async function reviewerDecisionWithRetry({
  run,
  packet,
  prompt,
  onRetry,
}) {
  let firstRun;
  try {
    firstRun = await run({ prompt, packet });
  } catch (error) {
    if (!error?.completedMalformed) {
      return { review: unavailableReviewerDecision(), retried: false, error };
    }
    firstRun = { value: null };
  }

  let firstDecision;
  try {
    firstDecision = validateReviewerDecisionV2(firstRun?.value, packet);
  } catch {
    firstDecision = null;
  }
  if (firstDecision) {
    return {
      review: legacyReviewerDecision(firstDecision),
      retried: false,
    };
  }

  try {
    await onRetry?.();
  } catch {
    telemetryWarning("review retry event publication failed");
  }

  let secondRun;
  try {
    secondRun = await run({
      prompt: reviewRetryPrompt(
        packet,
        reviewerRetryMetadata(firstRun?.value, packet),
      ),
      packet,
    });
  } catch (error) {
    return { review: unavailableReviewerDecision(), retried: true, error };
  }

  let secondDecision;
  try {
    secondDecision = validateReviewerDecisionV2(secondRun?.value, packet);
  } catch {
    secondDecision = null;
  }
  return secondDecision
    ? { review: legacyReviewerDecision(secondDecision), retried: true }
    : { review: unavailableReviewerDecision(), retried: true };
}

async function processJob(job) {
  const jobStartedAtMs = performance.now();
  const stopLeaseRenewal = startLeaseRenewal(job);
  const primaryModel = selectedModel(job);
  const reviewerModel = reviewerFor();
  const primaryVariant = modelVariant(primaryModel);
  const reviewerVariant = modelVariant(reviewerModel);
  const liveDemoData = demoDataForJob(job);

  try {
    const continuationContext = continuationContextForJob(job);
    const visionObservation = await visionObservationForJob(
      job,
      jobStartedAtMs,
    );
    const prompt = primaryPrompt(
      job,
      liveDemoData,
      visionObservation,
      continuationContext,
    );
    const continuationOpenedSourceUrls = Array.isArray(
      continuationContext?.openedSourceUrls,
    )
      ? continuationContext.openedSourceUrls
      : [];
    const runPrimary = ({
      agent,
      timeoutMs,
      runPrompt = prompt,
      publishResearch = false,
    }) =>
      runOpenCode({
        model: primaryModel,
        variant: primaryVariant,
        prompt: runPrompt,
        title: `Колер · заказ ${job.id.slice(-6)}`,
        agent,
        timeoutMs,
        onToolUse: publishResearch
          ? (tool) =>
              addEvent(
                job,
                "research",
                tool.urls.length
                  ? "Агент открыл публичный источник"
                  : "Агент ищет открытые источники",
                tool.detail,
              )
          : undefined,
      });
    let guardedJob = {
      ...job,
      visionObservation,
      openedSourceUrls: continuationOpenedSourceUrls,
      openedSources: continuationContext?.openedSources ?? [],
    };
    let attemptOpenedSourceUrls = [];
    let verifiedOpenedSourceUrls = continuationOpenedSourceUrls;
    let result;
    try {
      const primaryRun = await runPrimaryWithRetry({
        run: async () => {
          await addConfirmedEvent(
            job,
            "primary",
            "Агент готовит расчёт и подбор",
            "Основная модель получила полный запрос, сохранённый контекст, каталог и снимок склада.",
            "active",
          );
          const primaryTimeoutMs = stageTimeoutForDeadline(
            jobStartedAtMs,
            performance.now(),
            primaryOpenCodeTimeoutMs,
            jobDeadlineMs,
            terminalPublicationReserveMs,
            openCodeTerminationGraceMs,
          );
          if (primaryTimeoutMs <= 0) {
            throw new Error(
              "OpenCode timed out before primary: job deadline exhausted",
            );
          }
          return runPrimary({
            agent: "koler-sales",
            timeoutMs: primaryTimeoutMs,
            publishResearch: true,
          });
        },
        retry: (partialRun) => {
          const synthesisTimeoutMs = stageTimeoutForDeadline(
            jobStartedAtMs,
            performance.now(),
            openCodeTimeoutMs,
            jobDeadlineMs,
            terminalPublicationReserveMs,
            openCodeTerminationGraceMs,
          );
          if (synthesisTimeoutMs <= 0) {
            const error = new Error(
              "OpenCode timed out before synthesis: job deadline exhausted",
            );
            error.partialRun = partialRun;
            throw error;
          }
          return runPrimary({
            agent: "koler-sales-local",
            timeoutMs: synthesisTimeoutMs,
            runPrompt: primaryRetryPrompt(prompt, partialRun),
          });
        },
        onRetry: () =>
          addEvent(
            job,
            "primary-retry",
            "Агент собирает ответ из найденных фактов",
            "Исследовательский запуск не завершил JSON. Повтор использует уже открытые источники и завершает ответ без нового поиска.",
          ),
      });
      attemptOpenedSourceUrls = openedSourceUrlsFromTools(primaryRun.tools);
      verifiedOpenedSourceUrls = [
        ...new Set([
          ...continuationOpenedSourceUrls,
          ...attemptOpenedSourceUrls,
        ]),
      ];
      guardedJob = {
        ...guardedJob,
        openedSourceUrls: verifiedOpenedSourceUrls,
        openedSources: [
          ...guardedJob.openedSources,
          ...openedSourcesFromTools(primaryRun.tools),
        ],
      };
      result = normalizeV2AgentResult(
        primaryRun.value,
        liveDemoData,
        { ...guardedJob, requireResolvedAsks: true },
      );
      const coverageGaps = askCoverageGaps(guardedJob, result);
      if (coverageGaps.length) {
        await addEvent(
          job,
          "primary-retry",
          "Агент дополняет составной ответ",
          "Одна из частей запроса не попала в письмо; повтор сохраняет собранные факты и при необходимости открывает один источник для пропущенной части.",
          "active",
        );
        const coverageTimeoutMs = stageTimeoutForDeadline(
          jobStartedAtMs,
          performance.now(),
          openCodeTimeoutMs,
          jobDeadlineMs,
          terminalPublicationReserveMs,
          openCodeTerminationGraceMs,
        );
        if (coverageTimeoutMs <= 0) {
          throw new Error(
            "OpenCode timed out before compound coverage repair: job deadline exhausted",
          );
        }
        const coverageRun = await runPrimary({
          agent: "koler-sales",
          timeoutMs: coverageTimeoutMs,
          runPrompt: compoundCoverageRetryPrompt(
            prompt,
            primaryRun.value,
            coverageGaps,
            verifiedOpenedSourceUrls,
          ),
          publishResearch: true,
        });
        const coverageOpenedSourceUrls = openedSourceUrlsFromTools(
          coverageRun.tools,
        );
        attemptOpenedSourceUrls = [
          ...new Set([
            ...attemptOpenedSourceUrls,
            ...coverageOpenedSourceUrls,
          ]),
        ];
        verifiedOpenedSourceUrls = [
          ...new Set([
            ...continuationOpenedSourceUrls,
            ...attemptOpenedSourceUrls,
          ]),
        ];
        guardedJob = {
          ...guardedJob,
          openedSourceUrls: verifiedOpenedSourceUrls,
          openedSources: [
            ...guardedJob.openedSources,
            ...openedSourcesFromTools(coverageRun.tools),
          ],
        };
        const repairedResult = normalizeV2AgentResult(
          coverageRun.value,
          liveDemoData,
          { ...guardedJob, requireResolvedAsks: true },
        );
        if (askCoverageGaps(guardedJob, repairedResult).length) {
          throw new Error("Primary draft omitted an explicit request part");
        }
        result = repairedResult;
      }
    } catch (primaryError) {
      if (Array.isArray(primaryError?.partialRun?.tools)) {
        attemptOpenedSourceUrls = openedSourceUrlsFromTools(
          primaryError.partialRun.tools,
        );
      }
      verifiedOpenedSourceUrls = [
        ...new Set([
          ...continuationOpenedSourceUrls,
          ...attemptOpenedSourceUrls,
        ]),
      ];
      guardedJob = {
        ...guardedJob,
        openedSourceUrls: verifiedOpenedSourceUrls,
        openedSources: [
          ...guardedJob.openedSources,
          ...openedSourcesFromTools(primaryError?.partialRun?.tools),
        ],
      };
      console.error(
        `[bridge] primary ${job.id}:`,
        primaryError instanceof Error
          ? primaryError.message
          : primaryError,
      );
      await addEvent(
        job,
        "primary-fallback",
        "Черновик передан на безопасную проверку",
        "Неполный ответ рабочей модели отброшен. Клиенту не задаются новые вопросы и не создаётся неподтверждённое предложение.",
        "error",
      ).catch(() => {});
      result = managerFallbackAgentResult(guardedJob, {
        reviewerModel,
        reason: "Рабочая модель не вернула полный безопасный контракт.",
      });
    }

    const completeFailClosedManager = isCompleteFailClosedManager(result);
    let reviewerProvenance;
    if (completeFailClosedManager) {
      reviewerProvenance = {
        stage: "review-skipped",
        title: "Безопасный результат уже сформирован",
        detail: "Полный fail-closed результат не передаётся на долгую повторную проверку; руководитель получил безопасные варианты.",
      };
    } else {
      await addEvent(
        job,
        "review",
        "Черновик передан модели проверки",
        `${modelLabel(reviewerModel)}${
          reviewerVariant ? ` с усилием ${reviewerVariant}` : ""
        } проверяет объём, цену, источники и полномочия.`,
        "active",
      );

      try {
        const reviewerPacket = Object.freeze({
          order: reviewerOrderView(job),
          result: reviewerResultView(result),
        });
        const runReviewer = async ({ prompt }) => {
          const reviewerTimeoutMs = stageTimeoutForDeadline(
            jobStartedAtMs,
            performance.now(),
            reviewerOpenCodeTimeoutMs,
            jobDeadlineMs,
            terminalPublicationReserveMs,
            openCodeTerminationGraceMs,
          );
          if (reviewerTimeoutMs <= 0) {
            throw new Error(
              "OpenCode timed out before reviewer: job deadline exhausted",
            );
          }
          const reviewRun = await runOpenCode({
            model: reviewerModel,
            variant: reviewerVariant,
            prompt,
            title: `Колер · проверка ${job.id.slice(-6)}`,
            agent: "koler-reviewer",
            timeoutMs: reviewerTimeoutMs,
          });
          return reviewRun;
        };
        const reviewOutcome = await reviewerDecisionWithRetry({
          run: runReviewer,
          packet: reviewerPacket,
          prompt: reviewPrompt(job, result, liveDemoData, reviewerPacket),
          onRetry: () =>
            addEvent(
              job,
              "review-retry",
              "Повторная проверка reviewer",
              "Первый ответ не прошёл ReviewerDecisionV2; повтор использует тот же неизменяемый пакет без инструментов и нового поиска.",
              "active",
            ),
        });
        if (reviewOutcome.error) {
          console.error(
            `[bridge] reviewer ${job.id}: проверка недоступна`,
          );
        }
        result = applyReviewerResult(
          result,
          reviewOutcome.review,
          reviewerModel,
          liveDemoData,
          guardedJob,
        );
        reviewerProvenance = reviewOutcome.review.unavailable
          ? {
              stage: "review-fallback",
              title: "Решение передано руководителю",
              detail:
                "Черновик и проверенные факты сохранены. Руководитель получил готовые варианты.",
            }
          : {
              stage: "review-result",
              title: `${modelLabel(reviewerModel)} завершила проверку`,
              detail:
                result.review?.verdict ||
                "Факты и границы полномочий подтверждены.",
            };
      } catch (reviewError) {
        console.error(
          `[bridge] reviewer ${job.id}:`,
          reviewError instanceof Error ? reviewError.message : reviewError,
        );
        result = applyReviewerResult(
          result,
          {
            approved: false,
            unavailable: true,
            verdict: "Руководитель получил пункты для решения",
            notes: ["Черновик сохранён для проверки руководителем."],
            blockingIssues: ["Требуется ручная проверка перед отправкой."],
          },
          reviewerModel,
          liveDemoData,
          guardedJob,
        );
        reviewerProvenance = {
          stage: "review-fallback",
          title: "Решение передано руководителю",
          detail:
            "Черновик и проверенные факты сохранены. Руководитель получил готовые варианты.",
        };
      }
    }

    const terminalTimeoutMs = stageTimeoutForDeadline(
      jobStartedAtMs,
      performance.now(),
      agentApiTimeoutMs,
      jobDeadlineMs,
      0,
      0,
    );
    if (terminalTimeoutMs <= 0) {
      throw new Error(
        "Agent API timed out before result: job deadline exhausted",
      );
    }
    await agentRequestWithRetry(
      resultPayload(
        job,
        result,
        verifiedOpenedSourceUrls,
        primaryModel,
        reviewerModel,
        reviewerProvenance,
        guardedJob.openedSources,
      ),
      "POST",
      terminalTimeoutMs,
    );
  } catch (error) {
    console.error(
      `[bridge] job ${job.id}:`,
      error instanceof Error ? error.message : error,
    );
    const errorPublicationTimeoutMs = stageTimeoutForDeadline(
      jobStartedAtMs,
      performance.now(),
      agentApiTimeoutMs,
      jobDeadlineMs,
      0,
      0,
    );
    if (errorPublicationTimeoutMs > 0) {
      await agentRequestWithRetry(
        {
          action: "error",
          ...claimPayload(job),
          detail: safeJobErrorDetail(error),
        },
        "POST",
        errorPublicationTimeoutMs,
      ).catch(() => {});
    }
  } finally {
    stopLeaseRenewal();
  }
}

async function heartbeatLoop() {
  while (!stopped) {
    try {
      await agentRequest({ action: "heartbeat" });
    } catch (error) {
      console.error("[bridge] heartbeat:", error.message);
    }
    await sleep(15_000);
  }
}

async function jobLoop(workerNo) {
  while (!stopped) {
    try {
      const { job } = await agentRequest(
        null,
        "GET",
        agentApiTimeoutMs,
        `${bridgeWorkerId}-${workerNo}`,
      );
      if (job) await processJob(job);
    } catch (error) {
      console.error("[bridge] poll:", error.message);
    }
    await sleep(2_000);
  }
}

process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});

console.log(`[bridge] ${standUrl}`);
console.log(`[bridge] default=${fallbackPrimary}`);
console.log(
  `[bridge] default-variant=${modelVariant(fallbackPrimary) ?? "default"}`,
);
console.log(
  `[bridge] reviewer=${strongReviewer} variant=${
    modelVariant(strongReviewer) ?? "default"
  }`,
);
console.log(`[bridge] vision=${visionModel}`);
console.log(`[bridge] concurrency=${bridgeConcurrency}`);

await Promise.all([
  heartbeatLoop(),
  ...Array.from(
    { length: bridgeConcurrency },
    (_, index) => jobLoop(index + 1),
  ),
]);
