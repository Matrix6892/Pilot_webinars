export function conversationSegments(value) {
  const source = String(value ?? "");
  const markers = [...source.matchAll(/Ответ клиента\s+\d+\s*:\s*/giu)];
  if (!markers.length) return [source];

  const segments = [source.slice(0, markers[0].index)];
  for (let index = 0; index < markers.length; index += 1) {
    const start = markers[index].index + markers[index][0].length;
    const end = markers[index + 1]?.index ?? source.length;
    segments.push(source.slice(start, end));
  }
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function quantityFromSegment(source) {
  const kilogramsPattern =
    /(?<![\d.,])(\d{1,3}(?:[\s\u00a0,.]\d{3})+|\d+)\s*(?:кг|килограмм|kg\b)/gi;
  for (const kilograms of source.matchAll(kilogramsPattern)) {
    const prefix = source.slice(Math.max(0, kilograms.index - 50), kilograms.index);
    const describesPackaging =
      /(?:в\s+таре\s+по|тар[ае]\s+по|фасовк\p{L}*\s*(?:по)?|упаковк\p{L}*\s*(?:по)?|\d+\s*(?:в[её]дер\p{L}*|бан\p{L}*|канистр\p{L}*|мешк\p{L}*|шт\.?)\s+по|(?:цен\p{L}*|стоимост\p{L}*)[^.!?\n]{0,20}\sза)\s*$/iu.test(
        prefix,
    );
    if (!describesPackaging) {
      return Number(kilograms[1].replace(/[\s\u00a0,.]/g, ""));
    }
  }
  const tons = source.match(
    /(\d+(?:[.,]\d+)?)\s*(?:тонн(?:а|ы)?|т(?=\s|$|[,;)])|т\.(?=\s|$|[,;)]))/iu,
  );
  if (tons) return Math.round(Number(tons[1].replace(",", ".")) * 1000);
  const wordTons = source.match(
    /(?:^|[^\p{L}])(одна|одну|один|пара|пару|две|два|три|четыре|пять|шесть|семь|восемь|девять|десять)\s+тонн(?:а|ы)?(?:[^\p{L}]|$)/iu,
  );
  return wordTons
    ? {
        одна: 1,
        одну: 1,
        один: 1,
        пара: 2,
        пару: 2,
        две: 2,
        два: 2,
        три: 3,
        четыре: 4,
        пять: 5,
        шесть: 6,
        семь: 7,
        восемь: 8,
        девять: 9,
        десять: 10,
      }[wordTons[1].toLocaleLowerCase("ru-RU")] * 1000
    : 0;
}

function explicitTotalQuantityFromSegment(source) {
  const match = String(source ?? "").match(
    /(?:всего|общ\p{L}*\s+объ[её]м|итого)[^.!?\n]{0,40}?(\d[\d\s]*)\s*(?:кг|килограмм|kg\b)/iu,
  );
  return match ? Number(match[1].replace(/\s/g, "")) : 0;
}

function partialDeliveryQuantityFromSegment(source) {
  const text = String(source ?? "");
  const patterns = [
    /(\d[\d\s]*)\s*(?:кг|килограмм|kg\b)\s*(?:сейчас|сразу)[^.!?\n]{0,70}?(?:осталь\p{L}*|оставш\p{L}*|остат\p{L}*)[^.!?\n]{0,40}?(?:позже|потом|следующ\p{L}*\s+парти\p{L}*)/iu,
    /(?:для\s+старт\p{L}*|перва\p{L}*\s+парти\p{L}*|сначала|первы\p{L}*)[^.!?\n]{0,40}?(\d[\d\s]*)\s*(?:кг|килограмм|kg\b)/iu,
    /(\d[\d\s]*)\s*(?:кг|килограмм|kg\b)[^.!?\n]{0,40}?(?:для\s+старт\p{L}*|перво\p{L}*\s+парти\p{L}*|сначала)/iu,
    /(\d[\d\s]*)\s*(?:кг|килограмм|kg\b)[^.!?\n]{0,30}?(?:сейчас|сразу)[^.!?\n]{0,70}?(?:осталь\p{L}*|оставш\p{L}*|остат\p{L}*)[^.!?\n]{0,40}?(?:позже|потом|следующ\p{L}*\s+парти\p{L}*)/iu,
    /(?:сейчас|сразу)[^.!?\n]{0,30}?(\d[\d\s]*)\s*(?:кг|килограмм|kg\b)[^.!?\n]{0,70}?(?:осталь\p{L}*|оставш\p{L}*|остат\p{L}*)[^.!?\n]{0,40}?(?:позже|потом|следующ\p{L}*\s+парти\p{L}*)/iu,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1].replace(/\s/g, ""));
  }
  return 0;
}

