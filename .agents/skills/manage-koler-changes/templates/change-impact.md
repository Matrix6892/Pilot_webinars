<template>
```markdown
# Change impact: <короткое название>

## Наблюдаемое поведение

- До:
- После:
- Не меняется:

## Канонический владелец

- Источник истины:
- Читатели:
- Писатели:
- Persistence:
- UI/ledger/docs:

## Затронутые workflows

- [ ] Agent contract
- [ ] Order lifecycle
- [ ] API boundary
- [ ] Bridge lease
- [ ] Schema evolution
- [ ] Catalog/scenario
- [ ] Observable event

## Инварианты и риски

| Инвариант | Доказательство до | Проверка после |
|---|---|---|
|  |  |  |

## Tests

- Regression:
- Targeted:
- Full gate:
- Fault/concurrency:

## Rollback

- Условие:
- Действие:
- Совместимость данных:

## Итог

- Реализовано:
- Проверено:
- Не проверено:
- Deploy выполнен: нет
```
</template>

<usage>
Заполнить до изменения первые пять разделов. После изменения заполнить результаты проверок и итог. Не отмечать deploy выполненным без отдельного успешного действия публикации.
</usage>
