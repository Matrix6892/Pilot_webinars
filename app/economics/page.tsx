import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Экономика агента — Колер",
  description:
    "Синтетический расчёт экономической эффективности агентного отдела продаж для демонстрации на вебинаре.",
};

const rows = [
  {
    label: "Вопросов от клиентов за день",
    value: "20",
    note: "письма и фото в свободной форме",
  },
  {
    label: "Полезный ответ в пределах склада",
    value: "13",
    note: "зелёный и жёлтый маршрут: диапазон, подбор, пробный выкрас",
  },
  {
    label: "Сделок спасено при дефиците",
    value: "4",
    note: "красный маршрут: поставщик найден, руководитель выбрал вариант",
  },
  {
    label: "Сделок закрыто к концу дня",
    value: "7",
    note: "конверсия 35% от вопросов — консервативно для входящего потока",
  },
];

const money = [
  {
    label: "Выручка дня",
    value: "126 000 ₽",
    note: "7 сделок × средний чек 18 000 ₽",
  },
  {
    label: "Стоимость токенов за день",
    value: "≈ 1 200 ₽",
    note: "20 заявок × ≈ 60 ₽: три вызова Flash на карточку",
  },
  {
    label: "Время сотрудника",
    value: "0 часов",
    note: "руководитель тратит минуты на 4 готовых варианта, не на переписку",
  },
  {
    label: "Окупаемость дня",
    value: "×105",
    note: "выручка дня к стоимости токенов дня",
  },
];

const compare = [
  {
    was: "Менеджер отвечает 4–6 часов на 20 писем",
    now: "Агент отвечает параллельно, p50 ≈ 2–3 минуты на карточку",
  },
  {
    was: "Ночь и выходные — очередь молчит",
    now: "Очередь живёт круглосуточно, утром готовые варианты",
  },
  {
    was: "Дефицит = «нет в наличии, извините»",
    now: "Дефицит = план из двух партий и спасённая сделка",
  },
];

export default function EconomicsPage() {
  return (
    <main className="eco-shell">
      <header className="eco-head">
        <p className="eyebrow">Синтетический расчёт для демонстрации</p>
        <h1>Двадцать вопросов, которые раньше съедали день</h1>
        <p className="eco-lead">
          Цифры ниже — учебная модель на данных стенда «Колер», а не рыночная
          котировка: так же, как цены 349 и 361 ₽/кг в живом сценарии. Формулы
          открыты, чтобы вы подставили свои средний чек и конверсию.
        </p>
      </header>

      <section className="eco-grid" aria-label="Воронка дня">
        {rows.map((row) => (
          <article key={row.label} className="eco-cell">
            <strong>{row.value}</strong>
            <span>{row.label}</span>
            <small>{row.note}</small>
          </article>
        ))}
      </section>

      <section className="eco-money" aria-label="Деньги дня">
        {money.map((row) => (
          <article key={row.label} className="eco-cell eco-cell-ink">
            <span>{row.label}</span>
            <strong>{row.value}</strong>
            <small>{row.note}</small>
          </article>
        ))}
      </section>

      <section className="eco-compare" aria-label="Было и стало">
        <h2>Что меняется в отделе</h2>
        <ul>
          {compare.map((row) => (
            <li key={row.was}>
              <span>{row.was}</span>
              <span>{row.now}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="eco-foot">
        <p>
          Токены считаются по тарифам DeepSeek V4 Flash на момент показа; модель
          дешевле человеческого часа на порядки, но честная единица сравнения —
          не «дешевле ли агент», а «сколько спасённых сделок на рубль токенов».
        </p>
        <a href="/">Вернуться к живому стенду</a>
      </footer>
    </main>
  );
}
