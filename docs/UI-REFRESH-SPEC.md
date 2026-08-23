# UI-REFRESH-SPEC: «Колер», хирургический визуальный редизайн

Статус: прескрипция для реализации. Исполнитель меняет **только** значения в `app/globals.css` и, где явно указано, строку `className`/CSS-переменную в разметке. JSX-структура, состояние, обработчики, тексты, `id`, `aria-*`, `ref` не трогаются.

Файлы-источники аудита: `app/globals.css` (5302 строки), `app/order-stand.tsx` (5979 строк), `app/layout.tsx`, `tests/rendered-html.test.mjs`.

---

## 1. Design Read и dials

**Design Read:** живой демо-стенд B2B для владельцев малого бизнеса на вебинаре: trust-first «дорогой производственный» язык завода красок, тёплая бумажно-охристая система с одним пигментным акцентом и жёсткой семантикой маршрутов green/yellow/red; визуал должен держать проектор и эфир, а не развлекать.

| Dial | Значение | Обоснование |
|---|---|---|
| DESIGN_VARIANCE | **4** | Trust-first B2B + данные заказа. Ровная сетка допустима; вариативность достигается тональными блоками (светлая бумага / тёмные панели) и деунификацией триад, а не асимметрией. |
| MOTION_INTENSITY | **2** | Демо идёт в эфире. Разрешены только существующие семантические анимации (`breathe`, `pulse`, `rise`) и hover/active-отклик. Никаких entry-каскадов, параллакса, бесконечных циклов. |
| VISUAL_DENSITY | **6** | Стенд показывает журнал событий, таблицы склада и поставщиков, варианты сделки. Данные дышат, но остаются данными: плотные списки с крупными якорями (цифры метрик, статусы зон). |

Режим редизайна: **Redesign - Preserve** (аудит выполнен, брендовые токены извлечены, эволюция значений без смены языка).

---

## 2. Токены

### 2.1 Шрифты: статус подключения

Шрифты подключены в `app/layout.tsx` через `next/font/google`: `Geologica` (переменная `--font-geologica`, заголовки) и `Golos_Text` (`--font-golos`, текст), обе с `subsets: ["cyrillic", "latin"]`. Next.js скачивает файлы **на этапе сборки** и раздаёт самохостенно: в рантайме внешних запросов к Google Fonts нет. Менять подключение не нужно. Внимание: `tests/rendered-html.test.mjs` проверяет в `layout.tsx` регэксп `/Geologica, Golos_Text/`, поэтому импорт трогать запрещён. Fallback уже корректен: везде `var(--font-golos/geologica), sans-serif`.

Роли закрепляются токенами (добавить в `:root`):

```css
--font-display: var(--font-geologica), sans-serif;
--font-body: var(--font-golos), sans-serif;
```

Допустимые веса (variable-шрифты): 500 / 550 / 600 / 650 / 700 / 800. Прочие значения из кода (540, 570, 610, 760) приводятся к ближайшему из шкалы.

### 2.2 Палитра

Принцип: базовая «бумага + тушь + охра» сохраняется (она брендовая и не AI-slop). Меняются три вещи: глубина акцента, контраст вторичного текста под проектор, двухуровневая система маршрутных цветов (заливка vs текст).

