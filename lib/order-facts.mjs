export function quantityFromText(value) {
  const source = String(value ?? "");
  const kilogramsPattern = /(\d[\d\s]*)\s*(?:кг|килограмм)/gi;
  for (const kilograms of source.matchAll(kilogramsPattern)) {
    const prefix = source.slice(Math.max(0, kilograms.index - 50), kilograms.index);
    const describesPackaging =
      /(?:в\s+таре\s+по|тар[ае]\s+по|фасовк\p{L}*\s*(?:по)?|упаковк\p{L}*\s*(?:по)?|\d+\s*(?:в[её]дер\p{L}*|бан\p{L}*|канистр\p{L}*|мешк\p{L}*|шт\.?)\s+по|(?:цен\p{L}*|стоимост\p{L}*)[^.!?\n]{0,20}\sза)\s*$/iu.test(
        prefix,
      );
    if (!describesPackaging) {
      return Number(kilograms[1].replace(/\s/g, ""));
    }
  }
  const tons = source.match(
    /(\d+(?:[.,]\d+)?)\s*(?:тонн(?:а|ы)?|т(?=\s|$|[,;)])|т\.(?=\s|$|[,;)]))/iu,
  );
  return tons
    ? Math.round(Number(tons[1].replace(",", ".")) * 1000)
    : 0;
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
  if (hasWall === hasFloor) return 0;

  const area = explicitAreaFromText(source);
  const hasMaterial = hasWall
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

export function explicitSkuFromText(value) {
  return String(value ?? "").match(/кр-\d{1,4}/i)?.[0]?.toUpperCase() ?? "";
}

export function matchProduct(value, products) {
  const source = String(value ?? "").toLowerCase();
  const sku = explicitSkuFromText(source);
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

export function hasUsableEnvironment(value) {
  const source = String(value ?? "");
  const stated = /(внутр|наруж|улиц|помещ|офис)/i.test(source);
  const ambiguous =
    /(неизвестно|не решили|уточняем)[^.]{0,100}(внутр|наруж|улиц)|(внутр|наруж|улиц)[^.]{0,60}\sили\s[^.]{0,60}(внутр|наруж|улиц)/i.test(
      source,
    );
  return stated && !ambiguous;
}

export function asksCompatibility(value) {
  return /(подходит ли|совместим|контакт с|стойк\w*\s+(?:к|против)\s+(?:масл|хим)|требует подтверждения технолог)/i.test(
    String(value ?? ""),
  );
}

export function hasColor(value) {
  return /(?:^|[^\p{L}])(?:ral\s*\d{4}|бел\p{L}*|сер(?:ый|ая|ое|ые|ого|ой|ую|ым|ом)|ч[её]рн\p{L}*|зел[её]н\p{L}*|коричнев\p{L}*)(?:[^\p{L}]|$)/iu.test(
    String(value ?? ""),
  );
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
    /(скидк|тендер|штраф|не выше\s*\d|завтра|24\s*час|по образцу|специальн.*цвет|сертификат.*до)/iu.test(
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
