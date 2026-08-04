<overview>
Контракт «Колера» распределён по runtime, данным, prompts, тестам, UI и трём
операторским документам. Это руководство задаёт порядок доказательств и
поверхности, которые нельзя менять изолированно.
</overview>

<authority_order>
1. **Runtime и сохранённые данные**: `lib/`, `app/api/`, `scripts/`,
   `data/paint-demo.json`, `.openai/hosting.json`.
2. **Исполняемые guards и tests**: `lib/agent-guard.mjs`, `tests/`.
3. **Инструкции моделей и profiles**: `public/prompts/`, `.opencode/agents/`.
4. **UI и observable ledger**: `app/order-stand.tsx`,
   `app/api/ledger/route.ts`, `lib/ledger-export.mjs`.
5. **Операторские описания**: `README.md`,
   `docs/ARCHITECTURE-AND-WEBINAR.md`, `docs/WEBINAR-RUNBOOK.md`.

Если более слабый источник противоречит более сильному, фиксируй drift. Если
runtime surfaces расходятся между собой, это минимум P1 и иногда P0.
</authority_order>

<claim_catalog>
<claim name="model_roles">
- MiMo V2.5 наблюдает только фотографию.
- Официальный DeepSeek API `deepseek/deepseek-v4-flash`/max — исполнитель
  заказа и отдельный reviewer. Датированный номер Flash не утверждается без
  доказательства provider catalog/runtime.
- Reviewer всегда выполняется отдельным вторым Flash/max-вызовом без tools.
- GPT-5.6 Sol подготовила инструкции и запускается вручную для их новой
  редакции, но не обрабатывает повседневный заказ.
</claim>

<claim name="agent_result">
`lib/demo-engine.ts` задаёт TypeScript surface. Модельный prompt производит
базовые поля, `lib/agent-guard.mjs` нормализует недоверенный JSON,
`scripts/agent-bridge.mjs` передаёт результат, `/api/agent` валидирует и
сохраняет его, UI и ledger читают сохранённый контракт. `supplierPlan`
допустимо вычислять в guard, не требуя его от модели.
</claim>

<claim name="research">
`research.checked=true` допустим только когда открыты все сохранённые URL.
Profile разрешает search/fetch и требует открыть использованные страницы;
bridge сохраняет фактически открытые URL; guard удаляет неподтверждённые
claims. Offline fallback всегда возвращается к `checked=false` и пустым
sources.
</claim>

<claim name="scenario">
Главный контракт: КР-001, потребность 2 000 кг, собственный остаток 300 кг,
дефицит 1 700 кг, 1 700 кг от «ПромКолор Опт» по 361 ₽/кг и итог 718 400 ₽.
ПРОТЕК 620/420/260/150/700 остаётся только secondary/legacy regression. Цены
и итоговые суммы вычисляются из `data/paint-demo.json`, а не дублируются
расчётной функцией audit-script.
</claim>

<claim name="platform">
`.openai/hosting.json` связывает D1 как `DB`, R2 как `UPLOADS`. Runtime
rate-limits и body limits сильнее их пересказа в документации. Публичный ledger
допустим только для synthetic demo data.
</claim>

<claim name="integration_boundaries">
Форма имитирует входящую почту. Reserve/send меняют состояние и журнал D1, но
не резервируют товар в ERP и не доставляют письмо. Vision-наблюдение не
проверяется независимой моделью; при отказе фото сохраняется, а карточка
переходит к вопросам.
</claim>
</claim_catalog>

<intentional_change_protocol>
При намеренной смене модели или числа сценария:

1. Сначала обнови runtime/data и executable regression.
2. Затем обнови prompts/profiles, UI и observable ledger.
3. После этого обнови README, architecture и operator runbook.
4. Обнови executable assertions audit-script только как часть того же
   осознанного изменения.
5. Запусти аудит и просмотри весь dependency index, даже если findings пусты.
</intentional_change_protocol>
