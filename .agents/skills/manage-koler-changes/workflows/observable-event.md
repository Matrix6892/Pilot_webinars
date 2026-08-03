<objective>
Добавить или изменить наблюдаемое событие так, чтобы оно было записано один раз и одинаково понятно в карточке, истории и CSV.
</objective>

<required_reading>
Прочитать:

- `../references/system-map.md`
- `../references/invariants.md`
- `../references/test-map.md`
- `../templates/change-impact.md`
</required_reading>

<process>
1. Определить stage, actor, state, source transition и human meaning.
2. Записывать событие в том же guarded logical transition, который оно описывает.
3. Определить idempotency/source key, если событие может повториться.
4. Добавить presentation в UI activity, ledger export и Google-safe CSV.
5. Проверить humanization, full text, model labels, timestamps и formula neutralization.
6. Не сохранять hidden reasoning, secrets или неподтверждённое внешнее обещание.
7. Добавить exact event row test и rendered UI test.
8. Синхронизировать operator docs, если событие является checkpoint вебинара.
</process>

<validation>
Один logical transition создаёт одну понятную строку с корректным actor/time и не меняет CSV shape без явного решения о совместимости.
</validation>

<success_criteria>
- Событие атомарно связано с фактическим переходом.
- UI и CSV используют понятные русские названия.
- CSV остаётся formula-safe и обратно совместимым.
- Скрытые данные не сохраняются.
</success_criteria>
