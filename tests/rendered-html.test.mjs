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
    /Клиент пишет своими словами\.\s*Агент ведёт заказ до ответа/,
  );
  assert.match(stand, /На стенде заявку создаёт форма/);
  assert.match(stand, /Письмо или фото/);
  assert.match(stand, /Модель для фото описала видимые детали/);
  assert.match(stand, /Модель для фото подключается отдельно/);
  assert.match(
    stand,
    /Поставка двумя партиями опирается на подтверждённый остаток/,
  );
  assert.match(stand, /сравнение с ценами других поставщиков/);
  assert.match(stand, /остаток на момент расчёта/);
  assert.match(stand, /Проверенные данные/);
  assert.match(stand, /Сведения о клиенте/);
  assert.match(stand, /Журнал всех заказов/);
  assert.match(stand, /Google[- ]таблиц|Google Таблиц/iu);
  assert.match(stand, /Другой пример/);
  assert.match(stand, /type="file"/);
  assert.match(stand, /fetch\("\/api\/uploads"/);
  assert.match(stand, /Заменить фотографию/);
  assert.match(stand, /Убрать фотографию/);
  assert.match(
    stand,
    /Заявка и фотография войдут в открытый журнал вебинара/,
  );
  assert.match(stand, /Отправить агенту/);
  assert.match(stand, /Готов ответить/);
  assert.match(stand, /Нужны детали/);
  assert.match(stand, /Решает руководитель/);
  assert.match(stand, /Вариант согласован · ответ готов/);
  assert.match(stand, /Польза клиенту/);
  assert.match(stand, /Результат для завода/);
  assert.match(stand, /Что учесть/);
  assert.match(stand, /Отправить на стенде/);
  assert.match(stand, /Отправить вопросы на стенде/);
  assert.match(stand, /Продолжить эту карточку/);
  assert.match(stand, /посчитает килограммы/);
  assert.match(stand, /Новый остаток уже виден/);
  assert.match(stand, /40 кг · агент принесёт варианты/);
  assert.match(stand, /180 кг · агент подготовит письмо/);
  assert.match(stand, /Агент сам\s+пересчитывает заказ/);
  assert.match(stand, /Живой склад обновлён/);
  assert.match(stand, /Обновить черновик по новому остатку/);
  assert.match(
    stand,
    /savedRecalculation\.before\.result\?\.product\?\.stockKg[\s\S]*?savedRecalculation\.after\.result\?\.product\?\.stockKg/,
  );
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
  assert.match(stand, /Что подтверждает вывод/);
  assert.match(stand, /Проверено по источникам/);
  assert.match(stand, /Как недорогая модель ведёт заказ/);
  assert.match(stand, /Как программа ведёт заказ по готовым правилам/);
  assert.match(stand, /Расчёт по готовым правилам и живому складу/);
  assert.ok(
    modelData.options.some((model) => model.label === "DeepSeek V4 Flash"),
  );
  assert.match(stand, /GPT-5\.6 Sol/);
  assert.match(stand, /Команда улучшает правила по журналу/);
  assert.match(
    stand,
    /Сильная модель предлагает правки, руководитель принимает/,
  );
  assert.match(stand, /Работа за сегодня в одной таблице/);
  assert.match(stand, /Скачать весь журнал для Google Таблиц/);
  assert.match(stand, /Открыть общий журнал вебинара в Google Таблицах/);
  assert.match(stand, /Скопировать формулу для Google Таблиц/);
  assert.match(stand, /disabled=\{!bridgeOnline\}/);
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
    /index === 0\s*\?\s*\[\s*\/поставщик\/i\s*,/,
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

  assert.match(stand, /Считает программа стенда по живому складу/);
  assert.match(stand, /Расчёт по готовым правилам и живому складу/);
  assert.match(stand, /Руководитель подтверждает обязательства/);
  assert.match(
    stand,
    /При скидке, оплате после поставки или нехватке выбирает один\s+подготовленный вариант и открывает отправку письма/,
  );
  assert.match(
    stand,
    /Во время пересчёта согласование и отправка оставались закрытыми\.\s+Обе версии сохранились в карточке и журнале\.\s+Теперь письмо ждёт\s+вашего подтверждения\./,
  );
});
