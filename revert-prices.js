/**
 * Revert all price changes from the last run back to their old prices.
 * Uses docs/status.json to find what was changed.
 *
 * Usage: SHOPIFY_ACCESS_TOKEN=xxx node revert-prices.js
 */
const shopify = require('./lib/shopify');
const { log } = require('./lib/utils');

async function main() {
  const status = require('./docs/status.json');
  const applied = status.priceChanges.filter(c => c.applied);

  if (applied.length === 0) {
    log('REVERT', 'No applied changes to revert.');
    return;
  }

  log('REVERT', `Reverting ${applied.length} price changes...`);

  // Get the US price list
  const { usPriceList } = await shopify.getMarketPriceLists();
  if (!usPriceList) {
    log('REVERT', 'ERROR: US price list not found');
    process.exit(1);
  }

  log('REVERT', `US price list: ${usPriceList.name} (${usPriceList.id})`);

  // Build revert inputs — set price back to oldPrice
  const usReverts = applied
    .filter(c => c.market === 'US')
    .map(c => ({
      variantId: `gid://shopify/ProductVariant/${c.sku}`, // sku field has the barcode, need variant ID
      price: c.oldPrice,
      currency: 'USD'
    }));

  // We need the actual variant GIDs — the status.json doesn't store them directly.
  // Fetch products to map SKUs to variant GIDs.
  log('REVERT', 'Fetching products to map SKUs to variant IDs...');
  const products = await shopify.getAllProducts();

  const skuToGid = new Map();
  for (const p of products) {
    for (const v of p.variants) {
      if (v.sku) skuToGid.set(v.sku, `gid://shopify/ProductVariant/${v.id}`);
      if (v.barcode) skuToGid.set(v.barcode, `gid://shopify/ProductVariant/${v.id}`);
    }
  }

  const revertInputs = [];
  for (const c of applied) {
    if (c.market !== 'US') continue;
    const gid = skuToGid.get(c.sku);
    if (gid) {
      revertInputs.push({ variantId: gid, price: c.oldPrice, currency: 'USD' });
    } else {
      log('REVERT', `WARNING: Could not find variant for SKU ${c.sku} (${c.product})`);
    }
  }

  log('REVERT', `Reverting ${revertInputs.length} US prices...`);
  await shopify.setFixedPrices(usPriceList.id, revertInputs);

  log('REVERT', `Done! ${revertInputs.length} prices reverted to original values.`);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
