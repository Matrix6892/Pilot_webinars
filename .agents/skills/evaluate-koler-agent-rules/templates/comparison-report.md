<template>
```markdown
# Eval comparison: <название>

## Scope

- Hypothesis:
- Changed factor:
- Corpus id/version:
- Baseline:
- Candidate:
- Execution mode:
- External calls authorized: yes/no

## Controls

| Control | Value |
|---|---|
| Prompt/rule version | |
| Guard version | |
| Primary model | |
| Reviewer model | |
| Vision model | |
| Inventory/market snapshots | |
| Search/tool policy | |
| Timeout/retry | |

## Metrics

| Metric | Baseline pass/applicable | Candidate pass/applicable | Delta |
|---|---:|---:|---:|
| resultValid | | | |
| routeCorrect | | | |
| calculationCorrect | | | |
| noRepeatedQuestions | | | |
| noUnsupportedPromises | | | |
| groundedSources | | | |
| reviewerBlockedUnsafe | | | |
| fallbackCorrect | | | |

## Latency

| Variant | n | median | p95 | min | max |
|---|---:|---:|---:|---:|---:|
| | | | | | |

## Failures

| Case | Variant | Critical | Metric | Evidence | Canonical owner |
|---|---|---|---|---|---|
| | | | | | |

## Decision

- Verdict: accept/revise/reject
- Target effect:
- Safety:
- Trade-offs:
- Deterministic tests:
- Not run:
- Follow-up:
```
</template>

<usage>
Не удалять failures из отчёта после выбора verdict. Указывать denominator и case ids; общий процент без разбивки не является достаточным доказательством.
</usage>
