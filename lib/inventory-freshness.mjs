function snapshotItems(snapshot) {
  if (!snapshot) return [];
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot.items)) return snapshot.items;
  if (Array.isArray(snapshot.products)) return snapshot.products;
  return [];
}

function revisionOf(item) {
  const value = Number(item?.revision ?? item?.stockRevision);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function resultCopy(result) {
  return (Array.isArray(result?.options) ? result.options : [])
    .flatMap((option) => [
      option?.id,
      option?.title,
      option?.rationale,
      option?.tradeoff,
      option?.reply,
    ])
    .join(" ")
    .toLocaleLowerCase("ru-RU");
}

export function resultInventorySkus(snapshot, result, catalogItems = []) {
  const selectedSku = result?.product?.sku;
  if (!selectedSku) return [];

  const knownItems = [
    ...snapshotItems(snapshot),
    ...(Array.isArray(catalogItems) ? catalogItems : []),
  ];
  const selected =
    knownItems.find(
      (item) => item?.sku === selectedSku && Array.isArray(item.analogues),
    ) ?? knownItems.find((item) => item?.sku === selectedSku);
  const skus = new Set([selectedSku]);
  const copy = resultCopy(result);

  for (const item of knownItems) {
    if (
      item?.sku &&
      (copy.includes(String(item.sku).toLocaleLowerCase("ru-RU")) ||
        (item.name &&
          copy.includes(String(item.name).toLocaleLowerCase("ru-RU"))))
    ) {
      skus.add(item.sku);
    }
  }

  if (
    !result.calculation &&
    Number(result.product.requestedKg) > Number(result.product.stockKg) &&
    Array.isArray(selected?.analogues)
  ) {
    selected.analogues.forEach((sku) => skus.add(sku));
  }

  return [...skus];
}

export function changedProductInventory(
  snapshot,
  result,
  liveItems,
  catalogItems = liveItems,
) {
  const savedItems = snapshotItems(snapshot);
  const live = Array.isArray(liveItems) ? liveItems : [];

  for (const sku of resultInventorySkus(snapshot, result, catalogItems)) {
    const saved = savedItems.find((item) => item?.sku === sku) ?? null;
    const current = live.find((item) => item?.sku === sku) ?? null;
    if (!saved || !current) return { sku, saved, live: current };

    const savedRevision = revisionOf(saved);
    const liveRevision = revisionOf(current);
    const changed =
      savedRevision !== null && liveRevision !== null
        ? savedRevision !== liveRevision
        : Number(saved.stockKg) !== Number(current.stockKg);
    if (changed) return { sku, saved, live: current };
  }

  return null;
}

/**
 * Returns true when inventory used by a saved result or its manager options
 * has changed. A missing row is treated as changed so approval and sending
 * stop safely until the card is recalculated.
 */
export function productInventoryChanged(
  snapshot,
  result,
  liveItems,
  catalogItems = liveItems,
) {
  return Boolean(
    changedProductInventory(snapshot, result, liveItems, catalogItems),
  );
}
