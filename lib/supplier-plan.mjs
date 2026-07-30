function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function rankedSupplierOffers(category, market, requiredKg) {
  return (Array.isArray(market) ? market : [])
    .filter((item) => String(item?.category ?? "").trim() === category)
    .map((item) => ({
      supplierName: String(item?.competitor ?? "").trim(),
      pricePerKg: positiveNumber(item?.pricePerKg),
      deliveryDays: positiveNumber(item?.deliveryDays),
      stockKg: positiveNumber(item?.stockKg),
      stockCheckedAt: String(
        item?.stockCheckedAt ?? item?.checkedAt ?? "",
      ).trim(),
    }))
    .filter(
      (item) =>
        item.supplierName &&
        item.pricePerKg &&
        item.deliveryDays &&
        item.stockKg &&
        item.stockCheckedAt,
    )
    .map((item) => ({
      ...item,
      canCover: item.stockKg >= requiredKg,
    }))
    .sort((left, right) => {
      if (left.canCover !== right.canCover) return left.canCover ? -1 : 1;
      if (left.canCover) {
        return (
          left.deliveryDays - right.deliveryDays ||
          left.pricePerKg - right.pricePerKg ||
          left.supplierName.localeCompare(right.supplierName, "ru")
        );
      }
      return (
        right.stockKg - left.stockKg ||
        left.deliveryDays - right.deliveryDays ||
        left.pricePerKg - right.pricePerKg ||
        left.supplierName.localeCompare(right.supplierName, "ru")
      );
    });
}

function supplierComparison(offers, selectedName) {
  return offers.map((offer) => ({
    ...offer,
    selected: offer.supplierName === selectedName,
  }));
}

export function buildSupplierPlan(product, market, requestedKg) {
  const requested = positiveNumber(requestedKg);
  const ownStockKg = positiveNumber(product?.stockKg);
  const ownPricePerKg = positiveNumber(product?.pricePerKg);
  const category = String(product?.category ?? "").trim();
  const ownKg = Math.min(requested, ownStockKg);
  const supplierKg = Math.max(0, requested - ownKg);
  if (!category || !requested || !ownPricePerKg || !supplierKg) return null;

  const offers = rankedSupplierOffers(category, market, supplierKg);
  const offer = offers.find((item) => item.canCover);
  if (!offer) return null;

  const supplierPricePerKg = positiveNumber(offer.pricePerKg);
  const ourSubtotal = ownKg * ownPricePerKg;
  const supplierSubtotal = supplierKg * supplierPricePerKg;

  return {
    category,
    supplierName: offer.supplierName,
    ourKg: ownKg,
    supplierKg,
    ourPricePerKg: ownPricePerKg,
    supplierPricePerKg,
    ourSubtotal,
    supplierSubtotal,
    total: ourSubtotal + supplierSubtotal,
    deliveryDays: positiveNumber(offer.deliveryDays),
    supplierStockKg: positiveNumber(offer.stockKg),
    stockCheckedAt: offer.stockCheckedAt,
    offersChecked: offers.length,
    eligibleOffers: offers.filter((item) => item.canCover).length,
    selectionRule:
      "Сначала весь недостающий объём. Среди таких предложений — меньший срок, затем меньшая цена.",
    comparedOffers: supplierComparison(offers, offer.supplierName),
  };
}

export function confirmSupplierPlan(plan, market) {
  if (!plan || !Array.isArray(market)) return null;
  const offers = rankedSupplierOffers(
    plan.category,
    market,
    plan.supplierKg,
  );
  const offer = offers.find((item) => item.canCover);
  if (!offer) return null;

  if (
    offer.supplierName !== plan.supplierName ||
    offer.stockKg !== plan.supplierStockKg ||
    offer.pricePerKg !== plan.supplierPricePerKg ||
    offer.deliveryDays !== plan.deliveryDays ||
    offer.stockCheckedAt !== plan.stockCheckedAt
  ) {
    return null;
  }

  return {
    ...plan,
    supplierStockKg: offer.stockKg,
    offersChecked: offers.length,
    eligibleOffers: offers.filter((item) => item.canCover).length,
    comparedOffers: supplierComparison(offers, offer.supplierName),
  };
}

export function supplierPlanChangeDetail(plan, market) {
  if (!plan || !Array.isArray(market)) {
    return "Свежие данные поставщика пока недоступны.";
  }

  const offers = rankedSupplierOffers(
    plan.category,
    market,
    plan.supplierKg,
  );
  const current = offers.find(
    (item) => item.supplierName === plan.supplierName,
  );
  if (!current) {
    return `Предложение «${plan.supplierName}» снято. Агент выберет другой способ собрать заказ.`;
  }

  const changes = [];
  if (current.stockKg !== plan.supplierStockKg) {
    changes.push(
      `доступный объём ${plan.supplierStockKg} → ${current.stockKg} кг`,
    );
  }
  if (current.pricePerKg !== plan.supplierPricePerKg) {
    changes.push(
      `цена ${plan.supplierPricePerKg} → ${current.pricePerKg} ₽/кг`,
    );
  }
  if (current.deliveryDays !== plan.deliveryDays) {
    changes.push(
      `срок ${plan.deliveryDays} → ${current.deliveryDays} дн.`,
    );
  }
  if (current.stockCheckedAt !== plan.stockCheckedAt) {
    changes.push(`свежая проверка от ${current.stockCheckedAt}`);
  }

  const best = offers.find((item) => item.canCover);
  if (best && best.supplierName !== plan.supplierName) {
    changes.push(`теперь лучше подходит «${best.supplierName}»`);
  }

  return changes.length
    ? `«${plan.supplierName}»: ${changes.join("; ")}.`
    : `Предложение «${plan.supplierName}» подтверждено без изменений.`;
}
