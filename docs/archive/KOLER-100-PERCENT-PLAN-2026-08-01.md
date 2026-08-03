# «Колер»: спецификация дожима до webinar GO

> Исторический план от 1 августа 2026 года. Не является активным статусом,
> операторским runbook или источником текущего runtime-контракта.

Редакция: 1 августа 2026 года.

## Что уже сделано

- Свободный ввод всегда идёт в live LLM path; recorded replay доступен только
  как явно выбранный и подписанный сценарий.
- `AgentResult` v2 объединяет intent, evidence, assumptions, vision, estimates,
  supplier leads и уровень обязательства.
- Складской дефицит считается программно. Главный сценарий: 2 000 − 300 =
  1 700 кг, итог 718 400 ₽.
- Claim/lease fencing, renewal, guarded terminal writes, UI reconciliation и
  общий deadline 700 секунд реализованы и имеют deterministic tests.
- Зафиксирован blind corpus из десяти вопросов с подковыркой и общий стандарт
  шести качеств сильного сотрудника.

## Что осталось до GO

1. Не позволить model-authored target ambiguity спорить со свежим явным
   выбором клиента или обходить reviewer.
2. Не позволить произвольному claim модели превратить человека или поверхность
   тела в строительное основание.
3. Свести vision человека к privacy-neutral наблюдению без личности,
   отношений, возраста, пола и демографии.
4. Связать web-claim не только с открытым URL, но и с ограниченным
   наблюдаемым содержимым открытой страницы.
5. Проверить lifecycle и UI/lease после сквозных правок, включая конкурентные
   и fault-injection сценарии.
6. Сделать JTBD scorer чувствительным к холодному blocker-вопросу и общим
   фразам без evidence-bound следующего действия.
7. Пройти полный deterministic gate и обязательный live gate; до этого статус
   стенда остаётся `NO-GO` независимо от среднего recorded score.

## Архитектурный принцип

LLM отвечает за понимание свободного смысла, поиск, инициативу и человеческую
форму ответа. Программа не пытается повторно понять письмо узким парсером: она
проверяет только структуру, доверие к evidence, арифметику, каталог, snapshots,
полномочия, lifecycle и безопасность.

Порядок доверия:

1. свежий явный текст клиента;
2. сохранённое нейтральное vision-наблюдение;
3. внутренний versioned snapshot;
4. ограниченное наблюдаемое содержимое успешно открытой публичной страницы;
5. допущение модели, которое никогда само не создаёт точное коммерческое
   обязательство.

Единственный blocker клиенту — реальная неоднозначность объекта действия.
Остальные неизвестные становятся диапазоном, допущением, внутренним действием
или вариантом руководителю.

## Модели и роли

| Контур | Каноническая роль | Правило принятия |
|---|---|---|
| Оркестрация разработки | GPT-5.6 Sol | Декомпозиция, интеграционная приёмка и итоговый gate |
| Реализация узких задач | Hermes OAuth `gpt-5.6-luna`, effort `max` | Засчитывается только usage-report `openai-codex/gpt-5.6-luna` и root-перепроверка |
| Runtime primary сейчас | официальный DeepSeek API `deepseek-v4-flash`, variant `max` | Подключён как default; выпуск подтверждается frozen/live gate |
| Runtime primary baseline | OpenCode Go `deepseek-v4-pro`, variant `max` | Резерв для парного сравнения и rollback |
| Runtime reviewer | отдельный DeepSeek Pro/max call | Не заменяется тем же Flash-run и fail-closed при недоступности |
| Vision | MiMo | Только видимые факты, без variant и личных выводов |

Flash 0731 не становится оркестратором репозитория автоматически. На этапе
подготовки Sol остаётся единственным интегратором, Luna выполняет узкие code
slices, а Flash можно использовать как независимого adversarial/runtime
кандидата. Две модели не редактируют один файл параллельно.

## Семь Luna-задач

Все задачи работают в общем dirty worktree, используют `PONYTAIL FULL`, не
добавляют зависимости, не создают scenario regex, не читают секреты, не
commit/push/deploy и не запускают production.

### 1. Lifecycle и supplier plan

Ownership: `app/api/orders/route.ts`, `tests/flow-integrity.test.mjs`.

- Сохранять supplier plan при любом option без фактической смены SKU.
- Подтверждать план только для `confirm-supplier-plan`.
- Удалять stale plan только при реальной product alternative.
- Валидировать post-mutation v2 до любых history/order writes.
- Не создавать `ready_to_send` при `commitment=none`.

Приёмка: custom option, confirm, SKU replacement и invalid-result mutant.

### 2. Сквозной `AgentResult` v2

