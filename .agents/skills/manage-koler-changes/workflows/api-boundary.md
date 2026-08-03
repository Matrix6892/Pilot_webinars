<objective>
Изменить HTTP route, auth, upload или rate limit с executable негативной проверкой границы.
</objective>

<required_reading>
Прочитать:

- `../references/system-map.md`
- `../references/invariants.md`
- `../references/test-map.md`
- `../templates/change-impact.md`
</required_reading>

<process>
1. Добавить route в матрицу: method, exposure, auth, body bound, validation, rate limit, cache, side effect и error contract.
2. Выполнить auth до side effect и ограничить фактический body до полной материализации.
3. Проверить shape/type/range/length, неизвестные action и malformed encoding.
4. Определить стабильные status/code и `Retry-After`.
5. Проверить cookie/header/token, CSRF для cookie-auth и отсутствие секретов в логах/ответах.
6. Для public read сверить synthetic-data boundary и cache policy.
7. Добавить executable tests: malformed JSON, oversize/chunked body, forged/expired credentials, concurrent limiter и downstream failure.
8. Использовать только ephemeral Worker/D1/R2 doubles; production допускает GET/HEAD probes по отдельному запросу.
</process>

<validation>
Итоговая матрица не содержит mutating route без auth, early body bound, payload validation и явного error/cache behavior.
</validation>

<success_criteria>
- Негативные запросы безопасно отклоняются до side effect.
- Credentials и hashes не раскрываются.
- Rate limit не создаёт неограниченный жизненный цикл keys без cleanup policy.
- Тест запускает handler/harness, а не только ищет строки.
</success_criteria>
