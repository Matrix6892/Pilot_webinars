<template>
```json
{
  "id": "family-short-name-v1",
  "family": "green|yellow|red|fence|protek|unknown-sku|shortage-special|source|timeout|vision|reviewer",
  "repeat": 1,
  "dataClass": "synthetic|demo|anonymized",
  "provenance": {
    "source": "project fixture or selected record",
    "canonicalEvidence": ["path:line or stable test name"]
  },
  "input": {
    "company": "Синтетическое имя",
    "website": "",
    "subject": "",
    "body": "",
    "attachmentFixture": null
  },
  "snapshots": {
    "inventory": "fixture/version",
    "market": "fixture/version",
    "openedSourceUrls": []
  },
  "expected": {
    "zone": "green|yellow|red",
    "decision": "quote|clarify|escalate",
    "route": "ready|needs_info|manager",
    "product": null,
    "calculation": null,
    "researchChecked": false,
    "reviewerMustBlock": false,
    "fallback": null
  },
  "applicableMetrics": [
    "resultValid",
    "routeCorrect",
    "noRepeatedQuestions",
    "noUnsupportedPromises"
  ],
  "privacyCheck": {
    "containsRealPersonalData": false,
    "containsCredentialsOrActionKeys": false,
    "containsHiddenReasoning": false
  }
}
```
</template>

<usage>
Expected значения заполняются из canonical owners и existing program logic до запуска candidate. Неприменимая метрика отсутствует в `applicableMetrics` и получает `null` в результатах.
</usage>
