function offerIdPart(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export const SUPPLIER_MARKET_MAX_STOCK_KG = 1_000_000;

export class SupplierMarketValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SupplierMarketValidationError";
  }
}

export function supplierMarketWithIds(market) {
  const usedIds = new Set();

  return (Array.isArray(market) ? market : []).map((offer, index) => {
    const existingId = String(offer?.id ?? "").trim();
    const baseId =
      existingId ||
      [
        offerIdPart(offer?.category),
        offerIdPart(offer?.competitor),
      ]
        .filter(Boolean)
        .join("--") ||
      `supplier-offer-${index + 1}`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    return { ...offer, id };
  });
}

export function applySupplierMarketStockChange(
  market,
  id,
  stockKg,
  stockCheckedAt,
) {
  const normalizedId = String(id ?? "").trim();
  if (!normalizedId) {
    throw new SupplierMarketValidationError(
      "Выберите предложение поставщика.",
    );
  }
  if (
    !Number.isSafeInteger(stockKg) ||
    stockKg < 0 ||
    stockKg > SUPPLIER_MARKET_MAX_STOCK_KG
  ) {
    throw new SupplierMarketValidationError(
      `Остаток поставщика должен быть целым числом от 0 до ${SUPPLIER_MARKET_MAX_STOCK_KG}.`,
    );
  }

  const currentMarket = supplierMarketWithIds(market);
  const selected = currentMarket.find((offer) => offer.id === normalizedId);
  if (!selected) return null;

  const checkedAt = String(stockCheckedAt ?? "").trim();
  const nextMarket =
    selected.stockKg === stockKg
      ? currentMarket
      : currentMarket.map((offer) =>
          offer.id === normalizedId
            ? {
                ...offer,
                stockKg,
                ...(checkedAt ? { stockCheckedAt: checkedAt } : {}),
              }
            : offer,
        );

  return {
    market: nextMarket,
    changed: {
      id: normalizedId,
      from: Number(selected.stockKg),
      to: stockKg,
    },
  };
}

export function supplierMarketStateValue(market) {
  return JSON.stringify({
    version: 1,
    offers: supplierMarketWithIds(market).map((offer) => ({
      id: offer.id,
      stockKg: Number(offer.stockKg),
      stockCheckedAt: String(offer.stockCheckedAt ?? "").trim(),
    })),
  });
}

export function supplierMarketFromState(defaultMarket, value) {
  const defaults = supplierMarketWithIds(defaultMarket);
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return defaults;
  }
  const offers = Array.isArray(parsed?.offers) ? parsed.offers : [];
  const overrides = new Map(
    offers
      .filter(
        (offer) =>
          typeof offer?.id === "string" &&
          Number.isSafeInteger(offer?.stockKg) &&
          offer.stockKg >= 0 &&
          offer.stockKg <= SUPPLIER_MARKET_MAX_STOCK_KG,
      )
      .map((offer) => [offer.id.trim(), offer]),
  );

  return defaults.map((offer) => {
    const override = overrides.get(offer.id);
    if (!override) return offer;
    const stockCheckedAt = String(override.stockCheckedAt ?? "").trim();
    return {
      ...offer,
      stockKg: override.stockKg,
      ...(stockCheckedAt ? { stockCheckedAt } : {}),
    };
  });
}
