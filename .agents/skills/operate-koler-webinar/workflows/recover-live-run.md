<workflow name="recover-live-run">
  <objective>Продолжить показ из durable state с минимальной потерей причинности и без дублирования бизнес-действий.</objective>

  <triage>
    <step order="1">Остановить новые действия ведущего и записать номер текущей карточки, последний видимый статус, stock/market snapshot и последний завершённый шаг.</step>
    <step order="2">Выполнить read-only preflight либо точечные GET для system, order, inventory, market и ledger.</step>
    <step order="3">Выбрать ровно одну строку из references/recovery-matrix.md по наблюдаемому симптому.</step>
    <step order="4">Предпочесть продолжение той же карточки и live recovery. Не создавать новую карточку и не включать server fast fallback ради визуального сбоя.</step>
    <step order="5">После восстановления проверить, что прежние письмо, ответы, решения и история доступны.</step>
  </triage>

  <durable_state>
    <item>Номер и статус карточки в D1.</item>
    <item>Conversation и result history.</item>
    <item>Снимок своего склада и предложений поставщиков, сохранённый для круга.</item>
    <item>Order events, inventory changes и дневной ledger.</item>
  </durable_state>

  <retry_policy>
    <rule>При model timeout дождаться появления retry/error state и использовать «Повторить эту карточку»; не отправлять исходную форму заново.</rule>
    <rule>При offline bridge сохранить queued/processing заказ, восстановить bridge и повторить ту же карточку. Recorded допустим только отдельным явным выбором labeled scenario.</rule>
    <rule>При конфликте изменения склада или рынка перечитать свежий GET и решить, нужен ли повтор. Не повторять PATCH со старой revision.</rule>
    <rule>При сомнении в успешности reserve/send сначала читать карточку и ledger; не нажимать действие повторно вслепую.</rule>
  </retry_policy>

  <completion>
    <step order="1">Проверить карточку и ledger после recovery.</step>
    <step order="2">Если репетиция меняла baseline, выполнить workflows/restore-baseline.md.</step>
    <step order="3">Сообщить, какие шаги были live, какие прошли по fallback и какое durable state сохранено.</step>
  </completion>

  <forbidden>
    <item>Удаление «дублирующей» карточки или строки истории.</item>
    <item>Ручная правка D1, R2 или Cloudflare bindings в рамках recovery.</item>
    <item>Повтор reserve/send без проверки текущего статуса и журнала.</item>
    <item>Скрытое переключение с live-модели на быстрый путь без объяснения аудитории.</item>
  </forbidden>
</workflow>
