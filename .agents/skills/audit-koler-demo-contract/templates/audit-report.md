# Аудит demo-контракта «Колер»

- Репозиторий: `<absolute path>`
- Результат: `<PASS | PASS WITH P2 | FAIL>`
- Exit code: `<0 | 1>`
- Режим: `read-only`

## Findings

| Severity | Claim | Canonical evidence | Conflicts |
|---|---|---|---|
| P1 | `<проверяемое утверждение>` | `path/file:line` | `path/file:line` |

## Details

### `<P0–P2 · claim>`

`<Почему источники расходятся, какое наблюдаемое поведение затронуто и как
доказать согласование. Не предлагать скрытое автоматическое исправление.>`

## Dependency index

### Models

- `<model/role>`: `path/file:line`, `path/file:line`

### Canonical scenario

- `<value/transition>`: `path/file:line`, `path/file:line`

### AgentResult surfaces

- `<producer | guard | persistence | consumer>`: `path/file:line`

## Checks

- `<check>`: `<PASS | P2 | FAIL>`
- Worktree before/after: `<unchanged | changed>`

## Interpretation

`<Зафиксировать, является ли ненулевой код ожидаемым из-за найденного drift.
Отдельно перечислить ручные проверки, если автоматического доказательства
недостаточно.>`
