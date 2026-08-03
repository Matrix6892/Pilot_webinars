<objective>
Изменить action, status, retry, recalculation, approval, reserve или send как атомарный и наблюдаемый переход state machine.
</objective>

<required_reading>
Прочитать:

- `../references/system-map.md`
- `../references/invariants.md`
- `../references/test-map.md`
- `../templates/change-impact.md`
</required_reading>

<process>
1. Нарисовать старый и новый переход: source status, guard, target status, terminal behavior.
2. Перечислить authorization, payload validation, freshness checks и compare-and-set поля.
3. Спроектировать одну согласованную транзакцию/batch для order update, event и result history.
4. Определить idempotency key/source key и ответ второго конкурентного запроса.
5. Проверить сохранение id, action hash, conversation, round, snapshot, prior result и sent marker.
6. Добавить executable success, invalid-state, stale-fact, concurrent duplicate и injected-failure tests на ephemeral DB.
7. Провести состояние через UI labels, activity history, daily stats и CSV.
8. Выполнить targeted и полный gate.
</process>

<validation>
Обязательные сценарии:

- один из двух одинаковых запросов успешен, второй получает `409`;
- injected failure не оставляет state без audit row;
- stale inventory/supplier требует recalculation;
- retry сохраняет прошлые данные;
- `sent` не открывает новый mutating path.
</validation>

<success_criteria>
- State graph однозначен.
- Переход авторизован, guarded и атомарен.
- Повтор не дублирует event/history.
- История до и после пересчёта доступна.
- UI и ledger объясняют переход человеческим текстом.
</success_criteria>