export function quantityFromText(value) {
  const segments = conversationSegments(value);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const explicitTotal = explicitTotalQuantityFromSegment(segments[index]);
    if (explicitTotal) return explicitTotal;

    const quantity = quantityFromSegment(segments[index]);
    const describesPartialDelivery =
      partialDeliveryQuantityFromSegment(segments[index]) > 0;
    if (quantity && !describesPartialDelivery) return quantity;
  }
  return 0;
}

export function firstDeliveryQuantityFromText(value) {
  const segments = conversationSegments(value);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const quantity = partialDeliveryQuantityFromSegment(segments[index]);
    if (quantity) return quantity;
  }
  return 0;
}

export function deliveryPlanFromText(value) {
  const totalKg = quantityFromText(value);
  const requestedFirstDeliveryKg = firstDeliveryQuantityFromText(value);
  const firstDeliveryKg =
    totalKg > 0 &&
    requestedFirstDeliveryKg > 0 &&
    requestedFirstDeliveryKg < totalKg
      ? requestedFirstDeliveryKg
      : 0;
  return {
    totalKg,
    firstDeliveryKg,
    remainingKg: firstDeliveryKg ? totalKg - firstDeliveryKg : 0,
  };
}

export function calculatedSurfaceQuantityFromText(
  value,
  product,
  reservePercent = 0,
) {
  const source = String(value ?? "");
  const hasWall =
    /(?:^|[^\p{L}])стен\p{L}*(?:[^\p{L}]|$)/iu.test(source);
  const hasFloor =
    /(?:^|[^\p{L}])пол(?:а|у|ом|ы|ов|е)?(?:[^\p{L}]|$)/iu.test(source);
  const hasFence = isFenceRequest(source);
  if ([hasWall, hasFloor, hasFence].filter(Boolean).length !== 1) return 0;

  const fence = hasFence ? fenceMeasurementsFromText(source) : null;
  const area = fence?.paintAreaM2 ?? explicitAreaFromText(source);
  const hasMaterial = hasFence
    ? fenceMaterialFromText(source) !== "неясно"
    : hasWall
      ? /гипсокартон|(?:^|[^\p{L}])гкл(?:[^\p{L}]|$)|штукатур|бетон/iu.test(
          source,
        )
      : /бетон|стяжк|цемент/iu.test(source);
  const coverage = decimalFromText(product?.coverageKgPerM2PerCoat);
  const coats = decimalFromText(product?.recommendedCoats);
  const packageKg = decimalFromText(product?.packKg);
  const reserve = Number(reservePercent);
  if (!area || !hasMaterial || !coverage || !coats || !packageKg) return 0;

  const estimatedKg =
    area *
    coverage *
    coats *
    (1 + (Number.isFinite(reserve) && reserve > 0 ? reserve : 0) / 100);
  return Math.ceil(estimatedKg / packageKg) * packageKg;
}

function explicitSkuFromSegment(value) {
  return String(value ?? "").match(/кр-\d{1,4}/i)?.[0]?.toUpperCase() ?? "";
}

export function explicitSkuFromText(value) {
  const segments = conversationSegments(value);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const sku = explicitSkuFromSegment(segments[index]);
    if (sku) return sku;
  }
  return "";
}

