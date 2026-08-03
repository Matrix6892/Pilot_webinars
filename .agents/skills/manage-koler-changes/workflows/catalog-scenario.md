<objective>
Изменить каталог, поставщиков или сценарии так, чтобы расчётные числа и операторский рассказ оставались производными от fixtures.
</objective>

<required_reading>
Прочитать:

- `../references/system-map.md`
- `../references/invariants.md`
- `../references/test-map.md`
- `../templates/change-impact.md`
</required_reading>

<process>
1. Определить изменяемый fixture и все сценарии, где он участвует.
2. Вычислить ожидаемый результат существующим engine/helper, не ручной копией формулы.
3. Проверить product matching, substrates, environment, colors, packs, price floor и analogue policy.
4. Проверить supplier feasibility/ranking и freshness timestamp.
5. Сверить UI presets, scenario groups, tests, README, webinar map, checklist и operator runbook.
6. Добавить regression на expected route, product, quantities, total, schedule и letter boundary.
7. Запустить canonical scenario checker из operator skill, если он доступен.
</process>

<validation>
Не принимать изменение, если одно canonical число обновлено только в документации или UI. `.example` и реальные domains сохраняют ожидаемое search behavior.
</validation>

<success_criteria>
- Fixtures остаются единственным источником чисел.
- Все производные тесты и operator copy согласованы.
- Green/yellow/red и supplier fallback воспроизводимы.
- Demo data остаётся явно синтетической.
</success_criteria>
