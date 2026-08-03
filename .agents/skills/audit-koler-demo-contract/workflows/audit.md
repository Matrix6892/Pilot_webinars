<objective>
Выполнить полный read-only аудит публичного и исполняемого контракта стенда,
отделить реальные расхождения от пробелов покрытия и выдать проверяемый отчёт.
</objective>

<required_reading>
Перед аудитом прочитай:

1. [../references/source-of-truth.md](../references/source-of-truth.md)
2. [../references/severity-rules.md](../references/severity-rules.md)
3. [../templates/audit-report.md](../templates/audit-report.md)
</required_reading>

<process>
1. Зафиксируй `git status --short`, не изменяя и не очищая рабочее дерево.
2. Запусти `scripts/audit-contract.mjs` из текущего каталога. Ненулевой код
   означает найденный P0/P1 drift, поэтому сохрани stdout до интерпретации.
3. Для каждого P0/P1 открой canonical evidence и conflict locations. Не
   исправляй код или документацию в рамках этого skill.
4. Используй dependency index отчёта, чтобы перечислить все surfaces,
   затронутые намеренной сменой модели или числа сценария.
5. P2 отделяй от drift: это пробел executable coverage или поддерживаемости,
   который не меняет текущий показанный результат.
6. Если автоматическая проверка не может доказать семантическое противоречие,
   добавь ручное замечание по шаблону с точными `file:line` и явно пометь
   способ проверки.
7. Повтори `git status --short`. Новые изменения от запуска недопустимы.
</process>

<reporting>
Начни с итогового `PASS`, `PASS WITH P2` или `FAIL`. Затем дай таблицу findings,
детали, dependency index и выполненные проверки. Не выдавай предположение за
найденный drift и не скрывай ожидаемый exit code.
</reporting>

<success_criteria>
- Автоматический отчёт получен и его exit code объяснён.
- Каждое замечание содержит claim, canonical evidence, conflict и severity.
- P0/P1 проверены по исходным строкам, а не пересказаны по памяти.
- Dependency index приложен для моделей и значений главного сценария.
- Статус рабочего дерева после запуска совпадает со статусом до запуска.
- Никакие исправления, запросы к production или чтение секретов не выполнены.
</success_criteria>
