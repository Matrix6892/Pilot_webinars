<reference name="recovery-matrix">
  <purpose>Выбрать recovery по наблюдаемому симптому, сохранив ту же карточку и не подменяя live путь server fast fallback.</purpose>

  <matrix>
    <case id="bridge-offline">
      <signal>GET /api/orders?system=1 показывает bridgeOnline=false, либо UI показывает «агент временно недоступен».</signal>
      <impact>Свободная заявка остаётся live queued; MiMo, primary и reviewer не выдаются за выполненные.</impact>
      <fallback>Нет server fast/demo-engine fallback. Восстановить bridge и повторить тот же order id; recorded допустим только отдельным явным выбором labeled scenario.</fallback>
      <recovery>Не создавать новую карточку и не переключать свободный текст в recorded.</recovery>
      <status>NO-GO для live main scenario до восстановления bridge.</status>
    </case>

    <case id="expired-lease">
      <signal>UI показывает `Время агента истекло · карточка сохранена` и кнопку повтора.</signal>
      <impact>Старый worker fenced; order, conversation, snapshots и history должны остаться.</impact>
      <fallback>Повторить существующий order id после восстановления bridge.</fallback>
      <recovery>Не отправлять исходную форму повторно и не утверждать старый processing result.</recovery>
      <status>NO-GO до подтверждённого live retry.</status>
    </case>

    <case id="mutation-timeout-409">
      <signal>PATCH timeout/409; UI перечитывает карточку и не создаёт второй side effect.</signal>
      <impact>Ответ мог commit-нуться или факты могли устареть.</impact>
      <fallback>Дождаться reconciliation и использовать последнее подтверждённое состояние.</fallback>
      <recovery>При stock/supplier freshness выполнить новый recalculate; не повторять mutation со старым snapshot вслепую.</recovery>
      <status>NO-GO для действия до свежей карточки.</status>
    </case>

    <case id="reviewer-unavailable">
      <signal>UI показывает `Модель проверки недоступна · manager path`; нет transport `review-result`.</signal>
      <impact>Результат не checked. Commercial/unsafe path остаётся под manager control.</impact>
      <fallback>Передать руководителю или восстановить bridge и retry той же карточки.</fallback>
      <recovery>Не говорить «reviewer проверил» по одному result.review.verdict.</recovery>
      <status>NO-GO для checked claim.</status>
    </case>

    <case id="stale-supplier-snapshot">
      <signal>UI показывает `Данные поставщика обновились` или server возвращает 409 перед approve/reserve/send.</signal>
      <impact>Старые объём, цена, срок и checkedAt нельзя подтверждать.</impact>
      <fallback>Перечитать GET /api/market и запустить новый круг той же карточки.</fallback>
      <recovery>Не менять baseline через старый supplier id/stock; сохранить предыдущий result в history.</recovery>
      <status>NO-GO для main shortage plan до свежего snapshot.</status>
    </case>

    <case id="malformed-result">
      <signal>UI показывает безопасное завершение `manager/red/none` либо `Ошибка обработки · можно повторить`.</signal>
      <impact>Недоверенный JSON не пересекает guard/API boundary; новые вопросы клиенту не изобретаются.</impact>
      <fallback>Использовать manager path или retry той же карточки после live recovery.</fallback>
      <recovery>Сохранить order id, не выдавать malformed output за live success и не включать recorded молча.</recovery>
      <status>NO-GO до complete result или явного manager handoff.</status>
    </case>

    <case id="public-privacy">
      <signal>Публичный ledger показывает full body, attachment, conversation, snapshots или result history.</signal>
      <impact>Privacy boundary нарушена.</impact>
      <fallback>Остановить демонстрацию и использовать только synthetic summary; private detail открыть capability/admin после проверки.</fallback>
      <recovery>Не публиковать full CSV и не считать Google-таблицу источником private state.</recovery>
      <status>NO-GO.</status>
    </case>

    <case id="google-delay">
      <signal>Google-таблица отстаёт от сайта.</signal>
      <impact>Задержано только публичное представление synthetic summary.</impact>
      <fallback>Показать live ledger сайта или bounded CSV; обновить таблицу позже.</fallback>
      <recovery>Не менять формулу и не выдавать Google-таблицу за D1 source of truth.</recovery>
      <status>GO WITH FALLBACK только если private/public privacy и main live gate не затронуты.</status>
    </case>
  </matrix>
</reference>
