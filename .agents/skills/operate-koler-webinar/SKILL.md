---
name: operate-koler-webinar
description: Проверяет готовность, репетирует и восстанавливает вебинарный стенд «Колер» вокруг главного synthetic shortage-сценария КР-001 2 000/300 кг. Использовать перед эфиром, передачей ведущему или при сбое live bridge, lease, supplier snapshot, ledger или R2.
---
<skill>
  <objective>
    Безопасно определить готовность стенда и провести только явно разрешённую
    репетицию. Main contract — shortage КР-001; старый ПРОТЕК-эпизод — только
    secondary/legacy regression. Не читать secrets, не скрывать runtime drift и
    не подменять live LLM server fast fallback.
  </objective>

  <guardrails>
    <rule priority="critical">Считать любой URL опубликованным стендом и не выполнять запись без явного запроса на конкретную репетицию или восстановление.</rule>
    <rule priority="critical">Обычный preflight без --url выполняет только local/static checks и никогда не читает .env, secret stores, cookies или значения окружения.</rule>
    <rule priority="critical">Preflight и scenario check без --url не выполняют HTTP. URL можно передать только отдельным операторским шагом; методы preflight — только GET/HEAD.</rule>
    <rule priority="critical">Reset без --apply — dry-run. Любой apply требует явного --url, --apply и admin code через stdin либо имя переменной; apply не запускать без отдельной авторизации.</rule>
    <rule priority="critical">Не удалять карточки, события, history, uploads или ledger rows. Не утверждать ERP reserve или email delivery.</rule>
    <rule priority="high">Использовать только synthetic order/photo и не менять цену, каталог или production inventory этим workflow.</rule>
    <rule priority="high">При live failure сохранять тот же order id. Recorded replay — только отдельный явный выбор labeled scenario и никогда не recovery свободного текста.</rule>
  </guardrails>

  <canonical_main_scenario>
    <fact>КР-001, request 2 000 кг, own stock 300 кг, programmatic deficit 1 700 кг.</fact>
    <fact>ПромКолор Опт: snapshot 2 000 кг, 361 ₽/кг, 4 дня, checkedAt 2026-07-31 09:00.</fact>
    <fact>Plan 300 own + 1 700 supplier; route manager/red, blocker null, 2–3 options, followUpActor supplier/internal.</fact>
    <fact>Каноническая own price — 349 ₽/кг; total: 300 × 349 + 1 700 × 361 = 718 400 ₽.</fact>
  </canonical_main_scenario>

  <quick_start>
    <step order="1">Прочитать references/canonical-scenario.md и references/recovery-matrix.md.</step>
    <step order="2">Выполнить local-only <command>node .agents/skills/operate-koler-webinar/scripts/preflight.mjs</command>; HTTP не запускается.</step>
    <step order="3">Выполнить <command>node .agents/skills/operate-koler-webinar/scripts/check-main-scenario.mjs</command>; если проверка обнаружит price drift, результат должен быть NO-GO.</step>
    <step order="4">Для разрешённой репетиции сначала выполнить reset-baseline без --apply и показать dry-run. Apply в обычной проверке запрещён.</step>
    <step order="5">Завершить отчётом NO-GO/GO только по доказательствам, с отдельными runtime conflicts и без скрытого fallback.</step>
  </quick_start>

  <routing>
    <route intent="preflight"><read>workflows/preflight-readonly.md</read><read>references/canonical-scenario.md</read><read>references/recovery-matrix.md</read><run>scripts/preflight.mjs</run></route>
    <route intent="scenario-check"><read>references/canonical-scenario.md</read><run>scripts/check-main-scenario.mjs</run></route>
    <route intent="rehearsal"><read>workflows/rehearse-main-scenario.md</read><read>references/canonical-scenario.md</read><read>references/recovery-matrix.md</read><run condition="explicit-authorization">scripts/check-main-scenario.mjs</run><run condition="explicit-write-authorization">scripts/reset-baseline.mjs --apply</run></route>
    <route intent="recovery"><read>workflows/recover-live-run.md</read><read>references/recovery-matrix.md</read><read>references/canonical-scenario.md</read></route>
    <route intent="restore-baseline"><read>workflows/restore-baseline.md</read><read>references/canonical-scenario.md</read><run condition="explicit-write-authorization">scripts/reset-baseline.mjs --apply</run></route>
  </routing>

  <status_policy>
    <status name="GO">Только после deterministic lint/typecheck/full tests/build, change/eval/audit checks, remote read-only preflight and scenario check, затем deployed runner: девять functional routes и batch из десяти заявок, first processing-stage ≤10 s, p50 ≤180 s, 10/10 useful terminal ≤660 s, без duplicate effects и recorded mixing. Main shortage baseline подтверждён фактически; любой выявленный brief/runtime price drift блокирует GO. Direct model runner остаётся диагностическим и не доказывает deployed JTBD.</status>
    <status name="GO WITH FALLBACK">Допустим только для не-критичного представления вроде задержки Google или недоступного R2 после отдельного явного решения; bridge offline не получает server fast fallback.</status>
    <status name="NO-GO">Не подтверждён main shortage, есть P0/P1 drift, bridge/lease/reviewer/privacy boundary нарушена, mandatory ledger/API недоступен или live gate не выполнен.</status>
  </status_policy>

  <execution_contract>
    <rule>Bundled scripts запускаются через node и находят root относительно import.meta.url.</rule>
    <rule>Сначала local/static checks, затем только явно разрешённые remote GET/HEAD checks, затем отдельный dry-run/apply workflow.</rule>
    <rule>Reset baseline относится только к stock КР-001=300 кг и supplier «ПромКолор Опт»=2 000 кг; цена/срок/каталог не мутируются.</rule>
    <rule>Любую разрешённую запись оборачивать try/finally и не затирать параллельные изменения без caller-visible revision/CAS.</rule>
  </execution_contract>

  <report_template>
    <field name="status">GO, GO WITH FALLBACK или NO-GO.</field>
    <field name="target">Origin без query, credentials и secrets; local-only по умолчанию.</field>
    <field name="evidence">PASS/WARN/FAIL с file:line или read-only endpoint.</field>
    <field name="runtime_conflicts">Отдельно перечислить price/arithmetic/model/scenario drift вне ownership.</field>
    <field name="baseline">КР-001 300 кг и ПромКолор Опт 2 000 кг; не заявлять production mutation.</field>
    <field name="durable_state">Order id/history не удалялись.</field>
    <field name="limitations">Почта/ERP не подключены; reserve/send — события стенда; synthetic live vision manifest не является MiMo run.</field>
  </report_template>

  <success_criteria>
    <criterion>Default preflight is local/read-only and does not read env/secrets or make HTTP without --url.</criterion>
    <criterion>Public web contract uses only custom public_webfetch with HTTPS, DNS validation/pinning, redirect/size/content-type bounds; builtin webfetch is denied.</criterion>
    <criterion>Main deterministic check validates 2 000/300/1 700, supplier snapshot, own price 349 ₽/кг and total 718 400 ₽.</criterion>
    <criterion>Recovery preserves same order and offers no silent server fast fallback.</criterion>
    <criterion>Webinar GO requires deployed API/upload/polling/actions probes plus a ten-order batch: first stage ≤10 s, p50 ≤180 s and 10/10 useful terminal ≤660 s; direct model runs do not replace this gate.</criterion>
  </success_criteria>
</skill>
