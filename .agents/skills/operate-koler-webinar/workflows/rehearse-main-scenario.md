<workflow name="rehearse-main-scenario">
  <objective>Провести только явно разрешённую synthetic rehearsal главного shortage-сценария КР-001 и сохранить durable history.</objective>

  <authorization>
    <requirement>Начинать live-репетицию только после явного запроса пользователя на конкретный target origin.</requirement>
    <requirement>Отдельно подтвердить origin и предупредить, что карточки и события не удаляются.</requirement>
    <requirement>Для записи использовать HTTPS; HTTP допустим только loopback.</requirement>
    <requirement>Использовать только synthetic 2 000 кг КР-001 и synthetic photo при необходимости.</requirement>
  </authorization>

  <procedure>
    <step order="1">Выполнить local-only preflight и check-main-scenario; при NO-GO остановиться.</step>
    <step order="2">Выполнить reset-baseline без --apply и показать dry-run: КР-001=300 кг, ПромКолор Опт=2 000 кг.</step>
    <step order="3">После отдельного write authorization применить reset --apply; без такой авторизации apply не запускать.</step>
    <step order="4">Отправить свободную заявку на 2 000 кг КР-001. Она должна идти live, не recorded.</step>
    <step order="5">Проверить programmatic deficit 1 700 кг, route=manager/red, blocker=null, 2–3 options и followUpActor supplier/internal.</step>
    <step order="6">Проверить snapshot ПромКолор Опт: 2 000 кг, 361 ₽/кг, 4 дня, checkedAt 2026-07-31 09:00; own price 349 ₽/кг и total 718 400 ₽.</step>
    <step order="7">Проверить reviewer transport: только review-result означает checked; skipped/fallback не выдавать за checked.</step>
    <step order="8">Проверить offline/expired lease recovery на той же карточке. Не включать server fast fallback; recorded scenario можно показать только отдельной явной кнопкой.</step>
    <step order="9">Проверить public ledger как synthetic summary и private detail/admin boundary.</step>
  </procedure>

  <finally>
    <step order="1">Повторно выполнить dry-run reset для текущего состояния.</step>
    <step order="2">Apply reset запускать только при отдельном явном разрешении; в обычной docs wave не запускать.</step>
    <step order="3">После разрешённой записи подтвердить GET inventory/market и не удалять карточку, history, events или uploads.</step>
    <step order="4">Если baseline или privacy не подтверждены, выдать NO-GO и точный ручной следующий шаг.</step>
  </finally>

  <acceptance>
    <criterion>Основной order id сохраняется, а 2 000/300/1 700 и supplier plan видны в одной карточке.</criterion>
    <criterion>Reviewer attribution и transport state наблюдаемы; recorded output не смешан с live.</criterion>
    <criterion>Public output остаётся synthetic summary, private detail/admin access проверяется отдельно.</criterion>
    <criterion>Runtime price 349 ₽/кг совпадает с каноническим fixture.</criterion>
  </acceptance>
</workflow>
