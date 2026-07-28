export function quantityFromText(value) {
  const source = String(value ?? "");
  const kilograms = source.match(/(\d[\d\s]*)\s*(?:кг|килограмм)/i);
  if (kilograms) return Number(kilograms[1].replace(/\s/g, ""));
  const tons = source.match(
    /(\d+(?:[.,]\d+)?)\s*(?:тонн(?:а|ы)?|т\.?(?![\p{L}]))/iu,
  );
  return tons
    ? Math.round(Number(tons[1].replace(",", ".")) * 1000)
    : 0;
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
    [/металл\s*про/i, "КР-002"],
    [/эпокси\s*пол/i, "КР-003"],
    [/аква\s*стена/i, "КР-004"],
    [/дерево\s*защита/i, "КР-005"],
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

export function hasSpecialTerms(value) {
  return /(скидк|отсроч|постоплат|тендер|штраф|не выше\s*\d|завтра|24\s*час|по образцу|специальн.*цвет|сертификат.*до)/i.test(
    String(value ?? ""),
  );
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
