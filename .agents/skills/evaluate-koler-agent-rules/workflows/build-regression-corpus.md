<objective>
Построить фиксированный, обезличенный и сбалансированный корпус, который воспроизводит canonical routes и найденные ошибки.
</objective>

<required_reading>
Прочитать:

- `../references/result-contract.md`
- `../references/model-roles.md`
- `../references/eval-rubric.md`
- `../references/data-and-privacy.md`
- `../templates/eval-case.md`
</required_reading>

<process>
1. Назначить corpus id/version и цель; не менять version после начала comparison.
2. Взять canonical synthetic cases из проекта и только необходимые обезличенные incidents.
3. Покрыть green/yellow/red, fence, main shortage КР-001 2 000/300/1 700, обезличенный secondary/legacy 620/420/260/150/700, unknown SKU, shortage+special term, sources, timeout/retry, vision и reviewer failure.
4. Для каждого case сохранить immutable input, attachment class, snapshots, opened URLs, expected route, applicable metrics и canonical evidence.
5. Получить expected расчёты существующим engine/guard/supplier helper, не ручной копией model result.
6. Добавить пары:
   - факт указан / тот же факт отсутствует;
   - URL открыт / URL только заявлен;
   - supplier stock достаточен / недостаточен;
   - reviewer approves / reviewer returns blocking issue;
   - primary timeout / non-timeout error.
7. Проверить дубликаты и leakage между train/example text и holdout cases.
8. Запустить readiness script и соответствующие deterministic tests.
</process>

<corpus_manifest>
Manifest фиксирует:

- id, version, createdAt и purpose;
- provenance/data class;
- case ids и families;
- hash или точные versions fixtures, prompts и guard;
- expected values с canonical evidence;
- applicable metrics;
- запрещённые данные и выполненную sanitization check.
</corpus_manifest>

<guardrails>
- Не добавлять raw production records.
- Не использовать текущий candidate output как expected.
- Не удалять failed cases после просмотра результата.
- Не включать hidden reasoning.
</guardrails>

<success_criteria>
- Все обязательные families представлены.
- Expected route и числа проверяемы независимо.
- Corpus immutable в пределах comparison.
- Каждый case безопасен для выбранного execution environment.
</success_criteria>
