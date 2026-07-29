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

/**
 * Returns true when the paint used by a saved result has changed on the live
 * inventory. A missing saved or live row is treated as changed so approval and
 * sending stop safely until the card is recalculated.
 */
export function productInventoryChanged(snapshot, result, liveItems) {
  const sku = result?.product?.sku;
  if (!sku) return false;

  const saved = snapshotItems(snapshot).find((item) => item?.sku === sku);
  const live = Array.isArray(liveItems)
    ? liveItems.find((item) => item?.sku === sku)
    : null;
  if (!saved || !live) return true;

  const savedRevision = revisionOf(saved);
  const liveRevision = revisionOf(live);
  if (savedRevision !== null && liveRevision !== null) {
    return savedRevision !== liveRevision;
  }

  return Number(saved.stockKg) !== Number(live.stockKg);
}