Ownership: type/API/ledger consumers и contract tests, без изменения guard.

- Один persisted/decoded/projected контракт.
- Legacy `missing` остаётся compatibility marker, не новой ambiguity.
- Malformed partial result fail-closed и не утекает в UI/CSV.
- Все v2 поля переживают JSON round-trip.

### 3. Intent и human/product boundary

Ownership: guard, sales/reviewer prompts и guard/holdout tests.

- Последний explicit message target приоритетнее vision и model ambiguity.
- Ambiguity не получает `review-skipped`.
- После ответа blocker тот же вопрос не повторяется.
- Произвольный claim модели не подтверждает substrate compatibility.
- Человеческая цель не получает строительный SKU; настоящий неодушевлённый
  substrate продолжает получать предложение.

### 4. Privacy, injection и web page provenance

Ownership: upload guard, bridge web records, guard provenance и их tests.

- Человек в vision хранится нейтрально.
- Инструкции из изображения/страницы остаются недоверенным content.
- Completed `public_webfetch` сохраняет URL, openedAt и bounded sanitized
  excerpt/digest; search snippet не считается evidence.
- Web-claim допускается только когда связан с excerpt; нерелевантная открытая
  страница не подтверждает культурный или supplier claim.

### 5. Lease, deadline и UI recovery

Ownership: bridge, client request helper, order UI и recovery tests.

- 700 секунд — общий deadline, не сумма независимых timeout.
- 90-секундная lease обновляется каждые 30 секунд и fence проверяет claim.
- Нет overlapping polls и применения ответа старой generation.
- Mutation всегда завершается reread/reconciliation.
- Cleanup failure не оставляет Promise pending; один terminal result/history.

### 6. JTBD scorer и trick corpus

Ownership: eval runner, frozen fixtures и eval tests.

- Rapport требует наблюдаемой mirror/calibration clause, а не любого текста.
- Ownership/next action требуют конкретного evidence-bound действия и actor.
- Guard-created fallback не получает credit за raw model quality.
- Negative mutations снижают только соответствующее качество.
- Все десять families и paraphrases проверяются по структуре, не exact copy.

### 7. Интеграционный release audit

Read-only ownership всего diff после завершения ролей 1–6.

- Сопоставить producer → guard → persistence → API → UI → ledger.
- Запустить targeted mutants, полный gate, contract/eval/webinar scripts.
- Проверить отсутствие секретов, новых dependencies, scenario hardcode и
  случайных файлов.
- Любой P0/P1 или неподтверждённый live gate даёт `NO-GO` с точным rework.

## Как принимается каждая Luna-задача

Отчёт воркера сам по себе ничего не закрывает. Оркестратор обязан:

1. проверить usage-report модели и успешное завершение;
2. просмотреть фактический diff и соблюдение ownership;
3. воспроизвести исходный дефект и запустить обязательные мутанты;
4. выполнить соседние contract tests, а не только тест воркера;
5. проверить совокупный state graph и один канонический источник истины;
6. при провале вернуть той же роли минимальный counterexample и ожидаемый
   invariant; повторно принять с нуля.

## Flash 0731: подключение и решение

Секрет хранится только в `.env.local` как `DEEPSEEK_API_KEY`; значение не
попадает в docs, Git, prompts, usage-report или командную строку. После
появления ключа сначала запрашивается фактический provider catalog. Alias и
дата модели фиксируются только по ответу provider, а не по предположению.

Flash уже подключён как runtime primary, но принимается для вебинара только
если на одном frozen corpus и неизменных
snapshots/tools/guard/reviewer:

- hard invariants: 100% в каждом run;
- critical safety failures: 0;
- six-quality JTBD: не ниже 90%;
- четыре webinar families: три успешных live-run подряд;
- latency каждого run: не выше 700 секунд;
- источник результата и fallback явно сохранены.

Если Flash не проходит, Pro остаётся primary. Независимый reviewer остаётся
Pro/max в обоих вариантах.

## Финальный gate

```bash
npm run lint
npm run typecheck
node --test tests/*.test.mjs
npm run build
node .agents/skills/audit-koler-demo-contract/scripts/audit-contract.mjs --format=console
node .agents/skills/evaluate-koler-agent-rules/scripts/check-eval-readiness.mjs
node .agents/skills/manage-koler-changes/scripts/check-change-contract.mjs
node .agents/skills/operate-koler-webinar/scripts/preflight.mjs
node .agents/skills/operate-koler-webinar/scripts/check-main-scenario.mjs
git diff --check
```

`GO` дополнительно требует live manifest 4 × 3. Локальный зелёный gate без
него означает только deterministic readiness, а не готовность вебинара.
