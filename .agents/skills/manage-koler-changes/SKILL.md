---
name: manage-koler-changes
description: Планирует, реализует и проверяет сквозные изменения стенда «Колер». Использовать при изменении API, состояния заказа, AgentResult, D1, prompts, каталога, сценария или журнала.
---

<objective>
Проводить изменения «Колера» через все затронутые слои без рассинхронизации быстрого и живого режимов, модели, программных ограничений, API, D1, интерфейса, журнала, тестов и документации.

Skill работает в режиме, который запросил пользователь: анализирует, планирует, реализует или ревьюит. Публикация и изменения production-состояния не входят в обычное изменение и требуют отдельного явного запроса.
</objective>

<essential_principles>
- Сначала определить наблюдаемое поведение и построить impact map, затем менять файлы.
- Результат модели недоверенный. `AgentResult` принимает только программная валидация и нормализация.
- Цена, склад и предложения поставщиков берутся из сохранённого снимка; свежесть повторно проверяется перед `approve`, `reserve` и `send`.
- Изменение состояния требует авторизации, допустимого исходного состояния, compare-and-set guard и согласованной записи карточки, события и истории.
- Один конкурентный запрос меняет состояние; остальные получают конфликт, а не дублируют действие.
- Старые решения, письма, снимки и наблюдаемые события сохраняются.
- Быстрый и live-режимы используют совместимый контракт и одинаковые бизнес-границы.
- Новая event stage получает понятное представление в интерфейсе и CSV.
- Проверяемый бизнес-инвариант закрепляется программой и тестом, а не только prompt.
- Не запускать реальные модели, production-мутации, миграции или deploy без отдельного разрешения.
</essential_principles>

<quick_start>
1. Прочитать `references/system-map.md`, `references/invariants.md` и `references/test-map.md`.
2. Выбрать workflow по затронутой границе.
3. Заполнить `templates/change-impact.md` до редактирования.
4. Получить статический baseline:

```bash
node .agents/skills/manage-koler-changes/scripts/check-change-contract.mjs
```

5. Добавить executable regression test, выполнить изменение минимальным согласованным набором и повторить проверки.
</quick_start>

<intake>
Определить intent из запроса без лишнего вопроса:

- структура или семантика результата модели;
- действие или состояние карточки;
- HTTP/API/auth/upload boundary;
- очередь, timeout, retry или bridge;
- таблица, колонка, индекс или сериализация D1;
- каталог, товар, сценарий или ожидаемые числа;
- событие, история, UI или CSV.

Спросить уточнение только если неизвестное наблюдаемое поведение существенно меняет архитектуру или внешние обязательства.
</intake>

<routing>
| Изменение | Workflow |
|---|---|
| `AgentResult`, sales/reviewer/vision prompt, guard, model role | `workflows/agent-contract.md` |
| action, status, retry, approval, reserve, send, recalculation | `workflows/order-lifecycle.md` |
| route, method, auth, body validation, rate limit, cache, upload | `workflows/api-boundary.md` |
| bridge, queue, claim, heartbeat, timeout, retry, model chain | `workflows/bridge-lease.md` |
| D1 table, column, index, migration, stored JSON | `workflows/schema-evolution.md` |
| product, inventory seed, supplier, scenario, canonical number | `workflows/catalog-scenario.md` |
| event stage, result history, UI activity, ledger or CSV | `workflows/observable-event.md` |

Если изменение пересекает несколько строк, выполнить каждый соответствующий workflow, но сохранить один общий impact map и один итоговый verification report.
</routing>

<reference_index>
- `references/system-map.md` — владельцы данных и карта сквозных контрактов.
- `references/invariants.md` — обязательные бизнес-, security- и concurrency-инварианты.
- `references/test-map.md` — проверки по типу изменения.
- `templates/change-impact.md` — формат impact map и итоговой передачи.
</reference_index>

<workflows_index>
| Workflow | Назначение |
|---|---|
| `workflows/agent-contract.md` | Синхронизировать модельный контракт и программные guardrails |
| `workflows/order-lifecycle.md` | Безопасно изменить state machine |
| `workflows/api-boundary.md` | Защитить HTTP-границу и негативные сценарии |
| `workflows/bridge-lease.md` | Проверить очередь, lease, timeouts и recovery |
| `workflows/schema-evolution.md` | Согласовать три представления D1 |
| `workflows/catalog-scenario.md` | Изменить fixtures и производные числа |
| `workflows/observable-event.md` | Провести событие через историю, UI и CSV |
</workflows_index>

<validation>
Минимальный локальный gate после изменения:

```bash
npm run lint
npm run typecheck
node --test tests/*.test.mjs
npm run build
node .agents/skills/manage-koler-changes/scripts/check-change-contract.mjs
git status --short
```

Запускать более узкие проверки из выбранного workflow раньше полного gate. Не использовать formatter с записью без просмотра diff.
</validation>

<success_criteria>
- Наблюдаемое поведение и границы изменения сформулированы.
- Impact map охватывает все читатели, писатели и производные представления.
- Быстрый и live-пути совместимы либо различие явно принято.
- Security, freshness, concurrency, history и idempotency инварианты сохранены.
- Добавлен executable regression test, который падает без изменения.
- Полный локальный gate проходит.
- Документация описывает фактическое поведение и не преувеличивает интеграции.
- Diff не содержит случайных файлов, секретов или неразрешённого deploy.
</success_criteria>
