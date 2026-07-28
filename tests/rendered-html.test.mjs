import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ships the КОЛЕР product surface and removes the starter", async () => {
  const [page, stand, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/order-stand.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<OrderStand \/>/);
  assert.match(stand, /Проведите заказ через агента/);
  assert.match(stand, /Агент покажет ход решения/);
  assert.match(stand, /Отправить агенту/);
  assert.match(stand, /Зелёная зона/);
  assert.match(stand, /Жёлтая зона/);
  assert.match(stand, /Красная зона/);
  assert.match(layout, /КОЛЕР — агент отдела продаж завода красок/);
  assert.match(layout, /Geologica, Golos_Text/);
  assert.doesNotMatch(stand, /Сохранённый заказ|промптом/);
  assert.doesNotMatch(`${page}\n${stand}\n${layout}`, /codex-preview|SkeletonPreview/i);
});
