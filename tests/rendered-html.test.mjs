import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function assertSentenceCaseHeadings(source) {
  for (const match of source.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/giu)) {
    const copy = match[1].replace(/<[^>]+>/g, " ").replace(/\{[^}]*\}/g, " ");
    const letters = copy.match(/[А-ЯЁа-яё]/g) ?? [];
    if (letters.length < 4) continue;
    assert.ok(
      letters.some((letter) => letter === letter.toLocaleLowerCase("ru-RU")),
      `Заголовок должен быть набран как обычная фраза: ${copy.trim()}`,
    );
  }
}

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Не найдено начало фрагмента: ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `Не найден конец фрагмента: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("ships the Колер product surface and removes the starter", async () => {
  const [
    page,
    stand,
    layout,
    agentRoute,
    ordersRoute,
    paintSource,
    modelsSource,
  ] = await Promise.all([
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/order-stand.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../data/paint-demo.json", import.meta.url), "utf8"),
      readFile(new URL("../data/models.json", import.meta.url), "utf8"),
    ]);
  const paintData = JSON.parse(paintSource);
  const modelData = JSON.parse(modelsSource);

  assert.match(page, /<OrderStand \/>/);
  assert.match(
    stand,
    /Клиент пишет своими словами\.\s*Агент ведёт заказ до готового ответа/,
  );
  assert.match(stand, /Форма запускает тот же рабочий путь/);
  assert.match(stand, /Руководитель одобрил запрос/);
  assert.match(stand, /Агент нашёл, как собрать все/);
  assert.match(stand, /Расчёт варианта с другим поставщиком/);
  assert.match(stand, /Что подтверждаем перед итоговым письмом/);
  assert.match(stand, /Заполнить свой заказ/);
  assert.match(stand, /Заявка на подбор краски/);
  assert.match(stand, /customDraft \? "Ваш заказ" : "Готовый пример"/);
  assert.match(stand, /Свой заказ/);
  assert.match(stand, /className="system-map-mobile"/);
  assert.match(stand, /Наша часть/);
  assert.match(stand, /в строке партнёра видно/);
  assert.match(stand, /до полного\s+заказа/);
  assert.match(stand, /Расчёт для сравнения; сейчас у «Колера» доступно/);
  assert.match(stand, /В строке таблицы поставщиков от/);
  assert.match(stand, /Цены и наличие у других поставщиков/);
  assert.match(stand, /Что агент делает сам/);
  assert.match(
    stand,
    /Страница заказа хранит письмо, фото и весь контекст[\s\S]*?оценивает\s+неизвестное диапазоном[\s\S]*?Вопрос появляется только при неоднозначности самого объекта/,
  );
  assert.match(stand, /Описание заказа и фото/);
  assert.match(stand, /Модель для фото описала видимые детали/);
  assert.match(stand, /Модель для фото описывает только видимое/);
  assert.match(
    stand,
    /Поставка двумя партиями опирается на подтверждённый остаток/,
  );
  assert.match(stand, /сравнение с ценами других поставщиков/);
  assert.match(stand, /остаток на момент расчёта/);
  assert.match(stand, /Сверка перед обещанием/);
  assert.match(stand, /Открытые данные о компании клиента/);
  assert.match(stand, /Страница заказа и журнал/);
  assert.match(stand, /<details className="zone-guide" open>/);
  assert.match(
    stand,
    /bridgeOnline[\s\S]*?Рабочая модель ведёт каждый заказ[\s\S]*?Модель для фото описывает видимое[\s\S]*?Программа сверяет цены и остатки/,
  );
  assert.match(stand, /Google[- ]таблиц|Google Таблиц/iu);
  assert.match(stand, /Другой пример/);
  assert.match(
    stand,
    /scenarioGroups\.find\(\(group\) => group\.id === scenarioGroup\)[\s\S]*?\.examples\.length/,
  );
  assert.doesNotMatch(stand, /scenarioIndex \+ 1\} из 10/);
  assert.match(stand, /type="file"/);
  assert.match(stand, /fetchJson\(\s*"\/api\/uploads"/);
  assert.match(stand, /Заменить фотографию/);
  assert.match(stand, /Убрать фотографию/);
  assert.match(
    stand,
    /function inferZone\(draft: Draft\)[\s\S]*?Свободная заявка готова к разбору/,
  );
  assert.doesNotMatch(stand, /orderFactsFromText|matchProduct/);
  assert.match(
    stand,
    /Агент изучит письмо и фото, сам найдёт внешние факты и отметит неизвестное диапазоном/,
  );
  assert.match(
    stand,
    /Заявка и фотография войдут в открытый журнал вебинара/,
  );
  assert.match(stand, /Отправить агенту/);
  assert.match(stand, /Готов ответить/);
  assert.match(stand, /Предварительная оценка/);
  assert.match(stand, /Решает руководитель/);
  assert.match(stand, /Вариант подтверждён · подготовьте резерв товара/);
  assert.match(stand, /Польза клиенту/);
  assert.match(stand, /Результат для завода/);
  assert.match(
    stand,
    /humanizeText\(option\.businessResult \?\? ""\)/,
  );
  assert.match(stand, /Что учесть/);
  assert.match(stand, /Письмо по выбранному варианту/);
  assert.match(stand, /Записать отправку ответа/);
  assert.match(stand, /Записать отправку вопроса/);
  assert.match(stand, /Передать ответ агенту/);
  assert.match(stand, /оценит масштаб диапазоном/);
  assert.match(
    stand,
    /result\.calculation\.kind === "fence-area"/,
  );
  assert.match(
    stand,
    /result\.calculation\.source === "распознанное фото"/,
  );
  assert.match(stand, /данные из переписки/);
  assert.match(stand, /% технологического запаса/);
  assert.match(stand, /Агент перечитает склад/);
  assert.match(stand, /пересчёт запускается сам/);
  assert.match(stand, /Живой склад обновлён/);
  assert.match(stand, /Пересчитать заказ по новому остатку/);
  assert.match(
    stand,
    /savedRecalculation\.before\.result\?\.product\?\.stockKg[\s\S]*?savedRecalculation\.after\.result\?\.product\?\.stockKg/,
  );
  assert.match(stand, /customerLetterForTransition/);
  assert.match(
    stand,
    /option\.reply\.trim\(\) === result\.reply\.body\.trim\(\)/,
  );
  assert.match(stand, /вариант «\$\{visibleTransition\.beforeOptionTitle\}»/);
  assert.doesNotMatch(
    stand,
    /beforeStock:[\s\S]{0,220}zoneCopy\[savedRecalculation\.before\.zone\]\.name/,
  );
  assert.match(stand, /action: "recalculate"/);
  assert.match(stand, /hash = \(hash \* 31 \+ character\.charCodeAt\(0\)\)/);
  assert.doesNotMatch(stand, /id\.slice\(-6\)\.toUpperCase\(\)/);
  assert.match(
    stand,
    /activeOrderUsesPaint[\s\S]*?await requestRecalculation\(orderId\)/,
  );
  assert.match(
    stand,
    /Нажмите на пунктирную фразу/,
  );
  assert.match(stand, /Почему агент так решил/);
  assert.match(stand, /карточк\[аи\]\.\*продолж\|тем же номером/);
  assert.match(stand, /Страница заказа и история переписки/);
  assert.match(
    stand,
    /Исходное письмо, вопросы и ответы клиента сохраняются под одним номером заявки/,
  );
  assert.match(stand, /checkedAt: "во время этого расчёта"/);
  assert.match(stand, /Что подтверждает вывод/);
  assert.match(stand, /Проверено по источникам/);
  assert.match(stand, /Источники для проверки/);
  assert.match(stand, /Ежедневная модель и отдельная проверка/);
  assert.match(stand, /Автоматическая обработка по правилам/);
  assert.match(stand, /Записанный демонстрационный прогон/);
  assert.ok(
    modelData.options.some(
      (model) => model.label === "DeepSeek V4 Flash · API DeepSeek",
    ),
  );
  assert.match(
    stand,
    /modelCatalog\.options[\s\S]*?roles\.includes\("primary"\)[\s\S]*?\.map\(/u,
  );
  assert.match(stand, /GPT-5\.6 Sol/);
  assert.match(stand, /Команда улучшает правила по журналу/);
  assert.match(
    stand,
    /GPT-5\.6 Sol готовит новую редакцию инструкции/,
  );
  assert.match(
    stand,
    /учебный источник проверен перед подготовкой вариантов[\s\S]*?Данные из таблицы поставщиков сверены перед подготовкой вариантов/,
  );
  assert.match(
    stand,
    /function dateFromStorage[\s\S]*?formatEventTime[\s\S]*?dateFromStorage\(value\)/,
  );
  assert.match(stand, /Работа за сегодня в одной таблице/);
  assert.match(stand, /Скачать журнал за сегодня/);
  assert.match(stand, /Открыть таблицу вебинара в Google Таблицах/);
  assert.match(stand, /Скопировать формулу для Google Таблиц/);
  assert.match(
    stand,
    /Модель для ежедневных заказов[\s\S]*?Свободная заявка сохранится в очереди без подмены автоматическими правилами/,
  );
  assert.doesNotMatch(stand, /disabled=\{!bridgeOnline\}/);
  assert.match(stand, /role="progressbar"/);
  assert.match(stand, /role="log"/);
  assert.match(stand, /Предыдущее решение сохранено/);
  assert.match(
    stand,
    /Это не активное решение: агент готовит новый результат/,
  );
  assert.match(stand, /Предыдущее решение · история/);
  assert.match(
    stand,
    /disabled=\{\s*Boolean\(approving\) \|\| inventoryChanged \|\| !canManageOrder\s*\}/,
  );
  assert.match(stand, /previousFocus\?\.focus\(\)/);
  assert.match(
    stand,
    /result\.research\.checked \|\|\s*result\.research\.sources\.length > 0/,
  );
  assert.match(
    stand,
    /Агент завершил поиск и оставил на странице заказа только\s+проверяемые факты/,
  );
  assert.match(
    stand,
    /Данные о красках и запасах, сгенерированные для демонстрации на/,
  );
  assert.match(stand, /Учебная цена «Колера»/);
  assert.match(stand, /Предварительный учебный расчёт/);
  assert.match(
    stand,
    /Открытая веб-страница даёт лишь контакт для проверки и\s+не меняет точный расчёт/,
  );
  assert.match(layout, /Колер — агент отдела продаж завода красок/);
  assert.match(layout, /Geologica, Golos_Text/);
  assert.ok(
    paintData.products.every(
      (product) =>
        typeof product.name === "string" &&
        /краск/iu.test(product.name) &&
        !/[A-Za-z]{3,}/.test(product.name),
    ),
  );
  assert.doesNotMatch(
    stand,
    /Сохранённый заказ|промптом|демонстрационный агентный контур|данные синтетические/i,
  );
  assert.doesNotMatch(stand, /(^|\s)не\s[^.!?\n]{0,160}\sа\s/i);
  assertSentenceCaseHeadings(stand);
  assert.doesNotMatch(`${page}\n${stand}\n${layout}`, /codex-preview|SkeletonPreview/i);
  assert.match(
    agentRoute,
    /eq\(orderEvents\.state, "active"\)[\s\S]*?set\(\{ state: "done" \}\)|set\(\{ state: "done" \}\)[\s\S]*?eq\(orderEvents\.state, "active"\)/,
  );
  assert.match(
    ordersRoute,
    /Заказ сохранён для[\s\S]*?Агент продолжит после восстановления соединения/,
  );
  assert.match(stand, /Повторить этот заказ/);
  assert.match(stand, /const latestOrderStorageKey = "koler-latest-order"/);
  assert.match(
    stand,
    /new URLSearchParams\(window\.location\.search\)[\s\S]*?sessionStorage\.getItem\(latestOrderStorageKey\)/,
  );
  assert.match(
    stand,
    /Во время вебинара участник на минуту принимает роль руководителя/,
  );
  assert.match(
    stand,
    /humanizeText\(visibleTransition\.beforeReply\)[\s\S]*?humanizeText\(visibleTransition\.afterReply\)/,
  );
  assert.match(stand, /Запускаем заказ снова/);
  assert.match(stand, /action:\s*"retry"/);
  assert.match(
    stand,
    /previousResult &&[\s\S]*?Предыдущее решение сохранено[\s\S]*?Это не активное решение/,
  );
  for (const mutation of [
    sourceBetween(stand, "const updateInventory =", "const updateMarket ="),
    sourceBetween(stand, "const updateMarket =", "const openLedgerOrder ="),
  ]) {
    assert.match(
      mutation,
      /reconcileMutation\([\s\S]*?mutationPostconditionMet/,
    );
    assert.match(mutation, /void loadLedger\(\)[\s\S]*?void loadStats\(\)/);
    assert.match(mutation, /const beforeRoundNo = order\?\.roundNo \?\? 1/);
    assert.match(mutation, /const \[refreshed[^\]]*refreshedOrder\]/);
  }
  assert.doesNotMatch(
    sourceBetween(
      ordersRoute,
      "export async function GET",
      "export async function POST",
    ),
    /buildDemoResult\(/,
  );
  assert.match(
    ordersRoute,
    /action === "customer_reply"[\s\S]*?roundNo:\s*order\.roundNo \+ 1/,
  );
  assert.match(
    ordersRoute,
    /action === "recalculate"[\s\S]*?inventorySnapshotJson:\s*JSON\.stringify\(inventorySnapshot\)/,
  );
  assert.match(
    ordersRoute,
    /action === "recalculate"[\s\S]*?mode:\s*"recorded-demo"/,
  );
  assert.match(
    ordersRoute,
    /action === "recalculate"[\s\S]*?const liveMode = supplierOutdated[\s\S]*?"opencode-supplier-recalculate"[\s\S]*?mode:\s*liveMode/,
  );
  assert.match(
    agentRoute,
    /"opencode-supplier-recalculate"[\s\S]*?"Поставщик перечитан"[\s\S]*?supplier-model:/,
  );
  assert.match(
    stand,
    /Письмо до обновления склада[\s\S]*?visibleTransition\.beforeReply[\s\S]*?Письмо после обновления склада[\s\S]*?visibleTransition\.afterReply/,
  );
  assert.match(
    ordersRoute,
    /action === "send"[\s\S]*?savedResultUsesOldInventory\(order\)/,
  );
  assert.match(
    ordersRoute,
    /order\.status !== "awaiting_approval"[\s\S]*?savedResultUsesOldInventory\(order\)/,
  );
});

test("clears the selected order view before opening another order", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );
  const clearView = sourceBetween(stand, "const clearOrderView", "const loadSystem");
  const openOrder = sourceBetween(stand, "const openOrder", "useEffect(() => {");
  const loadOrder = sourceBetween(stand, "const loadOrder", "const reconcileOrder");

  assert.match(clearView, /orderLoadGateRef\.current\.invalidate\(\)/);
  assert.match(clearView, /orderLoadControllerRef\.current\?\.abort\(\)/);
  assert.match(clearView, /setOrder\(null\)/);
  assert.match(clearView, /setEvents\(\[\]\)/);
  assert.match(clearView, /setOrderResultHistory\(\[\]\)/);
  assert.match(clearView, /setSupplierRefreshNeeded\(false\)/);
  assert.match(openOrder, /clearOrderView\(\)/);
  assert.match(openOrder, /currentOrderIdRef\.current = nextId/);
  assert.match(openOrder, /setOrderId\(nextId\)/);
  assert.match(loadOrder, /currentOrderIdRef\.current !== id/);
  assert.match(loadOrder, /currentOrderIdRef\.current === id/);
  assert.match(loadOrder, /orderLoadGateRef\.current\.isCurrent\(generation\)/);
  assert.match(stand, /const showResult =/);
  assert.match(stand, /!orderIsActive && processingState !== "error"/);
});

test("labels live processing states and does not promise offline fallback", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );

  assert.match(stand, /function orderProcessingCopy\(state: string\)/);
  assert.match(stand, /В очереди · ждёт live-агента/);
  assert.match(stand, /Агент работает · связь подтверждена/);
  assert.match(stand, /formatEventTime\(order\.updatedAt\)/);
  assert.match(stand, /Последний подтверждённый сигнал этого запуска/);
  assert.match(stand, /Время агента истекло · карточка сохранена/);
  assert.match(stand, /Ошибка обработки · можно повторить/);
  assert.match(stand, /Повторите этот же заказ/);
  assert.match(stand, /Live-agent сейчас недоступен: сайт сохраняет заявку в очереди/);
  assert.match(stand, /Записанный демонстрационный режим запускается только по явному выбору/);
  assert.doesNotMatch(
    stand,
    /bridgeOnline[\s\S]{0,600}Новое решение и письмо сохранились на странице заказа/u,
  );
});

test("clears preset-only state after a custom photo upload", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );
  const uploadPhoto = sourceBetween(
    stand,
    "const uploadPhoto",
    "const removePhoto",
  );

  assert.match(uploadPhoto, /demoKind:\s*undefined/);
  assert.match(uploadPhoto, /setCustomerAnswer\(\s*""\s*\)/);
});

test("prioritizes the specific source for market and rules proofs", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );
  const decisionProofs = sourceBetween(
    stand,
    "function DecisionProofs",
    "function LiveInventoryPanel",
  );

  assert.match(
    decisionProofs,
    /\/поставщик\|рын\|средн\.\*цен\|цен\.\*\(\?:выше\|ниже\|близк\)\/i\.test\(insight\)[\s\S]*?\[\s*\/поставщик\/i,\s*\/похож\|рын\|предложен\/i\s*\]/,
  );
  assert.match(
    decisionProofs,
    /\/правил\|инструк\|письм\/i\.test\(insight\)\s*\?\s*\[\s*\/три правила продаж\/i\s*,/,
  );
});

test("explains the stand calculation, manager role and saved recalculation", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );

  assert.match(stand, /Режим: агент подключён/);
  assert.match(stand, /Режим: агент временно недоступен/);
  assert.doesNotMatch(stand, /Режим: обработка по правилам/);
  assert.match(stand, /Записанный демонстрационный прогон/);
  assert.match(stand, /Руководитель выбирает условия сделки/);
  assert.match(
    stand,
    /Подтверждает скидку, оплату после поставки, срочную отгрузку\s+или частичную поставку/,
  );
  assert.match(
    stand,
    /Обе версии сохранились на странице заказа и в журнале\.\s+Свежее\s+письмо ждёт вашего подтверждения\./,
  );
});

test("prepares a contract reserve before the stand send", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );
  const reserveAction = sourceBetween(
    stand,
    "const prepareReserve",
    "const sendReply",
  );
  const eventKind = sourceBetween(
    stand,
    "const eventKind",
    "const rows",
  );

  assert.match(reserveAction, /setReserving\(true\)/);
  assert.match(
    reserveAction,
    /JSON\.stringify\(\{ id: orderId, action: "reserve" \}\)/,
  );
  assert.match(reserveAction, /setReserving\(false\)/);
  assert.match(
    stand,
    /canSend =[\s\S]*?canManageOrder[\s\S]*?reserved && isCommercialOffer[\s\S]*?order\.status === "ready_to_send" && isEstimate/,
  );
  assert.match(stand, /Записать отправку оценки/);
  assert.match(stand, /Резерв товара подготовлен/);
  assert.match(stand, /Подготовить резерв товара/);
  assert.match(
    stand,
    /Рабочая\s+система передаст резерв в учётную систему компании/,
  );
  assert.match(stand, /Путь ответа клиенту/);
  assert.match(
    stand,
    /Ответ готов[\s\S]*?Резерв товара[\s\S]*?Отправка/,
  );
  assert.match(
    stand,
    /\$\{quantity\.trim\(\)\} кг осталось после других заказов/,
  );
  assert.doesNotMatch(stand, /действующ(?:ий|ие|их)\s+резерв/iu);
  assert.match(
    eventKind,
    /stage === "reserve"\)\s+return "Резерв товара"/,
  );
  assert.match(stand, /Руководитель подтвердил выбранный вариант/);
  assert.match(
    stand,
    /Завод зарабатывает при цене от \$\{floor\.trim\(\)\} ₽\/кг/,
  );
  assert.match(
    stand,
    /\.replace\(\/руководитель согласует\/gi, "руководитель подтверждает"\)/,
  );
  assert.match(
    stand,
    /Что можно красить:[\s\S]*Где\s+использовать:[\s\S]*Что важно:/,
  );
  assert.doesNotMatch(stand, /Основание:/);
});

test("names the model roles honestly in the visible activity log", async () => {
  const stand = await readFile(
    new URL("../app/order-stand.tsx", import.meta.url),
    "utf8",
  );
  const eventActor = sourceBetween(
    stand,
    "const eventActor",
    "const eventKind",
  );
  const eventKind = sourceBetween(
    stand,
    "const eventKind",
    "const rows",
  );

  assert.match(
    eventActor,
    /\["vision", "vision-result"\][\s\S]*?"Модель для фотографий"/,
  );
  assert.match(
    eventActor,
    /stage === "review"[\s\S]*?\/модел\/iu\.test\(title\)[\s\S]*?"Модель проверки"[\s\S]*?"Программа проверки"/,
  );
  assert.match(
    eventActor,
    /stage === "review-fallback"[\s\S]*?"Модель проверки недоступна"[\s\S]*?stage === "review-skipped"[\s\S]*?"Проверка не запускалась"/,
  );
  assert.match(eventActor, /"model"[\s\S]*?"Система"/);
  assert.match(stand, /actor: eventActor\(item\.stage, item\.title\)/);
  assert.match(eventKind, /stage === "model"\) return "Выбор модели"/);
  assert.match(
    eventKind,
    /\["vision", "vision-result"\][\s\S]*?"Осмотр фотографии"/,
  );
  assert.match(eventKind, /"review-skipped"[\s\S]*?"Проверка не запускалась"/);
});
