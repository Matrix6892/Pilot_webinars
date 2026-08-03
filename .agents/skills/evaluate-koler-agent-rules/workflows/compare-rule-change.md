<objective>
Доказать, что одно изменение sales, reviewer, vision rule или deterministic guard исправляет target defect без safety-регрессии.
</objective>

<required_reading>
Прочитать:

- `../references/result-contract.md`
- `../references/model-roles.md`
- `../references/eval-rubric.md`
- `../templates/comparison-report.md`
</required_reading>

<process>
1. Сформулировать hypothesis: один defect, один изменяемый factor, target cases и expected metric.
2. Зафиксировать baseline commit/content hash, corpus version, model ids, snapshots, timeout/retry и reviewer policy.
3. Выполнить baseline на всём corpus либо использовать совместимые recorded baseline results.
4. Изменить только выбранный factor.
5. Сначала выполнить deterministic regression tests, затем тот же corpus в том же порядке и режиме.
6. Сохранить raw JSON, normalized result, reviewer outcome, observable stages, timing и metric evidence.
7. Агрегировать результаты `score-eval.mjs`; вручную проверить все failures и critical cases.
8. Решить:
   - accept — target улучшен, safety не ухудшена;
   - revise — target улучшен, но есть объяснимый non-critical trade-off;
   - reject — critical failure, safety regression или недоказанный эффект.
9. Если правило проверяемо программой, перенести его в guard/test; prompt оставить объяснением, а не единственной защитой.
</process>

<controls>
- Не менять model и prompt одновременно.
- Не обновлять snapshots между baseline и candidate.
- Не давать candidate другой search/tool availability.
- Не скрывать guard corrections: измерять raw и normalized результаты отдельно.
- Stochastic runs использовать с заранее заданным одинаковым числом повторов.
</controls>

<validation>
Выполнить targeted suites затронутого stage и полный gate из `SKILL.md`. Live model run выполняется только по отдельному разрешению.
</validation>

<success_criteria>
- Hypothesis и factor однозначны.
- Baseline и candidate сопоставимы.
- Critical failures равны нулю.
- Target cases улучшены и canonical families не регрессировали.
- Отчёт содержит failed case ids и ограничения.
</success_criteria>