```css
:root {
  /* База: без изменений */
  --ink: #17201d;            /* тушь, тёплый чёрный */
  --ink-soft: #303a36;
  --paper: #f2efe7;          /* тёплая бумага */
  --paper-deep: #e8e3d8;
  --panel: #fffdf8;
  --line: #d4cfc3;
  --line-strong: #aaa397;
  --accent-soft: #f0dfca;

  /* Изменения */
  --accent: #8A4A16;         /* было #9c5c22: глубже, "жжёная сиена";
                                6.0:1 на paper, 6.9:1 белый текст на нём */
  --accent-strong: #6E3A10;  /* новый: hover/active акцентных поверхностей */
  --muted: #555D58;          /* было #686e69 (4.5:1, на грани); стало 5.9:1 на paper */

  /* Маршруты: заливки и точки (семантика демо, НЕ менять оттенки) */
  --green: #23704c;   --green-soft: #e1eee6;
  --yellow: #bd791b;  --yellow-soft: #f7ebcf;
  --red: #b94034;     --red-soft: #f4dfdc;
  --blue: #315c73;    --blue-soft: #e3edf1;   /* только "в работе", не маршрут */

  /* Маршруты: новые текстовые варианты (AA на своих -soft подложках).
     Правило: цветную ТЕКСТОВУЮ строку на тонированной карточке набираем
     только -text-вариантом; исходные --green/--yellow/--red остаются
     для точек, полос, рамок и заливок. */
  --green-text: #1C5A3D;   /* 6.8:1 на --green-soft (было использование #23704c: ~4.1:1) */
  --yellow-text: #7E4D08;  /* 6.0:1 на --yellow-soft (#bd791b давал ~2.9:1 - fail) */
  --red-text: #993127;     /* 5.8:1 на --red-soft */

  /* Тёмные панели (hero-status, control-story, presenter-console):
     фиксируем разрешённые цвета текста на --ink */
  --on-ink-label: #d1ab84;   /* охристые метки, 7+:1 */
  --on-ink-body: #bfc7c3;    /* вторичный текст, >= 6:1 (было #bac2be/#b9c0bd вперемешку) */
}
```

Запрещённые цвета: чистые `#000`/`#fff` как текст/фон поверх фирменных поверхностей, дефолтный синий (`#0d6efd`, Tailwind `blue-500`), фиолетовые и градиентные заливки, macOS-цвета точек окна (`#df7a6d`, `#e3bc64`, `#79ad80` в `.window-dots`).

### 2.3 Типографическая шкала

Добавить токены, применить к существующим селекторам:

| Токен | Значение | Применение |
|---|---|---|
| `--text-display` | `clamp(38px, 4.4vw, 64px)` / вес 600 / lh 1.05 / ls `-0.028em` | `.hero-intro h1` (было clamp(38..68)/610/1.01/-0.048em) |
| `--text-h2` | `clamp(30px, 3.4vw, 52px)` / 580 / 1.06 / `-0.026em` | `.demo-heading h2`, `.control-intro h2`, `.day-heading h2`, `.modal-head h2` |
| `--text-h3` | `clamp(19px, 1.6vw, 24px)` / 600 / 1.25 | заголовки карточек, `.run-head h2` (было clamp(21..33)) |
| `--text-strong-num` | `clamp(42px, 5vw, 72px)` / 550 / 0.92 / `-0.03em` / `tabular-nums` | `.metric-grid strong` (цифры дня) |
| `--text-lead` | `clamp(17px, 1.35vw, 21px)` / 1.5 | `.hero-lead` |
| `--text-body` | 14px / 1.6 | абзацы, письма агента |
| `--text-ui` | 13px / вес 650 | подписи полей, кнопки-ссылки |
| `--text-caption` | 12px / 1.45 | secondary-строки (бывшие 11px поднимаются сюда) |
| `--text-micro` | 11px, только декоративное | нижний предел; всё, что читает зритель, не ниже 12px |

Правила:
- Кириллический трекинг: negative letter-spacing не глубже `-0.03em` на дисплейных размерах (текущие `-0.047…-0.048em` ломают ритм кириллицы, заменить).
- Все числовые значения (цены, кг, часы в `.event-item time`, `.catalog-row strong`, `.metric-grid strong`) получают `font-variant-numeric: tabular-nums`; шрифт цифр везде Geologica.
- Заголовкам оставить `text-wrap: balance` (уже есть глобально).
- Запрет `text-transform: uppercase` для h1-h3 (тест sentence-case читает исходник, но капс на проекторе шумит); капс разрешён только micro-лейблам 10-11px.

### 2.4 Отступы

Шкала 4px: `--s1: 4 · --s2: 8 · --s3: 12 · --s4: 16 · --s5: 20 · --s6: 24 · --s8: 32 · --s10: 40 · --s14: 56 · --s20: 80`.

Приведение хаоса текущих 7-26px к шагам шкалы:
- внутренние отступы карточек: минимум `--s5` (20px); `.option-card` 15→20px; `.event-item` 11x13→14x16px; `.zone-explain` 20→24px;
- grid gap внутри панелей: `--s3` (12px) вместо 7/9/10px;
- вертикальный ритм секций сохранить (clamp уже задан у `.demo-heading`, `.control-story`, `.day-result`), шаг округлять к шкале.

