<objective>
Зафиксировать инварианты, нарушение которых делает изменение «Колера» небезопасным даже при зелёных unit-тестах.
</objective>

<agent_invariants>
- Model output не доверяется до `isCompleteAgentResult` и нормализации.
- Внешний факт влияет на решение только после открытия соответствующего URL.
- MiMo описывает видимое и не определяет материал, размеры, расход или пригодность.
- DeepSeek V4 Flash выполняет отдельный второй review-вызов без инструментов; ошибка review ведёт к ручной проверке.
- GPT-5.6 Sol не обрабатывает рабочие заказы.
- Клиентский текст не раскрывает модели, prompts, внутренние роли и служебный путь.
- Товар, цена, остаток и полномочия проверяются программно.
</agent_invariants>

<order_invariants>
- Изменение карточки доступно владельцу action key либо администратору.
- Переход разрешён только из ожидаемого состояния.
- Compare-and-set включает факты, от которых зависит решение: status, result/snapshot/conversation, round и terminal markers.
- Карточка, audit event и result history фиксируют один логический переход согласованно.
- Повторный конкурентный запрос возвращает конфликт и не создаёт второй эффект.
- `approve`, `reserve` и `send` повторно сверяют выбранный товар и поставщика.
- `sent` терминален.
- Retry сохраняет id, переписку, снимок, прежние решения и историю.
- Пересчёт создаёт новый round/result, сохраняя предыдущую версию.
- Запись резерва и отправки не заявляет фактическую ERP/email интеграцию.
</order_invariants>

<api_invariants>
- Auth выполняется до side effect.
- Размер тела ограничивается до полной материализации JSON/FormData, включая отсутствие `Content-Length`.
- Payload проверяется по shape, type, length и numeric range.
- Mutating public route имеет rate limit с понятным `Retry-After`.
- Error contract использует стабильный status и безопасный текст.
- Cache policy задан явно для чувствительных и публичных ответов.
- Секреты, action keys и hashes не попадают в логи, ledger и ответы, кроме выдачи нового action key его создателю.
- Production POST/PATCH/DELETE не используется в диагностике.
</api_invariants>

<bridge_invariants>
- Claim одного job атомарен.
- Processing lease длиннее worst-case model chain либо продлевается per job.
- Heartbeat процесса не считается renewal конкретного job без обновления lease.
- Timeout retry выполняется не более одного раза; другой тип ошибки не маскируется retry.
- Два bridge или restart не создают два terminal result/history.
- Reviewer failure остаётся fail-closed.
- Временные prompt/image файлы имеют закрытые права и удаляются.
- Тесты bridge используют fake token и recorded model fixtures.
</bridge_invariants>

<schema_invariants>
- `db/schema.ts`, итог всех `drizzle/*.sql` и runtime DDL в `db/index.ts` описывают совместимый итог.
- Изменение старой базы additive и idempotent, пока не согласован отдельный destructive rollout.
- Проверяются пустая база и база на каждой поддерживаемой старой версии.
- Index/check/default/nullability согласованы во всех представлениях.
- Старые JSON rows декодируются безопасно.
- Уникальный `source_key` не допускает повтор history одного логического шага.
- Миграции не применяются к production автоматически.
</schema_invariants>

<scenario_invariants>
- Canonical числа выводятся из fixtures и engine, а не копируются в новый код.
- `.example` не включает публичный поиск.
- Реальный URL используется только в сценарии, где поиск ожидается.
- Аналоги соблюдают назначение, поверхность и цвет.
- Supplier ranking: сначала полный дефицит, затем меньший срок, затем меньшая цена.
- Изменение demo baseline сопровождается обновлением UI presets, tests и operator docs.
</scenario_invariants>

<success_criteria>
- Выбранный workflow перечисляет проверенные инварианты.
- Отклонение от инварианта явно названо и одобрено до реализации.
- Каждый новый инвариант имеет executable regression coverage.
</success_criteria>