function matchProductInSegment(value, products) {
  const source = String(value ?? "").toLowerCase();
  const sku = explicitSkuFromSegment(source);
  if (sku) return products.find((product) => product.sku === sku) ?? null;

  const namedProducts = [
    [/барьер\s*3\s*в\s*1/i, "КР-001"],
    [/краск\p{L}*\s+для\s+металл\p{L}*\s+и\s+ржавчин\p{L}*/iu, "КР-001"],
    [/металл\s*про/i, "КР-002"],
    [
      /(?:износостойк\p{L}*[^.!?\n]{0,50}(?:техник\p{L}*|корпус\p{L}*)|(?:техник\p{L}*|корпус\p{L}*)[^.!?\n]{0,50}износостойк\p{L}*|краск\p{L}*\s+для\s+техник\p{L}*)/iu,
      "КР-002",
    ],
    [/эпокси\s*пол/i, "КР-003"],
    [/краск\p{L}*\s+для\s+бетонн\p{L}*\s+пол\p{L}*/iu, "КР-003"],
    [/аква\s*стена/i, "КР-004"],
    [/моющ\p{L}*\s+краск\p{L}*\s+для\s+стен\p{L}*/iu, "КР-004"],
    [/дерево\s*защита/i, "КР-005"],
    [/краск\p{L}*\s+для\s+дерев\p{L}*\s+на\s+улиц\p{L}*/iu, "КР-005"],
  ];
  for (const [pattern, productSku] of namedProducts) {
    if (pattern.test(source)) {
      return products.find((product) => product.sku === productSku) ?? null;
    }
  }

  if (/(дерев|древес|террас|доск(?:а|и|у|ой|е|ами|ах)?)/i.test(source)) {
    return products.find((product) => product.sku === "КР-005") ?? null;
  }
  if (
    /(эпоксид|наливн|напольн|(?:^|[^\p{L}])пол(?:а|у|ом|ы|ов|е)?(?:[^\p{L}]|$))/iu.test(
      source,
    )
  ) {
    return products.find((product) => product.sku === "КР-003") ?? null;
  }
  if (/(стен|гкл|штукатур|интерьер|акрилов)/i.test(source)) {
    return products.find((product) => product.sku === "КР-004") ?? null;
  }
  if (/полиуретан/i.test(source)) {
    return products.find((product) => product.sku === "КР-002") ?? null;
  }
  if (/(металл|конструкц|грунт-эмал|ржав)/i.test(source)) {
    return products.find((product) => product.sku === "КР-001") ?? null;
  }
  return null;
}

export function matchProduct(value, products) {
  const segments = conversationSegments(value);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const product = matchProductInSegment(segments[index], products);
    if (product) return product;
    if (explicitSkuFromSegment(segments[index])) return null;
  }
  return null;
}

function environmentState(source) {
  const stated = /(внутр|наруж|улиц|помещ|офис)/i.test(source);
  if (!stated) return null;
  const ambiguous =
    /(неизвестно|не решили|уточняем)[^.]{0,100}(внутр|наруж|улиц)|(внутр|наруж|улиц)[^.]{0,60}\sили\s[^.]{0,60}(внутр|наруж|улиц)/i.test(
      source,
    );
  return !ambiguous;
}

export function hasUsableEnvironment(value) {
  const segments = conversationSegments(value);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const state = environmentState(segments[index]);
    if (state !== null) return state;
  }
  return false;
}

function asksNonOilCompatibilityInSegment(value) {
  return /(?:санитарн\p{L}*[^.!?\n]{0,50}(?:обработ|уборк)|дезинф(?:екц|иц)|дезсредств|(?:мо|убир|уборк|мыть|мойк|обработ)\p{L}*[^.!?\n]{0,45}(?:кажд\p{L}*\s+день|ежедневн)|(?:кажд\p{L}*\s+день|ежедневн)[^.!?\n]{0,45}(?:мо|убир|уборк|мыть|мойк|обработ)\p{L}*|(?:соответств|требован)\p{L}*[^.!?\n]{0,60}(?:ГОСТ|GMP|ISO|СанПиН))/iu.test(
    String(value ?? ""),
  );
}

function asksCompatibilityInSegment(value) {
  return (
    asksNonOilCompatibilityInSegment(value) ||
    /(?:подходит\s+ли|совместим|контакт\s+с|стойк\p{L}*\s+(?:к|против)\s+(?:масл|хим)|масл\p{L}*[^.!?\n]{0,45}попада\p{L}*|попада\p{L}*[^.!?\n]{0,45}масл\p{L}*|требует\s+подтверждения\s+технолог)/iu.test(
      String(value ?? ""),
    )
  );
}

