<objective>
Изменить bridge, queue или model chain без двойной обработки job и скрытого timeout/retry drift.
</objective>

<required_reading>
Прочитать:

- `../references/system-map.md`
- `../references/invariants.md`
- `../references/test-map.md`
- `../templates/change-impact.md`
</required_reading>

<process>
1. Построить timeout budget для vision, primary search, offline retry, reviewer, API и termination grace.
2. Сравнить worst-case critical path с processing lease.
3. Если path может превысить lease, добавить per-job renewal/fencing либо увеличить lease с доказательством recovery bound.
4. Проверить atomic claim, completion CAS, retry cardinality и requeue.
5. Смоделировать два bridge, restart, stalled model, network timeout, malformed output и reviewer failure на fake clock/recorded fixtures.
6. Проверить, что один job получает максимум один terminal result и history source key.
7. Проверить temp permissions/cleanup и SIGTERM behavior без реальных моделей.
8. Обновить operator recovery, если observable fallback меняется.
</process>

<validation>
Отчёт содержит численную таблицу budget/lease и результаты two-worker simulation. Глобальный heartbeat не считается job renewal без явной связи с claimed order.
</validation>

<success_criteria>
- Worst-case path защищён lease/fencing.
- Duplicate terminal result невозможен в тесте.
- Retry ограничен и тип ошибки не теряется.
- Reviewer failure остаётся ручной проверкой.
- Временные файлы удаляются.
</success_criteria>
