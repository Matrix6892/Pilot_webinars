<objective>
Выбирать проверки пропорционально изменению и не подменять executable behavior поиском строк в исходниках.
</objective>

<baseline>
Всегда выполнить:

```bash
npm run lint
npm run typecheck
node --test tests/*.test.mjs
npm run build
```
</baseline>

<targeted_tests>
| Тип изменения | Минимальные targeted suites | Дополнительное доказательство |
|---|---|---|
| Agent contract/guard | `agent-guard`, `model-role-honesty`, `vision-bridge` | malformed/partial result и reviewer rejection |
| Deterministic rule | `demo-engine`, `order-facts`, `supplier-plan` | before/after fixture с точными числами |
| State transition | `flow-integrity`, `inventory-freshness` | два конкурентных запроса и injected failure |
| API/auth/upload | `flow-integrity`, `vision-upload`, `vision-download` | executable malformed, oversized, forged and unauthenticated requests |
| Bridge/lease | `vision-bridge`, `vision-download` | fake two-worker clock, restart and timeout simulation |
| D1/schema | `flow-integrity` migration replay | empty DB и supported old DB |
| Ledger/event | `ledger-export`, `rendered-html` | exact UI row and CSV formula-safe row |
| Catalog/scenario | `demo-engine`, `order-facts`, `supplier-plan`, `rendered-html` | canonical scenario checker |
</targeted_tests>

<test_quality>
- Regression test должен воспроизводить наблюдаемую ошибку и падать без изменения.
- Для route behavior импортировать/запускать handler или realistic Worker harness; regex-source test остаётся дополнительным wiring check.
- Для concurrency использовать контролируемые параллельные запросы к ephemeral DB.
- Для fault injection проверять отсутствие partial write.
- Для model behavior использовать recorded JSON и отдельно помеченный optional live eval.
- Не подключать тесты к production D1, R2, queue или моделям.
</test_quality>

<verification_report>
Записать:

- targeted команды и результаты;
- полный gate;
- что не запускалось и почему;
- ожидаемые fallback/rollback;
- чистоту `git status` относительно согласованного diff.
</verification_report>

<success_criteria>
- Проверки покрывают изменённую границу выполнения.
- Хотя бы один тест доказывает поведение, а не наличие текста.
- Production state и внешние платные модели не затронуты.
</success_criteria>
