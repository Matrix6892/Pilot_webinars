<objective>
Эволюционировать D1 без drift между Drizzle, migrations, runtime bootstrap и уже опубликованной старой базой.
</objective>

<required_reading>
Прочитать:

- `../references/system-map.md`
- `../references/invariants.md`
- `../references/test-map.md`
- `../templates/change-impact.md`
</required_reading>

<process>
1. Найти всех readers/writers поля, включая stored JSON, snapshots, history и CSV.
2. Обновить `db/schema.ts`.
3. Создать additive migration стандартной командой проекта; не редактировать старую применённую migration.
4. Синхронизировать runtime create/compat DDL в `db/index.ts`.
5. Сравнить columns, nullability, defaults, checks, indexes и unique constraints трёх представлений.
6. Добавить migration replay для empty DB и каждой поддерживаемой old DB.
7. Проверить idempotent parallel startup и backward decoding старых JSON rows.
8. Обновить документацию данных и hosting/package migration contract.
9. Не применять migration к production без отдельного rollout/backup/verification запроса.
</process>

<validation>
Проверить итоговые `sqlite_master`, `PRAGMA table_info`, `index_list` и `index_info`, а не только наличие выбранной колонки.
</validation>

<success_criteria>
- Empty и old database приходят к совместимой схеме.
- Повторная инициализация безопасна.
- Runtime и generated migrations не расходятся.
- Старые rows читаются.
- Production migration не выполнена неявно.
</success_criteria>
