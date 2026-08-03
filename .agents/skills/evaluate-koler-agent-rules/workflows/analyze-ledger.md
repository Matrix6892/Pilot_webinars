<objective>
Найти в выбранных наблюдаемых событиях повторяемый дефект rules, не меняя журнал и не запрашивая скрытые рассуждения.
</objective>

<required_reading>
Прочитать:

- `../references/result-contract.md`
- `../references/eval-rubric.md`
- `../references/data-and-privacy.md`
- `../templates/comparison-report.md`
</required_reading>

<process>
1. Получить явно выбранный период/export и подтвердить его data class. По умолчанию использовать demo или synthetic rows.
2. Создать рабочую обезличенную копию; исходный export оставить неизменным.
3. Связать по order id вход, snapshots, primary/reviewer stages, normalized result, customer reply, manager action, recalculation и final state.
4. Искомые patterns:
   - повтор уже отвеченного вопроса;
   - исправление цены, срока, тона или next step;
   - unknown SKU или неподтверждённое сопоставление;
   - unsafe promise, заблокированный или пропущенный reviewer;
   - источник без успешного opened URL;
   - manager option, который выбирают или переписывают повторно;
   - timeout/retry/fallback и duplicate terminal result;
   - разница model variants по route, edits и latency.
5. Для каждого pattern записать case ids, observed evidence, нарушенный инвариант и canonical owner.
6. Отделить prompt/model defect от deterministic guard, data, UI или operator defect.
7. Предложить один следующий эксперимент и один executable regression test; не менять rules в этом workflow.
</process>

<output>
Таблица:

`pattern → case ids → input fact → observed result → expected invariant → likely layer → severity → next test`
</output>

<guardrails>
- Не выполнять production mutations и не вызывать модели.
- Не считать отсутствие внутреннего reasoning недостатком данных.
- Не делать вывод о модели по одному случаю без явной пометки anecdotal.
- Не объединять разные corpus versions в одну метрику.
</guardrails>

<success_criteria>
- Каждый finding имеет воспроизводимый case id и видимое evidence.
- Privacy policy соблюдена.
- Следующее изменение ограничено одним слоем/фактором.
- Исходный журнал не изменён.
</success_criteria>
