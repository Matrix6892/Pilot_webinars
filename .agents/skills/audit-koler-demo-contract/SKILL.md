---
name: audit-koler-demo-contract
description: Проверяет согласованность runtime, prompts, UI, сценарных чисел, документации и handoff стенда «Колер». Используется после продуктовых изменений и перед релизом или вебинаром.
---

<objective>
Находит расхождения между исполняемым контрактом стенда «Колер» и его
описанием: ролями моделей, `AgentResult`, поиском и fallback, главным
сценарием КР-001 (2 000/300/1 700 кг), вторичным legacy-сценарием ПРОТЕК,
лимитами, Cloudflare bindings и границами интеграций.

Аудит только читает файлы. Он возвращает доказательный отчёт
`claim → canonical evidence → conflicts → P0–P2` и не исправляет найденные
расхождения.
</objective>

<essential_principles>
- Считать runtime, сохранённые данные и executable tests более сильным
  доказательством, чем повествовательную документацию.
- Для каждого замечания указывать как минимум одну точную ссылку `file:line`.
- Не считать одно совпадение строки доказательством сквозного контракта:
  проверять producer, guard, persistence и consumer surfaces.
- Не читать секреты, не обращаться к production и не выполнять HTTP-запросы.
- Не менять файлы даже ради форматирования отчёта; выводить отчёт в stdout.
- P0 и P1 завершают проверку ненулевым кодом. P2 остаётся рекомендацией и
  самостоятельно не блокирует.
</essential_principles>

<quick_start>
Из корня проекта:

```bash
node .agents/skills/audit-koler-demo-contract/scripts/audit-contract.mjs
```

Из любого другого каталога:

```bash
node /absolute/path/to/Pilot_webinars/.agents/skills/audit-koler-demo-contract/scripts/audit-contract.mjs
```

Markdown — формат по умолчанию. Для компактного терминального отчёта добавь
`--format=console`. Код `1` ожидаем, пока существует P0/P1 drift; это не сбой
самого скрипта.
</quick_start>

<routing>
Для полного аудита прочитай и выполни
[workflows/audit.md](workflows/audit.md).

При интерпретации спорного источника дополнительно читай
[references/source-of-truth.md](references/source-of-truth.md).

При выборе приоритета или exit policy дополнительно читай
[references/severity-rules.md](references/severity-rules.md).

Для ручного дополнения автоматического результата копируй структуру
[templates/audit-report.md](templates/audit-report.md), не создавая файл без
явного запроса пользователя.
</routing>

<validation>
Скрипт должен запускаться без установки пакетов, разрешать корень репозитория
относительно собственного `import.meta.url` и оставлять `git status` без новых
изменений кроме заранее созданных файлов самого skill.
</validation>

<success_criteria>
- Отчёт охватывает MiMo, отдельные Flash primary/reviewer и Sol.
- `AgentResult` сопоставлен между type, prompt, guard, bridge, API, UI и ledger.
- Проверены search/open-page contract, timeout, offline fallback и processing
  lease.
- Главные 2 000/300/1 700 кг и итог 718 400 ₽ сопоставлены с runtime, tests и
  операторскими документами; 620/420/260/150/700 остаётся secondary/legacy.
- Проверены request limits, DB/R2 bindings, endpoints и текущие границы
  почты/ERP/vision/public ledger.
- Проверено, что Flash обозначен только точным доступным alias без выдуманного
  номера версии, а свободный ввод не получает скрытый recorded fallback.
- При отсутствии P0/P1 процесс завершается кодом 0; при их наличии — кодом 1.
- Ни один файл проекта не изменён самим аудитом.
</success_criteria>
