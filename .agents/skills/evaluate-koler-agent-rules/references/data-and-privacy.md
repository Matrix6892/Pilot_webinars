<objective>
Ограничить eval данными, которые можно безопасно анализировать, хранить и передавать между моделями.
</objective>

<allowed_inputs>
- сценарии из `data/order-scenarios.ts`;
- fixtures и recorded JSON из `tests/`;
- специально созданные синтетические заявки;
- выбранные демонстрационные ledger rows;
- обезличенные production-like записи только по явному разрешению пользователя;
- подготовленные тестовые изображения, включая demo fence image.
</allowed_inputs>

<excluded_inputs>
- секреты, cookies, bearer tokens, bridge token и environment values;
- order action keys и их hashes;
- необезличенные имена, телефоны, email, адреса, реквизиты и свободный текст реального клиента;
- скрытые рассуждения, scratchpad, chain-of-thought или внутренние model traces;
- данные production D1/R2, если пользователь не выбрал их явно;
- изображения, права и согласие на использование которых неизвестны.
</excluded_inputs>

<minimum_record>
Для воспроизводимости достаточно:

- case id и family;
- обезличенный input;
- version/hash corpus, prompt/rule и guard;
- model id и execution mode;
- сохранённые inventory/market snapshots;
- opened URL list либо явный offline marker;
- raw JSON output без hidden reasoning;
- normalized result, reviewer JSON и observable event stages;
- latency, retry/fallback и metric evidence.
</minimum_record>

<sanitization>
1. Работать с копией выбранного export.
2. Удалить identifiers, credentials и вложения вне eval scope.
3. Заменить реальные компании и людей стабильными synthetic aliases.
4. Сохранить смысл запроса, special terms и ожидаемый route.
5. Проверить текст поиском email, телефонов, токенов, action keys и длинных opaque identifiers.
6. Записать provenance и основание допуска, не сохраняя исходный секрет.
</sanitization>

<retention>
- Не изменять исходный ledger и result history.
- Corpus version immutable; исправление создаёт новую version.
- Не публиковать corpus и отчёт автоматически.
- Удаление или передача данных выполняется только по отдельному запросу пользователя.
</retention>

<success_criteria>
- Каждый case имеет provenance и data class.
- В корпусе нет credentials, action keys и идентифицирующих данных.
- Наблюдаемое доказательство достаточно без скрытых рассуждений.
</success_criteria>
