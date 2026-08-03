#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const metricNames = [
  "resultValid",
  "routeCorrect",
  "calculationCorrect",
  "noRepeatedQuestions",
  "noUnsupportedPromises",
  "groundedSources",
  "reviewerBlockedUnsafe",
  "fallbackCorrect",
];

const argv = process.argv.slice(2);
const jsonOutput = argv.includes("--json");
const positional = argv.filter((arg) => arg !== "--json" && arg !== "--help");
const unknownOptions = argv.filter(
  (arg) => arg.startsWith("-") && arg !== "--json" && arg !== "--help",
);

if (argv.includes("--help")) {
  console.log(`Usage:
  node .agents/skills/evaluate-koler-agent-rules/scripts/score-eval.mjs <results.json> [--json]

Input is {"corpus": {...}, "cases": [...]}. Each case must contain:
  id, family, variant, repeat, metrics

Metric values are true, false, or null. Optional latencyMs is a non-negative
number. Optional criticalFailures is an array of short identifiers.

The root object must contain {"corpus": {"id": "...", "version": "..."}}.
Every variant must contain the same (case id, repeat) pairs. Duplicate records
and family mismatches are rejected before scoring.

The script reads one local JSON file, prints aggregate metrics, and writes
nothing.`);
} else if (unknownOptions.length > 0 || positional.length !== 1) {
  if (unknownOptions.length > 0) {
    console.error(`Unknown option: ${unknownOptions.join(", ")}`);
  }
  console.error(
    "Expected one results JSON path. Run with --help for the input contract.",
  );
  process.exitCode = 2;
} else {
  const inputPath = resolve(process.cwd(), positional[0]);
  let parsed;

  try {
    parsed = JSON.parse(await readFile(inputPath, "utf8"));
  } catch (error) {
    console.error(
      `Cannot read valid JSON from ${inputPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }

  if (parsed !== undefined) {
    const cases = parsed?.cases;
    const corpus = parsed?.corpus;
    const validationErrors = [];

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !corpus ||
      typeof corpus !== "object" ||
      Array.isArray(corpus) ||
      typeof corpus.id !== "string" ||
      corpus.id.trim() === "" ||
      (typeof corpus.version !== "string" &&
        typeof corpus.version !== "number") ||
      String(corpus.version).trim() === ""
    ) {
      validationErrors.push(
        "root.corpus must contain non-empty id and version",
      );
    }
    if (!Array.isArray(cases) || cases.length === 0) {
      validationErrors.push("root.cases must be a non-empty array");
    } else {
      cases.forEach((item, index) => {
        const at = `cases[${index}]`;
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          validationErrors.push(`${at} must be an object`);
          return;
        }
        for (const field of ["id", "family", "variant"]) {
          if (typeof item[field] !== "string" || item[field].trim() === "") {
            validationErrors.push(`${at}.${field} must be a non-empty string`);
          }
        }
        if (!Number.isSafeInteger(item.repeat) || item.repeat < 1) {
          validationErrors.push(
            `${at}.repeat must be a positive integer`,
          );
        }
        if (
          !item.metrics ||
          typeof item.metrics !== "object" ||
          Array.isArray(item.metrics)
        ) {
          validationErrors.push(`${at}.metrics must be an object`);
        } else {
          for (const metric of metricNames) {
            const value = item.metrics[metric];
            if (value !== true && value !== false && value !== null) {
              validationErrors.push(
                `${at}.metrics.${metric} must be true, false, or null`,
              );
            }
          }
        }
        if (
          item.latencyMs !== undefined &&
          item.latencyMs !== null &&
          (typeof item.latencyMs !== "number" ||
            !Number.isFinite(item.latencyMs) ||
            item.latencyMs < 0)
        ) {
          validationErrors.push(
            `${at}.latencyMs must be a non-negative number or null`,
          );
        }
        if (
          item.criticalFailures !== undefined &&
          (!Array.isArray(item.criticalFailures) ||
            item.criticalFailures.some(
              (failure) =>
                typeof failure !== "string" || failure.trim() === "",
            ))
        ) {
          validationErrors.push(
            `${at}.criticalFailures must be an array of non-empty strings`,
          );
        }
      });

      const recordKeys = new Map();
      const familyByCase = new Map();
      const pairsByVariant = new Map();
      for (const [index, item] of cases.entries()) {
        if (
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          typeof item.id !== "string" ||
          typeof item.family !== "string" ||
          typeof item.variant !== "string" ||
          !Number.isSafeInteger(item.repeat)
        ) {
          continue;
        }

        const recordKey = `${item.variant}\u0000${item.id}\u0000${item.repeat}`;
        if (recordKeys.has(recordKey)) {
          validationErrors.push(
            `cases[${index}] duplicates cases[${recordKeys.get(recordKey)}] for variant/id/repeat`,
          );
        } else {
          recordKeys.set(recordKey, index);
        }

        const knownFamily = familyByCase.get(item.id);
        if (knownFamily && knownFamily !== item.family) {
          validationErrors.push(
            `case ${item.id} has inconsistent families: ${knownFamily} and ${item.family}`,
          );
        } else {
          familyByCase.set(item.id, item.family);
        }

        if (!pairsByVariant.has(item.variant)) {
          pairsByVariant.set(item.variant, new Set());
        }
        pairsByVariant.get(item.variant).add(`${item.id}\u0000${item.repeat}`);
      }

      const pairEntries = [...pairsByVariant.entries()];
      if (pairEntries.length > 1) {
        const [referenceVariant, referencePairs] = pairEntries[0];
        const sortedReference = [...referencePairs].sort();
        for (const [variant, pairs] of pairEntries.slice(1)) {
          const sortedPairs = [...pairs].sort();
          if (
            sortedPairs.length !== sortedReference.length ||
            sortedPairs.some(
              (pair, index) => pair !== sortedReference[index],
            )
          ) {
            validationErrors.push(
              `variant ${variant} does not contain the same case id/repeat pairs as ${referenceVariant}`,
            );
          }
        }
      }
    }

    if (validationErrors.length > 0) {
      console.error("Invalid eval results:");
      validationErrors.forEach((error) => console.error(`- ${error}`));
      process.exitCode = 2;
    } else {
      const variants = new Map();

      function emptyMetrics() {
        return Object.fromEntries(
          metricNames.map((metric) => [
            metric,
            { pass: 0, fail: 0, applicable: 0 },
          ]),
        );
      }

      function percentile(sorted, fraction) {
        if (sorted.length === 0) return null;
        const index = Math.ceil(sorted.length * fraction) - 1;
        return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
      }

      for (const item of cases) {
        if (!variants.has(item.variant)) {
          variants.set(item.variant, {
            cases: 0,
            families: new Map(),
            metrics: emptyMetrics(),
            latencies: [],
            criticalFailures: [],
          });
        }

        const aggregate = variants.get(item.variant);
        aggregate.cases += 1;
        if (!aggregate.families.has(item.family)) {
          aggregate.families.set(item.family, {
            cases: 0,
            metrics: emptyMetrics(),
          });
        }
        const family = aggregate.families.get(item.family);
        family.cases += 1;

        for (const metric of metricNames) {
          const value = item.metrics[metric];
          if (value !== null) {
            aggregate.metrics[metric].applicable += 1;
            family.metrics[metric].applicable += 1;
            if (value) aggregate.metrics[metric].pass += 1;
            else aggregate.metrics[metric].fail += 1;
            if (value) family.metrics[metric].pass += 1;
            else family.metrics[metric].fail += 1;
          }
        }

        if (typeof item.latencyMs === "number") {
          aggregate.latencies.push(item.latencyMs);
        }
        for (const failure of item.criticalFailures ?? []) {
          aggregate.criticalFailures.push({
            caseId: item.id,
            failure,
          });
        }
      }

      const summary = [...variants.entries()].map(([variant, aggregate]) => {
        const latencies = aggregate.latencies.sort((a, b) => a - b);
        return {
          variant,
          cases: aggregate.cases,
          families: Object.fromEntries(
            [...aggregate.families.entries()].sort(([left], [right]) =>
              left.localeCompare(right, "ru"),
            ),
          ),
          metrics: aggregate.metrics,
          latencyMs: {
            count: latencies.length,
            median: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
            min: latencies[0] ?? null,
            max: latencies.at(-1) ?? null,
          },
          criticalFailures: aggregate.criticalFailures,
        };
      });

      const hasCriticalFailures = summary.some(
        (variant) => variant.criticalFailures.length > 0,
      );

      if (jsonOutput) {
        console.log(
          JSON.stringify(
            {
              status: hasCriticalFailures
                ? "BLOCKED_BY_CRITICAL_FAILURE"
                : "SCORED",
              inputPath,
              corpus: {
                id: corpus.id,
                version: corpus.version,
              },
              variants: summary,
            },
            null,
            2,
          ),
        );
      } else {
        for (const variant of summary) {
          console.log(`VARIANT ${variant.variant} (${variant.cases} cases)`);
          for (const metric of metricNames) {
            const score = variant.metrics[metric];
            console.log(
              `  ${metric}: ${score.pass}/${score.applicable} pass (${score.fail} fail)`,
            );
          }
          for (const [familyName, family] of Object.entries(
            variant.families,
          )) {
            const scores = metricNames
              .filter(
                (metric) => family.metrics[metric].applicable > 0,
              )
              .map((metric) => {
                const score = family.metrics[metric];
                return `${metric}=${score.pass}/${score.applicable}`;
              })
              .join(", ");
            console.log(
              `  family ${familyName} (${family.cases}): ${scores || "no applicable metrics"}`,
            );
          }
          console.log(
            `  latencyMs: n=${variant.latencyMs.count} median=${variant.latencyMs.median ?? "n/a"} p95=${variant.latencyMs.p95 ?? "n/a"} min=${variant.latencyMs.min ?? "n/a"} max=${variant.latencyMs.max ?? "n/a"}`,
          );
          console.log(
            `  criticalFailures: ${variant.criticalFailures.length}`,
          );
          for (const failure of variant.criticalFailures) {
            console.log(`    ${failure.caseId}: ${failure.failure}`);
          }
        }
        console.log(
          `\n${hasCriticalFailures ? "BLOCKED_BY_CRITICAL_FAILURE" : "SCORED"}: ${summary.length} variant(s).`,
        );
      }

      if (hasCriticalFailures) process.exitCode = 1;
    }
  }
}
