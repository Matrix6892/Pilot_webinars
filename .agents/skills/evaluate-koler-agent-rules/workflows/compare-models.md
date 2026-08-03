<objective>
Сравнить primary или reviewer models на одном контракте, отделив качество модели от search, guard, snapshots и fallback.
</objective>

<required_reading>
Прочитать:

- `../references/result-contract.md`
- `../references/model-roles.md`
- `../references/eval-rubric.md`
- `../references/data-and-privacy.md`
- `../templates/comparison-report.md`
</required_reading>

<process>
1. Указать роль сравнения: primary, reviewer или vision. Не смешивать роли в одной aggregate.
2. Зафиксировать corpus, prompt, program guard, reviewer/primary counterpart, snapshots, tool policy, timeout и retry.
3. Проверить, что обе модели разрешены выбранным runtime и данные можно им передавать.
4. Выполнить paired cases одинаковое число раз и сохранить порядок/seed, если runtime его поддерживает.
5. Измерить raw contract validity, guarded result, route, calculations, questions, promises, sources, reviewer blocking, fallback и latency.
6. Разобрать disagreements по case id и определить, какой canonical owner даёт ground truth.
7. Отдельно показать:
   - сколько ошибок исправил guard;
   - сколько unsafe drafts заблокировал reviewer;
   - timeout и fallback frequency;
   - median/p95 latency.
8. Применить decision rule из rubric; более быстрая модель не выигрывает при safety regression.
</process>

<guardrails>
- Не запускать внешние модели без явного разрешения пользователя.
- Не передавать production data, secrets или hidden reasoning.
- Не подменять независимый reviewer той же сравниваемой primary run без явного отдельного experiment.
- Один успешный live result не является сравнением.
- Стоимость и rate limits указать до крупного прогона.
</guardrails>

<success_criteria>
- Варианты отличаются только заявленной model role.
- Все disagreements имеют ground-truth resolution.
- Safety, quality, latency и fallback показаны отдельно.
- Итог не расширяет runtime catalog автоматически.
</success_criteria>
