<objective>
Дать короткую карту источников истины «Колера», чтобы impact analysis начинался с владельца данных, а не со случайного совпадения текста.
</objective>

<system_map>
| Контракт | Канонический владелец | Основные потребители |
|---|---|---|
| Вход и state machine заказа | `app/api/orders/route.ts`, `app/api/agent/route.ts` | `app/order-stand.tsx`, D1, ledger |
| Форма `AgentResult` | `lib/demo-engine.ts` | prompts, `lib/agent-guard.mjs`, bridge, API, UI, history, CSV |
| Нормализация model output | `lib/agent-guard.mjs` | `scripts/agent-bridge.mjs`, tests |
| Быстрый расчёт | `lib/demo-engine.ts` | orders API, tests |
| Живой model chain | `scripts/agent-bridge.mjs` | `/api/agent`, OpenCode profiles |
| Роли моделей | `data/models.json`, `scripts/agent-bridge.mjs`, `.opencode/agents/` | UI, prompts, docs, honesty tests |
| Каталог и demo market | `data/paint-demo.json` | engine, bridge, inventory/market stores, UI, tests, docs |
| Примеры заявок | `data/order-scenarios.ts` | UI, rendered HTML tests, webinar docs |
| Живой склад | `inventory_items`, `lib/inventory.ts` | snapshots, engine, API, UI, ledger |
| Предложения поставщиков | `system_state`, `lib/market-store.ts`, `lib/supplier-plan.mjs` | snapshots, engine, actions, ledger |
| D1 shape | `db/schema.ts`, `drizzle/*.sql`, `db/index.ts` | routes, tests, deployed legacy databases |
| История решения | `lib/result-history.ts`, `order_result_history` | order routes, agent route, UI, CSV |
| Представление журнала | `lib/ledger-export.mjs`, `app/api/ledger/route.ts` | UI, CSV, Google Sheets, docs |
| Upload boundary | `app/api/uploads/route.ts`, `lib/upload-guard.mjs`, `lib/upload-vision.mjs` | UI, bridge, R2 |
| Авторизация | `lib/admin-auth.ts`, `lib/order-access.ts` | mutating routes |
| Rate limits | `lib/request-limit.ts`, route-local rules | public order and upload APIs |
| Hosting bindings | `.openai/hosting.json`, worker config/types | D1 and R2 routes |
</system_map>

<cross_layer_chains>
**Model contract**

`AgentResult type → prompt JSON → model output → normalize/complete guard → agent API → order state → UI → result history → CSV`

**State transition**

`UI action → authenticated route → current-state/freshness guard → D1 batch → event/history → refreshed UI → ledger`

**Catalog/scenario**

`paint-demo data → deterministic engine/live snapshot → UI presets → expected tests → webinar copy`

**Schema**

`Drizzle schema ↔ generated migrations ↔ runtime bootstrap/compat additions ↔ old and empty database tests`
</cross_layer_chains>

<usage>
Для каждого изменяемого факта назвать одну каноническую точку. Остальные совпадения считать потребителями, которые должны либо автоматически читать источник, либо иметь проверку против drift.
</usage>

<success_criteria>
- Impact map начинается с канонического владельца.
- Для каждого владельца найдены читатели, писатели, persistence и presentation.
- Производная документация не используется как единственный runtime-факт.
</success_criteria>
