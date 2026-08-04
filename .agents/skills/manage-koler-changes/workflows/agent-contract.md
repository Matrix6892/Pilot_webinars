<objective>
Изменить форму или правила `AgentResult`, prompts, model routing или guard без расхождения живого и быстрого путей.
</objective>

<required_reading>
Прочитать:

- `../references/system-map.md`
- `../references/invariants.md`
- `../references/test-map.md`
- `../templates/change-impact.md`
</required_reading>

<process>
1. Описать новый observable result и определить, может ли он быть вычислен программой вместо модели.
2. Найти поле/правило во всех звеньях: TypeScript type, sales/reviewer/vision prompts, completeness check, normalizer, bridge prompt/result, agent API, order route, UI, result history, ledger и docs.
3. Зафиксировать backward behavior для отсутствующего/лишнего/неверного поля.
4. Обновить deterministic fallback и live guard одним контрактом.
5. Проверить роли: MiMo только наблюдает, Flash primary готовит заказ, Flash reviewer выполняется отдельным вызовом без инструментов, Sol вне runtime.
6. Добавить recorded valid, malformed, contradictory и reviewer-rejected cases.
7. Выполнить targeted и полный gate.
</process>

<validation>
Проверить минимум:

```bash
node --test tests/agent-guard.test.mjs tests/demo-engine.test.mjs tests/model-role-honesty.test.mjs tests/vision-bridge.test.mjs
node .agents/skills/manage-koler-changes/scripts/check-change-contract.mjs
```
</validation>

<success_criteria>
- Prompt schema и runtime type совпадают.
- Неполный или противоречивый model output не проходит.
- Fast/live routes дают совместимый безопасный результат.
- UI и ledger корректно представляют новое поле.
- Model roles и opened-source contract сохранены.
</success_criteria>