function rulesOutOilContact(value) {
  const source = String(value ?? "");
  return /(?:без|нет|не\s+(?:будет|планируется|предполагается|нужен|нужна|нужно|требуется))[^.!?\n]{0,50}(?:контакт\p{L}*\s+с\s+)?масл\p{L}*|(?:контакт\p{L}*\s+с\s+)?масл\p{L}*[^.!?\n]{0,50}(?:не\s+(?:будет|планируется|предполагается|нужен|нужна|нужно|требуется)|исключ[её]н)/iu.test(
    source,
  );
}

export function asksCompatibility(value) {
  const segments = conversationSegments(value);
  if (segments.length === 1) {
    return asksCompatibilityInSegment(segments[0]);
  }
  const hasNonOilConcern = segments.some(asksNonOilCompatibilityInSegment);

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (rulesOutOilContact(segments[index]) && !hasNonOilConcern) return false;
    if (asksCompatibilityInSegment(segments[index])) return true;
  }
  return false;
}

export function floorUseFactsFromText(value) {
  const source = String(value ?? "");
  const storedItems = source.match(
    /(?:храним|хранятся?|будем\s+хранить|размещаем)\s+([^.!?\n,;]{2,80})/iu,
  )?.[1]?.trim();
  const statedUse = source.match(
    /(?:используем\s+помещение|помещение\s+(?:используем|будет|станет)|в\s+помещении\s+будет|это\s+будет)\s*(?:как|под|для|—|-|:)?\s*([^.!?\n,;]{2,80})/iu,
  )?.[1]?.trim();
  const namedUse = source.match(
    /(?:^|[^\p{L}])(склад\p{L}*|цех\p{L}*|мастерск\p{L}*|лаборатори\p{L}*|торгов\p{L}*\s+зал\p{L}*|магазин\p{L}*|паркинг\p{L}*|гараж\p{L}*|офис\p{L}*)(?:[^\p{L}]|$)/iu,
  )?.[1]?.trim();
  const purpose =
    /медицинск\p{L}*\s+склад|лекарств|медикамент|фармацевт|медицинск\p{L}*\s+(?:товар|препарат)/iu.test(
      source,
    )
      ? "медицинский склад"
      : storedItems || statedUse || namedUse || "";
  const cleaning =
    /нейтральн\p{L}*\s+(?:моющ\p{L}*\s+)?средств/iu.test(source)
      ? "нейтральное моющее средство"
      : /дезинфицирующ\p{L}*\s+средств|дезсредств/iu.test(source)
        ? "дезинфицирующее средство"
        : /моющ\p{L}*\s+средств/iu.test(source)
          ? "моющее средство"
          : /влажн\p{L}*\s+уборк/iu.test(source)
            ? "влажная уборка"
          : /(?:мо\p{L}*|убир\p{L}*|обрабатыва\p{L}*)[^.!?\n]{0,45}вод\p{L}*/iu.test(
                source,
              )
            ? "вода"
            : /сух\p{L}*\s+уборк/iu.test(source)
              ? "сухая уборка"
              : "";
  const noEquipment =
    /(?:без|не\s+будет)[^.!?\n]{0,35}(?:погрузчик|тележк|рохл)|(?:погрузчик|тележк|рохл)[^.!?\n]{0,35}не\s+будет/iu.test(
      source,
    );
  const hasEquipment =
    /погрузчик|тележк|рохл|(?:езд|движ)\p{L}*[^.!?\n]{0,30}техник|техник\p{L}*[^.!?\n]{0,30}(?:езд|движ)\p{L}*/iu.test(
      source,
    );

  return {
    material: /бетон|стяжк|цемент/iu.test(source) ? "бетон" : "",
    purpose,
    cleaning,
    load: noEquipment
      ? "без погрузчиков и тележек"
      : hasEquipment
        ? "погрузчики или тележки"
        : "",
  };
}