### 2.5 Радиусы

Сейчас зоопарк: 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 24, 26, 999. Сводится к системе:

```css
--r-s: 10px;    /* кнопки, input/select, photo-upload-button, event-item */
--r-m: 14px;    /* карточки: option-card, zone-explain, mail-card, reply-card,
                   process-preview li, research-card */
--r-l: 22px;    /* крупные панели: workbench (26), control-story (24),
                   modal-sheet (24), metric-grid (20), hero-status (18),
                   source-dock (18), agent-difference (16) */
--r-pill: 999px;/* ТОЛЬКО статусы: .connection, .zone-badge, .section-label span,
                   .decision-next-link, .demo-start-actions button */
```

Замены: {8,9}→10; {11,12,13,15,16,17}→14 или 10 по типу элемента (контейнер=14, контрол=10); {18,20,24,26}→22. Фокус-обводка (`outline`) радиус не меняет.

### 2.6 Тени

Единая тёплая система, hue туши `rgb(42 38 28 …)`, максимум две тени на элемент:

```css
--shadow-rest: 0 1px 2px rgb(42 38 28 / 5%), 0 6px 20px rgb(42 38 28 / 5%);
--shadow-float: 0 2px 8px rgb(42 38 28 / 6%), 0 28px 70px rgb(42 38 28 / 10%);
```

- `--shadow` (глобальная, была `0 24px 70px rgb(40 37 29 / 9%)`) → `--shadow-float`.
- `.mail-card` собственная тень → `--shadow-rest`.
- `.modal-sheet`: `rgb(0 0 0 / 28%)` → `rgb(28 25 18 / 32%)` (убрать чистый чёрный).
- Карточки уровня `.event-item`, `.process-preview li`, `.zone-explain` теней не имеют вовсе (разделение линиями) - так и оставить.

### 2.7 Easing и motion-токены

```css
--ease-out: cubic-bezier(0.22, 1, 0.36, 1);
--ease-inout: cubic-bezier(0.65, 0, 0.35, 1);
--dur-1: 120ms;   /* active-отклик */
--dur-2: 180ms;   /* hover: transform, border-color, background-color, color */
--dur-3: 260ms;   /* прогресс, раскрытие details */
```

- Заменить все `150ms ease` / `160ms ease` на `var(--dur-2) var(--ease-out)`; `transition: width` в `.progress-track` оставить `500ms var(--ease-out)`.
- Анимируются только `transform`, `opacity`, `border-color`, `background-color`, `color`, `box-shadow`.
- Единственные keyframes страницы: `breathe` (1.8s, живой bridge/обработка), `pulse` (1.4s, активное событие), `rise` (330ms var(--ease-out), появление события журнала). Новых не добавлять.
- Блок `@media (prefers-reduced-motion: reduce)` не изменять.

---

## 3. По-компонентная прескрипция (было -> стало)

### 3.1 Шапка со статусом bridge: `.topbar`, `.brand`, `.connection`, `.topbar-link`

Было: sticky, `min-height: 72px`, фон `rgb(242 239 231 / 94%)` + blur 18px, нижняя граница `rgb(23 32 29 / 14%)`; `.brand-mark` 38px квадрат туши, r10; `.connection` чип panel/line r10, точка 8px: жёлтая офлайн / зелёная live c `breathe`; `.topbar-link` 12px с подчёркиванием.

Стало:
- высота `64px` (`min-height` 72→64): навигация одной строкой, экономит вертикаль первого экрана;
- фон `rgb(242 239 231 / 96%)`, blur остаётся; граница снизу `1px solid var(--line)`;
- `.connection`: r-pill, `min-height: 34px`, шрифт caption 12px/700, `font-variant-numeric: tabular-nums`;
- семантика точки: live = `--green` + `breathe` (не менять); **офлайн = `--muted`** вместо жёлтого (жёлтый зарезервирован маршрутом yellow, «bridge ждёт» не должен конфликтовать с «нужно решение руководителя»); ring вокруг точки приглушить до `rgb(85 93 88 / 14%)`;
- `.topbar-link`: 13px, вес 650, подчёркивание `border-bottom 1px solid var(--line-strong)`, hover: цвет `--accent` без сдвига.

