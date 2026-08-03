<workflow name="restore-baseline">
  <objective>Вернуть главный shortage baseline: КР-001=300 кг и «ПромКолор Опт»=2 000 кг, только через явно разрешённые admin APIs.</objective>

  <procedure>
    <step order="1">Уточнить target origin. Для non-loopback нужен HTTPS; не брать URL из .env или истории команд.</step>
    <step order="2">Выполнить <command>node .agents/skills/operate-koler-webinar/scripts/reset-baseline.mjs --url TARGET</command>. Это dry-run без записи.</step>
    <step order="3">Показать исходные и целевые stock values. Если запись не разрешена, остановиться.</step>
    <step order="4">Получить admin code через stdin либо имя переменной через --admin-code-env; не передавать значение аргументом.</step>
    <step order="5">Только после отдельной авторизации выполнить reset с --apply. Скрипт меняет только КР-001 и строку ПромКолор Опт, не цену/срок/каталог.</step>
    <step order="6">При partial failure сохранять CAS/revision guard; не затирать параллельное изменение и не удалять history.</step>
    <step order="7">Повторить read-only preflight и check-main-scenario. Успех подтверждается 300/2 000 stock, supplier snapshot и отсутствием privacy drift.</step>
  </procedure>

  <secure_input_examples>
    <example kind="stdin">Передать код скрытым stdin-каналом; не вставлять его в команду или отчёт.</example>
    <example kind="environment">Передать только имя приватной переменной: --admin-code-env KOLER_ADMIN_CODE.</example>
  </secure_input_examples>

  <mutation_scope>
    <allowed>POST /api/admin для сессионной авторизации.</allowed>
    <allowed>PATCH /api/inventory только для КР-001 с expectedRevision и причиной оператора.</allowed>
    <allowed>PATCH /api/market только для строки «ПромКолор Опт» категории КР-001.</allowed>
    <forbidden>Изменение цены 349, срока, каталога, карточек, result history, ledger, R2 или конфигурации.</forbidden>
  </mutation_scope>

  <success_criteria>
    <criterion>GET /api/inventory подтверждает КР-001 stockKg 300.</criterion>
    <criterion>GET /api/market подтверждает ПромКолор Опт stockKg 2 000.</criterion>
    <criterion>Код и session cookie не появляются в stdout/stderr.</criterion>
    <criterion>Карточки, events, uploads и history не удалялись.</criterion>
    <criterion>Цена 349 ₽/кг остаётся неизменной и подтверждается read-only проверкой.</criterion>
  </success_criteria>
</workflow>
