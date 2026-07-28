import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ships the Колер product surface and removes the starter", async () => {
  const [page, stand, layout, scenarios, agentRoute, ordersRoute] =
    await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/order-stand.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../data/order-scenarios.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/orders/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<OrderStand \/>/);
  assert.match(stand, /Письмо клиента становится готовым решением/);
  assert.match(stand, /Форма письма → карточка → OpenCode → выбранная модель/);
  assert.match(stand, /Google-таблица демонстрации/);
  assert.match(stand, /Другой пример/);
  assert.match(stand, /Отправить агенту/);
  assert.match(stand, /Зелёная зона/);
  assert.match(stand, /Жёлтая зона/);
  assert.match(stand, /Красная зона/);
  assert.match(stand, /Вариант согласован · готово к отправке/);
  assert.match(stand, /Завершить демо-отправку/);
  assert.match(stand, /фиксированный снимок/);
  assert.match(stand, /Ручной разбор журнала/);
  assert.match(stand, /disabled=\{!bridgeOnline\}/);
  assert.match(stand, /role="progressbar"/);
  assert.match(stand, /role="log"/);
  assert.match(stand, /disabled=\{Boolean\(approving\)\}/);
  assert.match(stand, /previousFocus\?\.focus\(\)/);
  assert.match(
    stand,
    /result\.research\.checked \|\|\s*result\.research\.sources\.length > 0/,
  );
  assert.match(
    stand,
    /Агент завершил поиск\. Надёжных публичных источников для решения не/,
  );
  assert.match(
    stand,
    /Данные о красках и запасах, сгенерированные для демонстрации на/,
  );
  assert.match(layout, /Колер — агент отдела продаж завода красок/);
  assert.match(layout, /Geologica, Golos_Text/);
  assert.equal((scenarios.match(/\bbody:\s*"/g) ?? []).length, 30);
  assert.ok(scenarios.indexOf('id: "green"') < scenarios.indexOf('id: "yellow"'));
  assert.ok(scenarios.indexOf('id: "yellow"') < scenarios.indexOf('id: "red"'));
  assert.doesNotMatch(
    stand,
    /Сохранённый заказ|промптом|демонстрационный агентный контур|данные синтетические/i,
  );
  assert.doesNotMatch(stand, /(^|\s)не\s[^.!?\n]{0,160}\sа\s/i);
  assert.doesNotMatch(`${stand}\n${layout}`, /КОЛЕР/);
  assert.doesNotMatch(`${page}\n${stand}\n${layout}`, /codex-preview|SkeletonPreview/i);
  assert.match(
    agentRoute,
    /eq\(orderEvents\.state, "active"\)[\s\S]*?set\(\{ state: "done" \}\)|set\(\{ state: "done" \}\)[\s\S]*?eq\(orderEvents\.state, "active"\)/,
  );
  assert.match(ordersRoute, /Автономные правила продолжили заказ/);
  assert.match(ordersRoute, /datetime\('now', '-1 minute'\)/);
});