function colorLabelFromSegment(value) {
  const source = String(value ?? "");
  const namedMatches = [
    ...source.matchAll(
      /т[её]мно[-\s]?сер\p{L}*|светло[-\s]?сер\p{L}*|коричнев\p{L}*|бел\p{L}*|сер(?:ый|ая|ое|ые|ого|ой|ую|ым|ом)|ч[её]рн\p{L}*|зел[её]н\p{L}*/giu,
    ),
  ];
  const named = namedMatches.at(-1)?.[0] ?? "";
  const colorName = /^т[её]мно/iu.test(named)
    ? "тёмно-серый"
    : /^светло/iu.test(named)
      ? "светло-серый"
      : /^коричнев/iu.test(named)
        ? "коричневый"
        : /^бел/iu.test(named)
          ? "белый"
          : /^сер/iu.test(named)
            ? "серый"
            : /^ч[её]рн/iu.test(named)
              ? "чёрный"
              : /^зел[её]н/iu.test(named)
                ? "зелёный"
                : "";
  const ralMatches = [...source.matchAll(/\bRAL\s*\d{4}\b/giu)];
  const ral = ralMatches.at(-1)?.[0].replace(/\s+/g, " ").toUpperCase();
  return [colorName, ral].filter(Boolean).join(", ");
}

export function colorLabelFromText(value) {
  const segments = conversationSegments(value);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const color = colorLabelFromSegment(segments[index]);
    if (color) return color;
  }
  return "";
}

export function hasColor(value) {
  return Boolean(colorLabelFromText(value));
}

export function asksPaymentAfterDelivery(value) {
  const source = String(value ?? "");
  return /(?:отсроч\p{L}*|постоплат\p{L}*|(?:оплат\p{L}*|расч[её]т\p{L}*)[^.!?\n]{0,55}(?:через\s+\d+\s*(?:день|дня|дней|суток)|после\s+(?:поставк\p{L}*|отгрузк\p{L}*|получен\p{L}*|при[её]мк\p{L}*|доставк\p{L}*)|по\s+факту|в\s+течени[ея]\s+\d+\s*(?:день|дня|дней|суток))|срок\p{L}*\s+оплат\p{L}*[^.!?\n]{0,24}\d+\s*(?:день|дня|дней|суток)|без\s+предоплат\p{L}*|сначала\s+(?:поставк\p{L}*|отгрузк\p{L}*)[^.!?\n]{0,45}(?:потом|затем)\s+оплат\p{L}*)/iu.test(
    source,
  );
}

export function hasSpecialTerms(value) {
  const source = String(value ?? "");
  const namedCondition =
    /(скидк|тендер|конкурс\p{L}*\s+поставщик\p{L}*|штраф|гарант\p{L}*|warrant(?:y|ies|ied)|не выше\s*\d|завтра|24\s*час|по образцу|специальн.*цвет|сертификат.*до)/iu.test(
      source,
    );

  return namedCondition || asksPaymentAfterDelivery(source);
}

export function quotedUnitPrices(value) {
  const prices = [];
  const pattern =
    /(\d[\d\s]{1,7})\s*(?:₽|руб(?:\.|лей)?)\s*(?:\/\s*кг|за\s+кг)/gi;
  for (const match of String(value ?? "").matchAll(pattern)) {
    const amount = Number(match[1].replace(/\s/g, ""));
    if (Number.isFinite(amount)) prices.push(amount);
  }
  return prices;
}

