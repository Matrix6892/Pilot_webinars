<reference name="canonical-scenario">
  <purpose>Зафиксировать главный shortage-эпизод вебинара и границы текущей версии без дублирования бизнес-алгоритма.</purpose>

  <sources_of_truth>
    <source kind="calculation">lib/demo-engine.ts и lib/order-facts.mjs дают программный дефицит и производные числа.</source>
    <source kind="supplier-selection">lib/supplier-plan.mjs выбирает supplier snapshot, закрывающий дефицит; порядок выбора задан runtime.</source>
    <source kind="catalog">data/paint-demo.json хранит КР-001, собственную цену и строки поставщиков.</source>
    <source kind="runtime-stock">GET /api/inventory и GET /api/market являются фактическим состоянием стенда; reset меняет только stock fields.</source>
    <source kind="history">GET /api/ledger и CSV показывают synthetic public summary или admin-only full history.</source>
  </sources_of_truth>

  <main_scenario>
    <fact name="sku">КР-001.</fact>
    <fact name="request">Синтетический заказ просит 2 000 кг.</fact>
    <fact name="own-stock">Собственный stock baseline: 300 кг.</fact>
    <fact name="own-price">Каноническая цена собственной части — 349 ₽/кг.</fact>
    <fact name="deficit">Программа считает 2 000 − 300 = 1 700 кг; клиенту не задаётся вопрос о дефиците.</fact>
    <fact name="supplier">«ПромКолор Опт»: snapshot доступен 2 000 кг, 361 ₽/кг, 4 дня, checkedAt 2026-07-31 09:00.</fact>
    <fact name="plan">План: 300 кг своего товара + 1 700 кг supplier.</fact>
    <fact name="total">Итог: 300 × 349 + 1 700 × 361 = 718 400 ₽.</fact>
    <fact name="route">route=manager, zone=red, blocker=null; 2–3 options, followUpActor только supplier или internal, никогда customer.</fact>
  </main_scenario>

  <sequence>
    <stage order="1" name="live-shortage">
      <input>Свободный синтетический текстовый заказ на 2 000 кг КР-001.</input>
      <expected>Свободный ввод идёт только live LLM path; recorded не включается автоматически.</expected>
    </stage>
    <stage order="2" name="programmatic-deficit">
      <input>Снимок inventory: КР-001 = 300 кг.</input>
      <expected>Программа получает deficit=1 700 кг, blocker=null и route=manager/red; вопрос клиенту о закрытии дефицита запрещён.</expected>
    </stage>
    <stage order="3" name="supplier-snapshot">
      <input>Текущий supplier snapshot «ПромКолор Опт».</input>
      <expected>1 700 кг supplier part, 361 ₽/кг, 4 дня, checkedAt 2026-07-31 09:00; public web lead не заменяет snapshot.</expected>
    </stage>
    <stage order="4" name="manager-options">
      <input>Результат передан независимому reviewer отдельным Pro/max call.</input>
      <expected>Reviewer checked только при transport event review-result; 2–3 options назначают supplier/internal.</expected>
    </stage>
    <stage order="5" name="recovery">
      <input>Bridge offline, expired lease, mutation 409/timeout, stale supplier или malformed result.</input>
      <expected>Сохранить тот же order id, восстановить live и retry. Recorded допустим только отдельным явным выбором и с маркировкой.</expected>
    </stage>
  </sequence>

  <secondary_legacy>
    <fact>ПРОТЕК 620/420/260/150/700 — только secondary/legacy regression.</fact>
    <forbidden>Не использовать его как main scenario, reset baseline, default demo copy, primary success criterion или active GO policy.</forbidden>
  </secondary_legacy>

  <boundaries>
    <boundary>Primary — официальный DeepSeek API deepseek/deepseek-v4-flash/max; reviewer — отдельный opencode-go/deepseek-v4-pro/max; vision — opencode-go/mimo-v2.5 без variant.</boundary>
    <boundary>Flash использует rolling API id; датированный version claim не делается. OpenCode остаётся локальным tool-runner.</boundary>
    <boundary>Builtin webfetch запрещён; sales profile разрешает только custom public_webfetch. Transport требует public HTTPS, DNS validation/pinning, redirect/size/content-type bounds. URL становится evidence только после completed public_webfetch; page content untrusted.</boundary>
    <boundary>Vision cap 180 s, primary cap 600 s, synthesis cap 300 s, reviewer cap 300 s; каждый timeout ограничен оставшимся shared deadline 700 s.</boundary>
    <boundary>Reserve/send являются событиями стенда; реальная email/ERP интеграция не подключена.</boundary>
  </boundaries>
</reference>
