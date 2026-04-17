/**
 * Reset all fixed prices for a given market in Shopify.
 *
 * After a price-setting run goes wrong (e.g. wrong FX rate), use this to
 * clear the price list so variants fall back to the shop's default
 * (base currency × Shopify's auto FX, or whatever catalog rule applies).
 *
 * Usage:
 *   node reset-market-prices.js PH
 *   node reset-market-prices.js US
 *   node reset-market-prices.js AU
 *   node reset-market-prices.js ID
 */
const shopify = require('./lib/shopify');
const { log } = require('./lib/utils');

async function main() {
  const market = (process.argv[2] || '').toUpperCase();
  if (!['US', 'AU', 'ID', 'PH'].includes(market)) {
    console.error('Usage: node reset-market-prices.js <US|AU|ID|PH>');
    process.exit(1);
  }

  log('RESET', `=== Resetting ${market} price list ===`);

  const pl = await shopify.getMarketPriceLists();
  const keyMap = { US: 'usPriceList', AU: 'auPriceList', ID: 'idPriceList', PH: 'phPriceList' };
  const priceList = pl[keyMap[market]];

  if (!priceList) {
    log('RESET', `ERROR: ${market} price list not found in Shopify`);
    process.exit(1);
  }

  log('RESET', `${market} price list: ${priceList.name} (${priceList.id})`);

  log('RESET', 'Fetching current fixed prices...');
  const fixed = await shopify.getFixedPrices(priceList.id);
  const variantIds = Object.keys(fixed);
  log('RESET', `Found ${variantIds.length} fixed prices to delete`);

  if (variantIds.length === 0) {
    log('RESET', 'Nothing to delete — price list already clean.');
    return;
  }

  const deleted = await shopify.deleteFixedPrices(priceList.id, variantIds);
  log('RESET', `=== Done: deleted ${deleted.length} fixed prices from ${market} ===`);
  log('RESET', 'Variants will now use the shop default pricing for this market until you re-run price-match.');
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