### 3.2 Hero: `.story-hero`, `.eyebrow`, `.hero-intro h1`, `.hero-lead`, `.agent-difference`, `.hero-status`, `.system-map`, `.source-dock`

Было: h1 clamp(38..68)/610/-0.048em/1.01; eyebrow охристый 13px; lead `#46504c`; `.agent-difference` бежевый бокс r16 `#f5f1e9`; `.hero-status` тёмная карта r18, метка `#d1ab84` 11px; `.system-map`: 7 одинаковых карточек 138px r16 + стрелки `→`; `.source-dock` тёмная лента из 5 равных кнопок.

Стало:
- h1: `--text-display` (см. 2.3), макс 64px: длинный русский заголовок держит 2 строки;
- eyebrow: единственный на страницу сверху hero, 12px/750, `letter-spacing: 0.02em`, цвет `--accent`; второй eyebrow (`.demo-heading`) остаётся, больше нигде новые не вводить;
- `.agent-difference`: фон `var(--accent-soft)` вместо серо-бежевого `#f5f1e9`, левая кромка `3px solid var(--accent)`, r-m; подпись `span` 12px/750 `--accent-strong`; текст body 14px `--ink-soft`;
- `.hero-status`: r-l, фон `--ink`, сверху внутренняя подсветка `inset 0 1px 0 rgb(255 255 255 / 6%)`; метка `--on-ink-label` 11px/750; основной strong Geologica `--text-h3`; абзац `--on-ink-body`;
- `.system-map` (деунификация триады-семёрки, CSS-only через `nth-child`):
  - базовая карточка: r-m, паддинг `--s4`, фон panel;
  - `article:nth-child(4n+1)` (шаги 01 и 07): верхняя кромка `3px solid var(--accent)` и номер Geologica 12px `--accent` - вход и результат дня читаются как якоря;
  - средние шаги: номер `--muted`, фон `rgb(255 253 248 / 82%)`;
  - стрелки `i`: 12px, `--line-strong`, выравнивание по центру первой строки карточек;
  - min-height 138→132px, `strong` 15px→Geologica 15px/600;
- `.source-dock`: r-l; кнопки `min-height: 72px`, hover `rgb(255 255 255 / 8%)`; подпись `span` Geologica 10px `--on-ink-label` с `letter-spacing: 0.04em`.

### 3.3 Гид маршрутов: `.zone-guide`, `.zone-explainer`, `.zone-explain`, `.zone-light`, `.zone-name`

Было: три равные карточки r15, `border-top: 4px` цветом зоны, единый фон `rgb(255 253 248 / 72%)`; `.zone-light` 12px с дефолтом `--blue`; `.zone-name` всегда `--muted`.

Стало (триада легитимна: это состояния одного процесса, но обязаны различаться мгновенно, с дальней части зала):
- фон карточки = `color-mix(in srgb, var(--{zone}-soft) 55%, white)` (для зелёной/жёлтой/красной соответственно), рамка `1px solid var(--line)`, top `4px var(--{zone})`, r-m;
- `.zone-name`: цвет `var(--{zone}-text)`, 12px/750 - имя маршрута становится цветным и AA-читаемым;
- `strong` (название сценария) 15px Geologica/600; `p` caption 12px `--ink-soft`; `small` caption `--muted`;
- `.zone-light`: убрать синий дефолт (фон = `var(--{zone})` всегда; синий здесь ложный сигнал), обод `2px solid var(--panel)` + `box-shadow: 0 0 0 1px var(--line-strong)`;
- summary `.zone-guide`: подпись 14px/700, `small` 12px, плюс-кнопка 24px круг туши - оставить.

### 3.4 Форма свободной заявки (главный элемент взаимодействия зрителей): `.compose-column`, `.preset-controls`, `.mail-card`, `.mail-toolbar`, `.window-dots`, `.mail-field`, `.mail-body`, `.photo-upload-*`, `.send-button`, `.zone-hint`