function decimalFromText(value) {
  const parsed = Number(String(value ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function innFromText(value) {
  const source = String(value ?? "");
  const match = source.match(
    /(?:^|[^\p{L}\d])инн\s*(?:№|#|:|-)?\s*((?:\d[\s-]?){9,11}\d)(?!\d)/iu,
  );
  const digits = match?.[1]?.replace(/\D/g, "") ?? "";
  return digits.length === 10 || digits.length === 12 ? digits : "";
}

export const extractInn = innFromText;

export function isFenceRequest(value) {
  return /(?:^|[^\p{L}])забор\p{L}*(?:[^\p{L}]|$)/iu.test(
    String(value ?? ""),
  );
}

export function fenceMaterialFromText(value) {
  const source = String(value ?? "");
  const metal =
    /(?:металл\p{L}*|желез\p{L}*|профнастил\p{L}*|профлист\p{L}*|сетка[-\s]?рабиц\p{L}*|кован\p{L}*|металлическ\p{L}*\s+штакетник\p{L}*)/iu.test(
      source,
    );
  if (metal) return "металл";

  const wood =
    /(?:дерев\p{L}*|досчат\p{L}*|из\s+досок|штакетник\p{L}*)/iu.test(source);
  return wood ? "дерево" : "неясно";
}

function measurementAfterLabel(source, label) {
  const match = source.match(
    new RegExp(
      `${label}[^\\d]{0,24}(\\d+(?:[.,]\\d+)?)\\s*(?:м(?:етр(?:а|ов)?)?)(?![²2])`,
      "iu",
    ),
  );
  return decimalFromText(match?.[1]);
}

function measurementBeforeLabel(source, label) {
  const match = source.match(
    new RegExp(
      `(\\d+(?:[.,]\\d+)?)\\s*(?:м(?:етр(?:а|ов)?)?)\\s*(?:по\\s+)?${label}`,
      "iu",
    ),
  );
  return decimalFromText(match?.[1]);
}

function explicitAreaFromText(source) {
  const labelled = source.match(
    /площад\p{L}*(?:\s+(?:забор\p{L}*|покраск\p{L}*|поверхност\p{L}*))?[^.\d]{0,24}(\d+(?:[.,]\d+)?)\s*(?:м\s*[²2]|кв(?:адратн\p{L}*)?\.?\s*м(?:етр\p{L}*)?)/iu,
  );
  const unlabelled = source.match(
    /(\d+(?:[.,]\d+)?)\s*(?:м\s*[²2]|кв(?:адратн\p{L}*)?\.?\s*м(?:етр\p{L}*)?|квадратн\p{L}*\s+метр\p{L}*)/iu,
  );
  return decimalFromText(labelled?.[1] ?? unlabelled?.[1]);
}

export function fenceMeasurementsFromText(value) {
  const source = String(value ?? "");
  let lengthM =
    measurementBeforeLabel(source, "длин\\p{L}*") ??
    measurementAfterLabel(source, "длин\\p{L}*");
  let heightM =
    measurementBeforeLabel(source, "высот\\p{L}*") ??
    measurementAfterLabel(source, "высот\\p{L}*");

  if (!lengthM) {
    const naturalFenceLength = source.match(
      /забор\p{L}*[^.!?\n\d]{0,36}(\d+(?:[.,]\d+)?)\s*м(?:етр(?:а|ов)?)?(?=\s*[,;]\s*высот)/iu,
    );
    lengthM = decimalFromText(naturalFenceLength?.[1]);
  }

  if (!lengthM || !heightM) {
    const dimensions = source.match(
      /(\d+(?:[.,]\d+)?)\s*(?:м(?:етр\p{L}*)?\s*)?[×xх]\s*(\d+(?:[.,]\d+)?)\s*м(?:етр\p{L}*)?/iu,
    );
    lengthM ??= decimalFromText(dimensions?.[1]);
    heightM ??= decimalFromText(dimensions?.[2]);
  }

  let sides = null;
  if (
    /(?:с\s+(?:двух|2|обеих)\s+сторон|обе\s+стороны|две\s+стороны|снаружи\s+и\s+изнутри|изнутри\s+и\s+снаружи|наружн\p{L}*\s+и\s+внутренн\p{L}*\s+сторон)/iu.test(
      source,
    )
  ) {
    sides = 2;
  } else if (
    /(?:с\s+(?:одной|1)\s+сторон|одн\p{L}*\s+сторон|только\s+(?:снаружи|изнутри|со\s+стороны))/iu.test(
      source,
    )
  ) {
    sides = 1;
  }

  const areaM2 = explicitAreaFromText(source);
  const areaPerSideM2 =
    areaM2 ?? (lengthM && heightM ? lengthM * heightM : null);
  const paintAreaM2 =
    areaPerSideM2 && sides ? areaPerSideM2 * sides : null;

  return {
    lengthM,
    heightM,
    areaM2,
    sides,
    areaPerSideM2,
    paintAreaM2,
  };
}

export function orderFactsFromText(value) {
  const source = String(value ?? "");
  return {
    inn: innFromText(source),
    fence: isFenceRequest(source)
      ? {
          requested: true,
          material: fenceMaterialFromText(source),
          ...fenceMeasurementsFromText(source),
          mentionsPhoto: /(?:фото|фотограф|снимок|прикреп\p{L}*)/iu.test(source),
        }
      : null,
  };
}
