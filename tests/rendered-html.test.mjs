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
    scenarios,
    agentRoute,
    ordersRoute,
    paintSource,
    modelsSource,
  ] = await Promise.all([
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/order-stand.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../data/order-scenarios.ts", import.meta.url), "utf8"),
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
    /Клиент пишет своими словами\.\s*Агент ведёт заказ до письма клиенту/,
  );
  assert.match(stand, /На стенде форму отправляют/);
  assert.match(stand, /Медицинский склад/);
  assert.match(stand, /Обычный склад/);
  assert.match(stand, /Другое помещение/);
  assert.match(stand, /Как используют помещение\?/);
  assert.match(stand, /Руководитель одобрил запрос/);
  assert.match(stand, /Агент нашёл, как собрать все/);
  assert.match(stand, /Расчёт варианта с другим поставщиком/);
  assert.match(stand, /Что подтверждаем перед итоговым письмом/);
  assert.match(stand, /Попробовать с фото забора/);
  assert.match(stand, /Показать, как агент сохраняет большой заказ/);
  assert.match(stand, /Заполнить свой заказ/);
  assert.match(stand, /Заявка на подбор краски/);
  assert.match(stand, /customDraft \? "Ваш заказ" : "Готовый пример"/);
  assert.match(stand, /Свой заказ/);
  assert.match(stand, /className="system-map-mobile"/);
  assert.match(stand, /Наша часть/);
  assert.match(stand, /в строке партнёра видно/);
  assert.match(stand, /до полного\s+заказа/);
  assert.match(stand, /Расчёт для сравнения; сейчас у «Колера» доступно/);
  assert.match(stand, /В учебной строке от/);
  assert.match(stand, /Цены и наличие у других поставщиков/);
  assert.match(stand, /Где начинается агентная работа/);
  assert.match(
    stand,
    /Чат помогает подготовить текст[\s\S]*?агент ждёт ответ клиента[\s\S]*?пересчитывает план/,
  );
  assert.match(stand, /Описание заказа и фото/);
  assert.match(stand, /Модель для фото описала видимые детали/);
  assert.match(stand, /Модель для фото описывает видимое/);
  assert.match(
    stand,
    /Поставка двумя партиями опирается на подтверждённый остаток/,
  );
  assert.match(stand, /сравнение с ценами других поставщиков/);
  assert.match(stand, /остаток на момент расчёта/);
  assert.match(stand, /Проверенные данные/);
  assert.match(stand, /Сведения о клиенте/);
  assert.match(stand, /Общая память/);
  assert.match(stand, /<details className="zone-guide" open>/);
  assert.match(
    stand,
    /bridgeOnline[\s\S]*?Модель для фото описывает видимые детали[\s\S]*?Стенд читает заявку, обращается к живому складу, считает заказ/,
  );
  assert.match(stand, /Google[- ]таблиц|Google Таблиц/iu);
  assert.match(stand, /Другой пример/);
  assert.match(stand, /type="file"/);
  assert.match(stand, /fetch\("\/api\/uploads"/);
  assert.match(stand, /Заменить фотографию/);
  assert.match(stand, /Убрать фотографию/);
  assert.match(
    stand,
    /Boolean\(draft\.attachment\) && \(!product \|\| !routeQuantity\)/,
  );
  assert.match(stand, /Фотография останется в карточке/);
  assert.match(
    stand,
    /Заявка и фотография войдут в открытый журнал вебинара/,
  );
  assert.match(stand, /Отправить агенту/);
  assert.match(stand, /Готов ответить/);
  assert.match(stand, /Нужны детали/);
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
  assert.match(stand, /Записать отправку вопросов/);
  assert.match(stand, /Передать ответ агенту/);
  assert.match(stand, /посчитает килограммы/);
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
  assert.match(stand, /40 кг · агент принесёт варианты/);
  assert.match(stand, /180 кг · агент подготовит письмо/);
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
  assert.match(stand, /Карточка и история переписки/);
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
  assert.match(stand, /Автоматическая обработка по правилам и живому складу/);
  assert.ok(
    modelData.options.some((model) => model.label === "DeepSeek V4 Flash"),
  );
  assert.match(stand, /GPT-5\.6 Sol/);
  assert.match(stand, /Команда улучшает правила по журналу/);
  assert.match(
    stand,
    /GPT-5\.6 Sol предлагает правки, руководитель принимает/,
  );
  assert.match(stand, /Работа за сегодня в одной таблице/);
  assert.match(stand, /Скачать журнал за сегодня/);
  assert.match(stand, /Открыть таблицу вебинара в Google Таблицах/);
  assert.match(stand, /Скопировать формулу для Google Таблиц/);
  assert.match(
    stand,
    /bridgeOnline \? \([\s\S]*?Обработка заявки[\s\S]*?Подготовленные правила и живой склад/,
  );
  assert.doesNotMatch(stand, /disabled=\{!bridgeOnline\}/);
  assert.match(stand, /role="progressbar"/);
  assert.match(stand, /role="log"/);
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
    /Агент завершил поиск и оставил в карточке только проверяемые\s+факты/,
  );
  assert.match(
    stand,
    /Данные о красках и запасах, сгенерированные для демонстрации на/,
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
  assert.equal((scenarios.match(/\bbody:\s*"/g) ?? []).length, 30);
  assert.ok(scenarios.indexOf('id: "green"') < scenarios.indexOf('id: "yellow"'));
  assert.ok(scenarios.indexOf('id: "yellow"') < scenarios.indexOf('id: "red"'));
  assert.match(scenarios, /demoKind:\s*"fence-photo"/);
  assert.match(scenarios, /Хочу покрасить забор/);
  assert.match(scenarios, /какая краска нужна и сколько покупать/);
  assert.match(scenarios, /ГК «ПРОТЕК»/);
  assert.match(
    scenarios,
    /краска для пола в новом помещении площадью 800 м²/,
  );
  assert.match(scenarios, /Пол моют каждый день/);
  assert.ok(
    scenarios.indexOf("Хочу покрасить забор") <
      scenarios.indexOf("ГК «ПРОТЕК»"),
  );
  assert.match(scenarios, /ИНН 7805059867/);
  assert.ok(
    scenarios.indexOf("ИНН 7805059867") <
      scenarios.indexOf('company: "СтройКомплект"'),
  );
  assert.match(
    scenarios,
    /Нужны 100 кг коричневой краски для деревянных конструкций на улице/,
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
  assert.match(ordersRoute, /Карточка продолжила работу/);
  assert.match(stand, /Повторить эту карточку/);
  assert.match(stand, /const latestOrderStorageKey = "koler-latest-order"/);
  assert.match(
    stand,
    /new URLSearchParams\(window\.location\.search\)[\s\S]*?sessionStorage\.getItem\(latestOrderStorageKey\)/,
  );
  assert.match(
    stand,
    /На стенде участник на минуту принимает роль руководителя/,
  );
  assert.match(
    stand,
    /humanizeText\(visibleTransition\.beforeReply\)[\s\S]*?humanizeText\(visibleTransition\.afterReply\)/,
  );
  assert.match(stand, /Запускаем карточку снова/);
  assert.match(stand, /action:\s*"retry"/);
  assert.match(ordersRoute, /datetime\('now', '-1 minute'\)/);
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
    /action === "recalculate"[\s\S]*?mode:\s*"autonomous-demo"/,
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

  assert.match(stand, /Режим: обработка по правилам/);
  assert.match(stand, /Автоматическая обработка по правилам и живому складу/);
  assert.match(stand, /Руководитель выбирает условия сделки/);
  assert.match(
    stand,
    /Подтверждает скидку, оплату после поставки, срочную отгрузку\s+или частичную поставку/,
  );
  assert.match(
    stand,
    /Обе версии сохранились в карточке и журнале\.\s+Свежее письмо ждёт\s+вашего подтверждения\./,
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
    /order\.status === "ready_to_send"[\s\S]*?canSend = canManageOrder && reserved && !inventoryChanged/,
  );
  assert.match(stand, /Резерв товара подготовлен/);
  assert.match(stand, /Подготовить резерв товара/);
  assert.match(
    stand,
    /Рабочая система\s+передаст его в учётную систему компании/,
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
  assert.match(eventActor, /stage === "review-fallback"[\s\S]*?"Программа проверки"/);
  assert.match(eventActor, /"model"[\s\S]*?"Программа стенда"/);
  assert.match(stand, /actor: eventActor\(item\.stage, item\.title\)/);
  assert.match(eventKind, /stage === "model"\) return "Выбор модели"/);
  assert.match(
    eventKind,
    /\["vision", "vision-result"\][\s\S]*?"Осмотр фотографии"/,
  );
});