Было: колонка на `--paper-deep`; `.mail-card` белая r16, тень `0 14px 36px rgb(48 44 34/7%)`; toolbar 50px с разноцветными mac-точками; поля: label-колонка 84px, подпись 12px/600 `--muted`, input прозрачный 13px; textarea 190px/14px; `.photo-upload-button` r10, подпись `small` **8px**; `.send-button` тушь r10, hover прыгает в `--accent`; `.zone-hint` мягкие зоны-подложки.

Стало:
- `.mail-card`: r-m, `box-shadow: var(--shadow-rest)`, рамка `var(--line)`;
- `.window-dots`: все три точки `#dcd7cc` 9px (цветные traffic-lights вне палитры - убрать; окно остаётся узнаваемым за счёт геометрии); toolbar `strong` 13px/650, правый span caption `--muted`;
- `.mail-field > span` (метки): 12px/650 `--ink-soft`; placeholder: `color: #8B8677` (отличим от метки, 4.6:1 на белом); input `font-size: 14px` (было 13px: зритель читает ввод ведущего);
- `.mail-body textarea`: 14.5px/1.62, `min-height: 210px`; focus-visible: outline `2px solid var(--accent)` offset 2px - уже есть, сохранить;
- `.photo-upload-button`: r-s, пунктир `1px dashed var(--line-strong)`, hover: сплошная рамка `--accent` + фон `rgb(240 223 202 / 35%)`; `span` 13px/700; `small` **8px → 11px** (критично: сейчас нечитаемо);
- `.mail-attachment img`: r-s, рамка `--line`;
- `.send-button` (CTA №1 страницы): фон `--accent` (постоянный), текст `#fff` (6.9:1), r-s, `min-height: 48px`, вес 700, `letter-spacing: 0.01em`; hover: `--accent-strong` + `translateY(-1px)` + `box-shadow: 0 6px 16px rgb(110 58 16 / 25%)`; active: `translateY(0) scale(0.99)` за `--dur-1`; disabled: opacity 0.55 без трансформаций. Убрать смену «тушь →охра» на hover (прыжок оттенка выглядит как баг в записи экрана);
- `.public-journal-note`: фон `var(--yellow-soft)`, `strong` `--yellow-text`, `span` caption `--muted`;
- `.zone-hint`: фоны -soft остаются; `strong` 13px, цвет `var(--{zone}-text)`;
- `.preset-controls select/button`: r-s, `min-height: 44px`, рамка `var(--line-strong)`; кнопка «Другой пример»: hover фон panel, счётчик `small` 11px `tabular-nums`.

### 3.5 Карточка заказа и история: `.run-panel`, `.run-head`, `.order-card-preview`, `.zone-badge`, `.progress-track`, `.event-list`, `.event-item`, `.previous-result-history`, `.error-state`

Было: progress 4px охра, width-transition 500ms; события r13, `min-height: 66px`, gap 7, вход `rise 330ms ease`; активное событие - dashed рамка на `--blue-soft`; `.zone-badge` pill с точкой зоны; время уже `tabular-nums`.

Стало:
- `.run-head h2`: `--text-h3`; `.order-card-preview` 12.5px/1.5 `--ink-soft`, clamp 2 строки остаётся;
- `.zone-badge`: r-pill, `min-height: 36px`, точка 9px цветом зоны; режим `is-processing`: точка `--blue` + `breathe` (сохранить, это «в работе»);
- `.progress-track`: 4px, фон `#DED9CF`, заполнение `--accent`, скругления inherit;
- `.event-list`: gap 7→`--s3` (10px); `.event-item`: r-s, padding 14x16px, `min-height: 68px`;
  - вход `rise 330ms var(--ease-out)` - оставить (одно движение на событие, без stagger);
  - `is-active`: dashed-рамка сохраняется + `background: var(--blue-soft)`; добавить `box-shadow: inset 3px 0 0 var(--blue)` - активный шаг виден периферийным зрением;
  - `is-history`: фон `--paper`; `is-error`: рамка `#DDA49E`, фон `--red-soft`, заголовок `--red-text`;
  - `h3` Golos 13.5px/650; `p` caption 12.5px `--muted`→`--ink-soft` для деталей шага; `time` Geologica 12px `tabular-nums`;
- `.previous-result-history`: пунктир, фон paper - оставить; `strong` 13.5px;
- `.error-state`: r-m, кнопка повторa - стиль вторичной (тушь, r-s).

