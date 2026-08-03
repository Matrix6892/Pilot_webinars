<objective>
Определить наблюдаемые части результата и источники ground truth, по которым оцениваются rules и модели «Колера».
</objective>

<canonical_owners>
| Факт | Канонический владелец |
|---|---|
| Форма `AgentResult` | `lib/demo-engine.ts` |
| Нормализация и полнота live result | `lib/agent-guard.mjs` |
| Факты входящего письма | `lib/order-facts.mjs` |
| Каталог, цены и demo baseline | `data/paint-demo.json` |
| Снимок склада | сохранённый inventory snapshot заказа |
| Снимок предложений поставщиков | сохранённый market snapshot заказа |
| Supplier feasibility и ranking | `lib/supplier-plan.mjs` |
| Роли и последовательность моделей | `scripts/agent-bridge.mjs`, `data/models.json`, `.opencode/agents/` |
| История версий решения | `lib/result-history.ts`, `order_result_history` |
| Наблюдаемые события | order events и `lib/ledger-export.mjs` |
</canonical_owners>

<observable_contract>
Оценивать минимум:

- `zone`, `decision` и `route` как согласованную тройку;
- `understood` и `missing` относительно фактов клиента;
- выбранный product, requested/available quantity, price, total и schedule;
- fence calculation, если вход содержит достаточные размеры и стороны;
- market/supplier plan только из сохранённого snapshot;
- `research.checked`, sources и факты только для реально открытых URL;
- client reply без внутренних ролей, неподтверждённых свойств и обещаний;
- manager options как выполнимые и различимые действия;
- reviewer verdict и blocking behavior;
- полноту результата через `isCompleteAgentResult`.
</observable_contract>

<route_invariants>
| Zone | Decision | Route | Смысл |
|---|---|---|---|
| green | quote | ready | данных и полномочий достаточно для безопасного предложения |
| yellow | clarify | needs_info | нужны только конкретные сведения клиента |
| red | escalate | manager | требуется решение человека или недоступное обязательство |
</route_invariants>

<ground_truth_rules>
- Не переписывать expected числа из model output.
- Вычислять expected product, массу, упаковки, цену и supplier plan существующей программной логикой либо фиксировать точный сохранённый snapshot.
- Если web source недоступен или не открыт, expected `research.checked` равен `false`, а его факт не влияет на решение.
- Vision ground truth ограничен видимыми признаками; материал, площадь, пригодность и расход подтверждает клиент или deterministic calculation.
- Reviewer ground truth проверяет полномочия и обещания, а не стилистическое сходство текста.
</ground_truth_rules>

<success_criteria>
- Каждый case указывает канонического владельца expected behavior.
- Expected result не выводится из ответа оцениваемой модели.
- Route, расчёт, sources и reviewer outcome можно проверить независимо.
</success_criteria>
