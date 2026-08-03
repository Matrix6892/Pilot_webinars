---
name: evaluate-koler-agent-rules
description: Анализирует результаты заказов и доказательно проверяет изменения sales, reviewer и vision rules стенда «Колер». Использовать при неверной маршрутизации, повторных вопросах, неподтверждённых обещаниях, изменении prompt или смене модели.
---

<objective>
Превращать наблюдаемые ошибки и предлагаемые изменения правил «Колера» в воспроизводимую оценку на фиксированном корпусе, не подменяя доказательство одним удачным live-ответом.

Skill анализирует только явно выбранные демонстрационные, синтетические или обезличенные данные. Он не извлекает скрытые рассуждения моделей, не запускает модели и не меняет рабочие prompts без отдельного запроса пользователя.
</objective>

<essential_principles>
- Сначала зафиксировать дефект, baseline и ожидаемое наблюдаемое поведение.
- Сравнивать один фактор за итерацию: правило, prompt, guard, модель или timeout policy.
- Использовать одинаковые входы, снимки склада и рынка, источники и reviewer policy для всех вариантов.
- Проверяемые бизнес-инварианты переносить в deterministic guard и executable test.
- Считать model output недоверенным до нормализации и `isCompleteAgentResult`.
- Не считать источник подтверждённым, пока соответствующий URL не открыт успешным web action.
- Не сохранять и не запрашивать chain-of-thought; достаточно входа, результата, событий, вердикта reviewer, timing и видимых правок.
- Critical safety failure блокирует кандидат независимо от средней метрики.
- Live-модели, платные вызовы и production-ledger требуют отдельного явного разрешения.
- Synthetic live manifest with recorded vision is not a MiMo run and never satisfies the live gate alone.
</essential_principles>

<quick_start>
1. Прочитать `references/result-contract.md`, `references/model-roles.md`, `references/eval-rubric.md` и `references/data-and-privacy.md`.
2. Проверить, что в проекте доступны необходимые контракты и regression anchors:

```bash
node .agents/skills/evaluate-koler-agent-rules/scripts/check-eval-readiness.mjs
```

3. Выбрать workflow по цели оценки.
4. Зафиксировать corpus manifest и baseline до изменения.
5. После прогона проверить и агрегировать JSON-результаты:

```bash
node .agents/skills/evaluate-koler-agent-rules/scripts/score-eval.mjs path/to/results.json
```
</quick_start>

<activation>
Skill может быть вызван двумя способами:

- пользователь явно называет `evaluate-koler-agent-rules`;
- агент выбирает его автоматически, когда запрос соответствует `description`.

Обнаружение skill не запускает scripts или модели в фоне. Каждый script и каждый live eval выполняются только как явный шаг текущей задачи с учётом разрешений пользователя.
</activation>

<routing>
| Цель | Workflow |
|---|---|
| Найти повторные вопросы, правки, unsafe promises и маршруты в выбранных событиях | `workflows/analyze-ledger.md` |
| Превратить инциденты и canonical cases в фиксированный обезличенный набор | `workflows/build-regression-corpus.md` |
| Доказать пользу изменения sales/reviewer/vision rule или deterministic guard | `workflows/compare-rule-change.md` |
| Сравнить Flash/Pro или другую явно выбранную модель на одном контракте | `workflows/compare-models.md` |

Если задача включает и поиск дефектов, и проверку исправления, сначала выполнить анализ журнала, затем построение корпуса, затем comparison. Не менять корпус после просмотра результатов кандидата без новой версии manifest.
</routing>

<required_corpus_families>
- полный green order;
- yellow clarification;
- red manager decision;
- фото забора до и после уточнения;
- главный shortage-сценарий КР-001 2 000/300/1 700 с supplier snapshot;
- обезличенный сценарий 620/420/260/150/700 только как secondary/legacy regression, без active named preset;
- неизвестный SKU;
- дефицит вместе с особым коммерческим условием;
- подтверждённый и неподтверждённый web source;
- timeout и единственный offline retry;
- отказ vision;
- отказ или блокировка reviewer.
</required_corpus_families>

<reference_index>
- `references/result-contract.md` — наблюдаемый `AgentResult` и владельцы ground truth.
- `references/model-roles.md` — допустимые роли MiMo, Flash, Pro и GPT-5.6 Sol.
- `references/eval-rubric.md` — метрики, critical failures и правила сравнения.
- `references/data-and-privacy.md` — допустимые данные, обезличивание и запрет скрытых рассуждений.
- `templates/eval-case.md` — manifest одного воспроизводимого случая.
- `templates/eval-results.example.json` — минимальный валидный input для scorer.
- `templates/comparison-report.md` — итог before/after или model comparison.
</reference_index>

<workflows_index>
| Workflow | Результат |
|---|---|
| `workflows/analyze-ledger.md` | Evidence table наблюдаемого дефекта без изменения записей |
| `workflows/build-regression-corpus.md` | Версионированный manifest с ground truth и provenance |
| `workflows/compare-rule-change.md` | Before/after report и решение accept/reject |
| `workflows/compare-models.md` | Парное сравнение качества, safety, latency и fallback |
</workflows_index>

<validation>
Минимальный deterministic gate для изменения правил:

```bash
node .agents/skills/evaluate-koler-agent-rules/scripts/check-eval-readiness.mjs
node --test tests/agent-guard.test.mjs tests/demo-engine.test.mjs tests/order-facts.test.mjs tests/supplier-plan.test.mjs tests/vision-bridge.test.mjs
npm run lint
npm run typecheck
node --test tests/*.test.mjs
npm run build
```

Live eval является дополнением, а не заменой deterministic tests. В отчёте явно указать, какие команды и внешние вызовы не выполнялись.
</validation>

<success_criteria>
- Дефект связан с конкретными входами, видимым результатом и ожидаемым инвариантом.
- Corpus фиксирован, версионирован и содержит все затронутые families.
- Все варианты получают одинаковые входы и ground truth.
- Измерены валидность `AgentResult`, route, расчёты, повторные вопросы, unsupported promises, sources, reviewer blocking, latency и fallback.
- Ни один critical safety failure не скрыт средней метрикой.
- Результат воспроизводим recorded fixtures без production state.
- Программные правила и regression tests обновляются отдельно от prompt, когда инвариант можно проверить детерминированно.
- Исходные записи сохранены; в отчёте нет секретов, action keys, персональных данных или скрытых рассуждений.
</success_criteria>