### 3.6 Решение руководителя: `.result-panel`, `.decision-poster`, `.facts-grid`, `.option-grid`, `.option-card`, `.selected-option-letter`, `.approve-button`, `.approval-stamp`

Было: `.decision-poster` r17 на `-soft` зоны; option-grid 3 равные колонки, карточки r14 `min-height: 302px`, номер варианта всегда `--red`; выбор = рамка туши + ring 2px; `.approve-button` тушь r10; штамп одобрения `--green-soft` с бледной рамкой `#95c9ad`.

Стало:
- `.decision-poster`: r-m; заголовок Geologica `--text-h3`/560; метка `span` 12px/750 цветом `var(--{zone}-text)`; `small` `rgb(23 32 29 / 66%)`;
- `.option-grid`: gap 9→`--s3`; карточки r-m, padding 15→20px, `min-height: 296px`;
  - `.option-number`: `--red` → `--muted` (номер варианта не обязан быть красным; красный в этой зоне уже несёт смысл маршрута);
  - `.option-label`: 9px→11px/750, `--accent-strong`, `letter-spacing: 0.04em`;
  - `p` 12.5px/1.5 `--ink-soft`; `.option-business-result` 13px/600 `--ink`;
  - `is-selected`: рамка `--ink` + `box-shadow: 0 0 0 2px var(--ink)` - усилить фоном `rgb(240 223 202 / 40%)`, чтобы выбор читался в записи;
  - `focus-within`: ring `3px rgb(138 74 22 / 28%)`;
- `.approve-button`: главный мануальный экшен руководителя - стиль CTA (как `.send-button`: `--accent`/белый/r-s/hover `--accent-strong`); disabled opacity 0.4;
- `.approval-stamp`: r-m, рамка `rgb(35 112 76 / 32%)`, галочка-круг `--green`, `small` 12px/700 `--green-text`, `strong` 13px.

### 3.7 Письмо агента и переписка: `.reply-card`, `.reply-head`, `.reply-subject`, `.reply-steps`, `.conversation-flow`, `.customer-reply-form`, `.original-mail`, `.agent-log`

Было: `.reply-card` белая r16; head с разделителем `#e9e5dd`; переписка и лог - плотные текстовые блоки 12-13px.

Стало:
- `.reply-card`: r-m, `padding: 24px`; head: `border-bottom: 1px solid var(--line)`, subject 15px Geologica/600; статус-строка caption `--muted`;
- тело письма: `--text-body` 14px/1.62 `#333835` - оставить размер, поднять цвет до `--ink-soft` для проектора;
- `.conversation-flow` / `.customer-reply-editor`: реплики разделяются `1px solid var(--line)`, автор строки - Geologica 11px/750 caps-лейбл (не более одного стиля лейбла на всю переписку); поле ответа клиента: r-s, фон panel, focus ring акцент;
- `.agent-log`: моно-ритм времени Geologica `tabular-nums` 12px, текст caption 12.5px; без новых иконок и точек-маркеров.

### 3.8 Админ-пульты: `.presenter-console`, `.console-head`, `.inventory-form`, `.partner-console`, `.market-form`, `.admin-login`, `.ledger-block`, `.ledger-table`, `.modal-backdrop`, `.modal-sheet`, `.catalog-table`

Было: консоли на `--ink`; метки 9-12px `#b8c0bc`; inputs `white/8%` r9; модал: backdrop `rgb(20 27 25 / 72%)` blur 8, sheet r24 с чёрной тенью `rgb(0 0 0/28%)`; таблица каталога: header `--paper-deep`, строки с `border-bottom`.

Стало:
- тёмные поверхности: фон `--ink`, r-l; заголовки `console-head span/partner-console-heading span` 12px/800 `--on-ink-label`; сильный текст `#fff`;
- все label на тёмном: **минимум 11px** (было 9px в `.market-form label > span` и `.console-signout`), цвет `--on-ink-body`;
- inputs/select на тёмном: `background: rgb(255 255 255 / 10%)`, border `rgb(255 255 255 / 22%)`, r-s, `min-height: 44px`; focus: `border-color: var(--accent-soft)` + `outline: 2px solid var(--accent-soft)` offset 2px (акцент `#8A4A16` на туше не виден);
- primary-кнопки пультов: фон `var(--accent)`, hover `--accent-strong` (единая физика CTA);
- `.ledger-table` / `.catalog-table`: header 12px/700 caps-лейбл `--muted` на `--paper-deep`, строки `border-bottom: 1px solid var(--line)` (нижнее правило между строками - одно, без двойных рамок), числовые ячейки Geologica `tabular-nums`; zebra-полос нет и не добавлять; hover строки `rgb(23 32 29 / 3%)`;
- `.modal-backdrop`: фон `rgb(23 32 29 / 70%)`, blur 8 оставить; `.modal-sheet`: r-l, тень `0 28px 70px rgb(28 25 18 / 32%)`; крестик 44px круг - оставить;
- пустые состояния (`inventory-loading`, `catalog-empty`): caption 13px `--muted` на `--paper-deep`, без спиннеров.

### 3.9 Журнал дня и статистика: `.control-story`, `.control-grid`, `.day-result`, `.day-heading`, `.metric-grid`, `.zone-totals`

Было: `.control-story` тёмная секция r24, три статьи `white/4%` r15 с метками `#d0a57b`; `.metric-grid` 5 равных ячеек r20, цифры clamp(42..72)/540/-0.05em; `.zone-totals` легенда с точками 8px.

Стало:
- `.control-story`: r-l; статьи r-m, `border: 1px solid rgb(255 255 255 / 14%)`, фон `rgb(255 255 255 / 5%)`; метка `--on-ink-label`; `strong` Geologica `--text-h3`; текст `--on-ink-body`;
- деунификация тройки: `article:nth-child(1)` получает верхнюю кромку `3px solid var(--accent-soft)` (первый сценарий = путь вебинара), остальные без кромки; этого достаточно, чтобы ряд перестал читаться «тремя одинаковыми карточками»;
- `.day-heading h2`: `--text-h2`; подводка caption 13px `--muted`;
- `.metric-grid`: r-l; ячейки padding 24px; цифры `--text-strong-num` (tracking -0.03em вместо -0.05em: кириллические подписи рядом, плотный трекинг цифр на проекторе сливается); подписи `span` 12px/700 `--muted`, `small` caption;
- `.zone-totals`: точки 8px цветами маршрутов (семантика - оставить), текст caption 12px `--muted`.

### 3.10 Футер: `footer`

Было: 3-колоночный грид, 12px `--muted`, `strong` Geologica с `letter-spacing: 0.03em`.
Стало: без структурных изменений; `strong` 13px Geologica/650; ссылки hover `--accent`; высота `min-height: 88px`; верхняя граница `var(--line)`.

### 3.11 Глобальные поверхности

- Линейка фона `body` (горизонтальные линии каждые 56px, 2% туши) - фирменная «миллиметровка цеха», сохранить как есть; плотность/непрозрачность не повышать (на проекторе начинает рябить).
- `main` ширина `min(1580px, 100%)` и боковые поля clamp - оставить.
- Focus-visible глобально: `outline: 2px solid var(--accent)` - оставить; проверить, что на тёмных панелях используется `--accent-soft` (см. 3.8).

---

## 4. Anti-slop чеклист стенда «Колер»

Проходить после каждой правки слоя. Любой пункт = fail.

1. **Ни одного** фиолетового градиента, дефолтного синего (`#0d6efd`, `blue-500`) и glassmorphism-блеска на светлом фоне.
2. Один акцент на странице (`--accent #8A4A16` + производные) одинаково применён во всех секциях; акцент не спорит с маршрутными цветами (маршруты - заливки/точки/рамки, акцент - действия и якоря).
3. Семантика демо неприкосновенна: зелёный/жёлтый/красный встречаются только как состояния заявки; синий только как «в работе»; ни один UI-элемент не использует их как декор.
4. Цветной текст маршрутов набран `-text`-вариантами и даёт ≥ 4.5:1 на своей `-soft` подложке (проверить `.zone-name`, `.decision-poster > span`, `.zone-hint strong`, `.error-state`, `.public-journal-note`).
5. Нет «трёх одинаковых карточек» без различия: каждая видимая триада (зоны, опции руководителя, контрольные сценарии, system-map) имеет хотя бы один явный дифференциатор (тон подложки, цветная кромка, цветная метка).
6. Радиус-язык только 10 / 14 / 22 / pill-статусы; ни одного значения вне системы.
7. Тени только `rgb(42 38 28 …)` или `rgb(28 25 18 …)`; нигде нет чистого чёрного `rgb(0 0 0 …)`; максимум две тени на элемент.
8. Кнопки: одна главная CTA в зоне видимости; hover меняет тон на ступень внутри того же цвета (никаких переходов тушь↔охра); есть active-отклик ≤ 2px/scale 0.99; текст CTA не переносится на вторую строку при 1280px.
9. Motion: существуют только `breathe`, `pulse`, `rise` и hover/active/focus-переходы; ничего не мигает, не вращается, не каруселится; ничто не появляется с задержкой каскадом; reduced-motion не сломан.
10. Демо-значимый текст ≥ 12px (метки форм, события журнала, строки таблиц, легенды); отсутствуют кегли 8-10px (проверить `.photo-upload-button small`, `.market-form label`, `.console-signout`); числа - `tabular-nums`.
11. Заголовки: предложение-регистр (тест проверяет), трекинг не глубже `-0.03em`, без uppercase-transform, без декоративных `<br>`-разбиений.
12. Никаких эмодзи, декоративных точек-статусов вне семантики, version-подписей, «Scroll»-подсказок и глазков-надзаголовков сверх двух существующих eyebrow.
13. Тест `rendered-html.test.mjs` зелёный: ни один проверяемый текстовый маркер не изменён; сохранены `className="system-map-mobile"`, `<details className="zone-guide" open>`, `role="progressbar"`, `role="log"`; в `layout.tsx` осталась пара `Geologica, Golos_Text`; в исходнике не появились слова-маркеры запрета (`codex-preview`, `SkeletonPreview` и список doesNotMatch).
14. Контраст проектора: вторичный текст не светлее `--muted #555D58` на бумаге и не темнее `--on-ink-body` на туши; проверка глазами на 720p/расстоянии 3м обязательна.
15. Откат одним действием: все правки лежат в `globals.css` (+ максимум className-строки, если указано); удаление диффа возвращает прежний вид без изменения поведения.

---

## 5. Ограничения и запреты (не нарушают ни при каких условиях)

1. **Только className/CSS.** Не менять: JSX-структуру и порядок детей, условную разметку, `useState/useEffect/useRef` и обработчики, `key`, `role=`, `aria-*`, `id`, data-атрибуты, тексты любых узлов (включая плейсхолдеры и alt).
2. **Семантика маршрутов**: оттенки `--green/#23704c`, `--yellow/#bd791b`, `--red/#b94034` и их `-soft` не меняются; разрешено лишь добавление тёмных `-text` вариантов для текста.
3. **WCAG AA для текста на проекторе**: обычный текст ≥ 4.5:1, крупный (≥ 18.66px bold / 24px) ≥ 3:1. Особый контроль: жёлтые и muted-строки, текст на `--ink`, placeholder'ы.
4. **Тест rendered-html**: см. чеклист п.13; прогон после каждого слоя: `node --test tests/rendered-html.test.mjs`.
5. Шрифты: импорт в `layout.tsx` не изменяется (тест фиксирует `Geologica, Golos_Text`); самохостинг через next/font считается локальным подключением, внешних ссылок не добавлять.
6. Порядок хирургии (слой за слоем, тест после каждого): токены → типографика → цвет/контраст → отступы → компоненты → атмосфера (ничего сверх п.3.11) → motion-полировка. Один слой = один коммит.
7. Что запрещено добавлять даже «для красоты»: новые keyframes, scroll-анимации, IntersectionObserver-скрипты, зернистость/grain, backdrop-blur на прокручиваемых контейнерах, новые иконки и эмодзи, тёмную тему (стенд демонстрируется в одном режиме).

## 6. Приёмка

- `node --test tests/rendered-html.test.mjs` - зелёный.
- Ручной проход по сценарию КР-001 (2000/300 кг): письмо → события журнала → красная зона → варианты руководителя → резерв → отправка; все состояния визуально различимы, ничего не прыгает.
- Скриншот-сверка «до/после» на 1440px и 1280px; проекторная проверка 720p с 3 метров.
