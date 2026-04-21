/**
 * Inlinex Price Match — Main Orchestrator
 *
 * Scrapes competitor prices, matches to Shopify products,
 * calculates market-specific pricing, and updates Shopify.
 *
 * Usage:
 *   node price-match.js                    # Full run
 *   node price-match.js --dry-run          # Calculate but don't update Shopify
 *   node price-match.js --brands=Powerslide,USD  # Only specific brands
 */
const { log, loadJSON, saveJSON, sleep } = require('./lib/utils');
const shopify = require('./lib/shopify');
const iwScraper = require('./lib/inline-warehouse');
const xtScraper = require('./lib/xtremeinn');
const isScraper = require('./lib/indoskates');
const matcher = require('./lib/matcher');
const report = require('./lib/report');
const fs = require('fs');
const path = require('path');

// Pricing constants
const IW_DISCOUNT = 0.95;         // 5% cheaper than IW
const XT_DISCOUNT = 0.95;         // 5% cheaper than xtremeinn + shipping
const XT_SHIPPING_USD = 40;       // Default xtremeinn shipping to US
const XT_SHIPPING_AUD = 80;       // Default xtremeinn shipping to AU
const XT_SHIPPING_IDR = 900000;   // Default xtremeinn shipping to Indonesia
const XT_SHIPPING_PHP = 4000;     // Default xtremeinn shipping to Philippines
const XT_SHIPPING_JPY = 9500;     // Default xtremeinn shipping to Japan
const XT_SHIPPING_CAD = 100;      // Default xtremeinn shipping to Canada
const US_DEFAULT_MARKUP = 1.18;   // 18% markup for US market
const AU_DEFAULT_MARKUP = 1.15;   // 15% markup for AU market
const ID_DEFAULT_MARKUP = 1.15;   // 15% markup for ID market
const PH_DEFAULT_MARKUP = 1.20;   // 20% markup for PH market
const JP_DEFAULT_MARKUP = 1.20;   // 20% markup for JP market
const CA_DEFAULT_MARKUP = 1.18;   // 18% markup for CA market

// Load per-product shipping overrides
const shippingOverridesFile = path.join(__dirname, 'shipping-overrides.json');
const shippingOverrides = loadJSON(shippingOverridesFile) || { overrides: {} };

async function main() {
  const startTime = Date.now();
  const dryRun = process.argv.includes('--dry-run');
  const brandsArg = process.argv.find(a => a.startsWith('--brands='));
  const brands = brandsArg ? brandsArg.split('=')[1].split(',') : null;
  const marketsArg = process.argv.find(a => a.startsWith('--markets='));
  const markets = marketsArg ? marketsArg.split('=')[1].split(',') : ['US'];
  const enableUS = markets.includes('US');
  const enableAU = markets.includes('AU');
  const enableID = markets.includes('ID');
  const enablePH = markets.includes('PH');
  const enableJP = markets.includes('JP');
  const enableCA = markets.includes('CA');
  const sourceArg = process.argv.find(a => a.startsWith('--source='));
  const source = sourceArg ? sourceArg.split('=')[1] : 'both';
  const enableIW = source === 'iw' || source === 'both';
  const enableXT = source === 'xt' || source === 'both';
  const enableIS = source === 'is';

  log('MAIN', `=== Price Match Run Started ===`);
  log('MAIN', `Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  log('MAIN', `Markets: ${markets.join(', ')} | Source: ${source}`);
  if (brands) log('MAIN', `Brands: ${brands.join(', ')}`);

  // Ensure reports directory exists
  const reportsDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  // ==========================================
  // 1. Fetch Shopify products
  // ==========================================
  log('MAIN', 'Step 1: Fetching Shopify products...');
  const products = await shopify.getAllProducts();
  log('MAIN', `Fetched ${products.length} active products`);

  // Filter by brand if specified
  const filteredProducts = brands
    ? products.filter(p => brands.some(b => (p.vendor || '').toLowerCase().includes(b.toLowerCase())))
    : products;
  log('MAIN', `Products to match: ${filteredProducts.length}`);

  // Save product titles + handles for the dashboard's remap auto-suggest.
  // Uses all (not filtered) so remaps can target any product regardless of brand filter.
  try {
    const docsDir = path.join(__dirname, 'docs');
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
    const titles = products.map(p => ({
      title: p.title,
      handle: p.handle || '',
      vendor: p.vendor || '',
      variants: (p.variants || []).map(v => ({ sku: v.sku || '', title: v.title || '' })),
    }));
    fs.writeFileSync(path.join(docsDir, 'shopify-titles.json'), JSON.stringify({ updatedAt: new Date().toISOString(), products: titles }));
  } catch (e) { log('MAIN', `Warning: failed to save shopify-titles.json: ${e.message}`); }


  // ==========================================
  // 2. Get Shopify market price lists
  // ==========================================
  log('MAIN', 'Step 2: Finding market price lists...');
  const { usPriceList, auPriceList, idPriceList, phPriceList, jpPriceList, caPriceList } = await shopify.getMarketPriceLists();

  if (!usPriceList) log('MAIN', 'WARNING: US price list not found');
  if (!auPriceList) log('MAIN', 'WARNING: AU price list not found');
  if (!idPriceList) log('MAIN', 'WARNING: ID price list not found');
  if (enablePH && !phPriceList) log('MAIN', 'WARNING: PH price list not found');
  if (enableJP && !jpPriceList) log('MAIN', 'WARNING: JP price list not found');
  if (enableCA && !caPriceList) log('MAIN', 'WARNING: CA price list not found');

  // Get current fixed prices (from price list — explicit FIXED origin)
  let usFixedPrices = {};
  let auFixedPrices = {};
  let idFixedPrices = {};
  let phFixedPrices = {};
  let jpFixedPrices = {};
  let caFixedPrices = {};
  if (usPriceList) {
    log('MAIN', 'Fetching current US fixed prices...');
    usFixedPrices = await shopify.getFixedPrices(usPriceList.id);
    log('MAIN', `US fixed prices: ${Object.keys(usFixedPrices).length}`);
  }
  if (auPriceList) {
    log('MAIN', 'Fetching current AU fixed prices...');
    auFixedPrices = await shopify.getFixedPrices(auPriceList.id);
    log('MAIN', `AU fixed prices: ${Object.keys(auFixedPrices).length}`);
  }
  if (idPriceList) {
    log('MAIN', 'Fetching current ID fixed prices...');
    idFixedPrices = await shopify.getFixedPrices(idPriceList.id);
    log('MAIN', `ID fixed prices: ${Object.keys(idFixedPrices).length}`);
  }
  if (phPriceList) {
    log('MAIN', 'Fetching current PH fixed prices...');
    phFixedPrices = await shopify.getFixedPrices(phPriceList.id);
    log('MAIN', `PH fixed prices: ${Object.keys(phFixedPrices).length}`);
  }
  if (jpPriceList) {
    log('MAIN', 'Fetching current JP fixed prices...');
    jpFixedPrices = await shopify.getFixedPrices(jpPriceList.id);
    log('MAIN', `JP fixed prices: ${Object.keys(jpFixedPrices).length}`);
  }
  if (caPriceList) {
    log('MAIN', 'Fetching current CA fixed prices...');
    caFixedPrices = await shopify.getFixedPrices(caPriceList.id);
    log('MAIN', `CA fixed prices: ${Object.keys(caFixedPrices).length}`);
  }

  // Get contextual prices — captures BOTH fixed prices and percentage markups
  // Run all enabled markets in parallel to save time
  const productIds = filteredProducts.map(p => p.id);
  if (productIds.length > 0) {
    const ctxTasks = [];
    if (enableUS) ctxTasks.push(shopify.getContextualPrices(productIds, 'US').then(p => ['US', p]));
    if (enableAU) ctxTasks.push(shopify.getContextualPrices(productIds, 'AU').then(p => ['AU', p]));
    if (enableID) ctxTasks.push(shopify.getContextualPrices(productIds, 'ID').then(p => ['ID', p]));
    if (enablePH) ctxTasks.push(shopify.getContextualPrices(productIds, 'PH').then(p => ['PH', p]));
    if (enableJP) ctxTasks.push(shopify.getContextualPrices(productIds, 'JP').then(p => ['JP', p]));
    if (enableCA) ctxTasks.push(shopify.getContextualPrices(productIds, 'CA').then(p => ['CA', p]));
    if (ctxTasks.length > 0) {
      log('MAIN', `Fetching contextual prices for ${ctxTasks.length} market(s) in parallel...`);
      const ctxResults = await Promise.all(ctxTasks);
      for (const [market, prices] of ctxResults) {
        const target = market === 'US' ? usFixedPrices
          : market === 'AU' ? auFixedPrices
          : market === 'ID' ? idFixedPrices
          : market === 'PH' ? phFixedPrices
          : market === 'JP' ? jpFixedPrices
          : caFixedPrices;
        for (const [gid, price] of Object.entries(prices)) target[gid] = price;
        log('MAIN', `${market} effective prices: ${Object.keys(target).length}`);
      }
    }
  }

  // ==========================================
  // 3. Scrape competitor prices
  // ==========================================
  let iwProducts = [];
  if (enableIW) {
    log('MAIN', 'Step 3: Scraping Inline Warehouse...');
    iwProducts = await iwScraper.scrapeAll(brands);
  } else {
    log('MAIN', 'Step 3: Inline Warehouse SKIPPED (source=' + source + ')');
  }

  let xtUsProducts = [], xtAuProducts = [], xtIdProducts = [], xtPhProducts = [], xtJpProducts = [], xtCaProducts = [];
  if (enableXT) {
    log('MAIN', 'Step 3b: Scraping xtremeinn...');
    ({ usProducts: xtUsProducts, auProducts: xtAuProducts, idProducts: xtIdProducts, phProducts: xtPhProducts, jpProducts: xtJpProducts, caProducts: xtCaProducts } = await xtScraper.scrapeAll(brands, markets, filteredProducts));
    xtIdProducts = xtIdProducts || [];
    xtPhProducts = xtPhProducts || [];
    xtJpProducts = xtJpProducts || [];
    xtCaProducts = xtCaProducts || [];
  } else {
    log('MAIN', 'Step 3b: xtremeinn SKIPPED (source=' + source + ')');
  }

  let isProducts = [];
  if (enableIS) {
    log('MAIN', 'Step 3c: Scraping IndoSkates...');
    isProducts = await isScraper.scrapeAll(brands);
  } else if (enableID && source === 'both') {
    // When running ID market with "both" source, also scrape IndoSkates
    log('MAIN', 'Step 3c: Scraping IndoSkates (auto for ID market)...');
    isProducts = await isScraper.scrapeAll(brands);
  }

  // ==========================================
  // 4. Match products
  // ==========================================
  log('MAIN', 'Step 4: Matching products...');
  const { matches, unmatched } = matcher.matchAll(filteredProducts, iwProducts, xtUsProducts.concat(xtAuProducts).concat(xtIdProducts).concat(xtPhProducts).concat(xtJpProducts).concat(xtCaProducts), isProducts);

  // ==========================================
  // 5. Calculate new prices
  // ==========================================
  log('MAIN', 'Step 6: Calculating prices...');
  const priceChanges = [];
  const usPriceUpdates = [];
  const auPriceUpdates = [];
  const idPriceUpdates = [];
  const phPriceUpdates = [];
  const jpPriceUpdates = [];
  const caPriceUpdates = [];

  for (const match of matches) {
    const { shopifyProduct, shopifyVariant, variantGid, currentPrice, iwMatch, iwMethod, xtMatch, xtMethod } = match;

    // --- US Market Pricing ---
    if (usPriceList && enableUS) {
      let usNewPrice = null;
      let usCompetitor = null;
      let usCompPrice = null;
      let usCompSource = null;
      let usMatchMethod = null;

      let usShipFee = 0;

      // Check IW first (no shipping)
      if (iwMatch) {
        usNewPrice = Math.round(iwMatch.price * IW_DISCOUNT * 100) / 100;
        usCompetitor = iwMatch;
        usCompPrice = iwMatch.price;
        usCompSource = 'Inline Warehouse';
        usMatchMethod = iwMethod;
        usShipFee = 0;
      }
      // Check xtremeinn if no IW match (or if XT is cheaper)
      if (xtMatch && xtMatch.currency === 'USD') {
        const shipFee = shippingOverrides.overrides[shopifyProduct.title] ?? XT_SHIPPING_USD;
        const xtUsPrice = Math.round((xtMatch.price + shipFee) * XT_DISCOUNT * 100) / 100;
        if (!usNewPrice || xtUsPrice < usNewPrice) {
          usNewPrice = xtUsPrice;
          usCompetitor = xtMatch;
          usCompPrice = xtMatch.price;
          usCompSource = `xtremeinn (+$${shipFee} ship)`;
          usMatchMethod = xtMethod;
          usShipFee = shipFee;
        }
      }

      if (usNewPrice) {
        // Get current effective US price
        const currentUsPrice = usFixedPrices[variantGid] || (currentPrice * US_DEFAULT_MARKUP);

        const change = {
          productTitle: shopifyProduct.title,
          variantTitle: shopifyVariant.title,
          sku: shopifyVariant.sku || '',
          brand: shopifyProduct.vendor || '',
          market: 'US',
          oldPrice: Math.round(currentUsPrice * 100) / 100,
          newPrice: usNewPrice,
          competitorPrice: usCompPrice,
          competitorSource: usCompSource,
          competitorUrl: usCompetitor.url,
          competitorSku: usCompetitor.sku || '',
          matchMethod: usMatchMethod,
          variantGid,
          shippingFee: usShipFee,
          skipped: false,
          applied: false,
        };

        // Don't change if already cheaper
        if (currentUsPrice <= usNewPrice) {
          change.skipped = true;
          change.newPrice = currentUsPrice;
        } else {
          usPriceUpdates.push({
            variantId: variantGid,
            price: usNewPrice,
            currency: 'USD'
          });
        }

        priceChanges.push(change);
      }
    }

    // --- AU Market Pricing ---
    if (auPriceList && enableAU) {
      // Look up the AU-specific product from xtAuProducts by matching SKU.
      // Don't use match.xtMatch directly — it comes from the combined
      // US+AU+ID list and might be a USD-priced product, not AUD.
      const auComp = (match.xtMatch && xtAuProducts.find(p => p.sku === match.xtMatch.sku)) || null;

      if (auComp && auComp.currency === 'AUD') {
        const auShipFee = shippingOverrides.overrides[shopifyProduct.title] ?? XT_SHIPPING_AUD;
        const totalXtPrice = auComp.price + auShipFee;
        const auNewPrice = Math.round(totalXtPrice * XT_DISCOUNT * 100) / 100;

        const currentAuPrice = auFixedPrices[variantGid] || (currentPrice * AU_DEFAULT_MARKUP);

        const change = {
          productTitle: shopifyProduct.title,
          variantTitle: shopifyVariant.title,
          sku: shopifyVariant.sku || '',
          brand: shopifyProduct.vendor || '',
          market: 'AU',
          oldPrice: Math.round(currentAuPrice * 100) / 100,
          newPrice: auNewPrice,
          competitorPrice: auComp.price,
          competitorSource: `xtremeinn (+A$${auShipFee} ship)`,
          competitorUrl: auComp.url,
          competitorSku: auComp.sku || '',
          shippingFee: auShipFee,
          matchMethod: match.xtMethod || 'name',
          variantGid,
          skipped: false,
          applied: false,
        };

        if (currentAuPrice <= auNewPrice) {
          change.skipped = true;
          change.newPrice = currentAuPrice;
        } else {
          auPriceUpdates.push({
            variantId: variantGid,
            price: auNewPrice,
            currency: 'AUD'
          });
        }

        priceChanges.push(change);
      }
    }

    // --- ID Market Pricing ---
    if (idPriceList && enableID) {
      // Find the xtremeinn ID match (IDR currency)
      const idComp = xtIdProducts.find(p => match.xtMatch && p.sku === match.xtMatch.sku) || null;

      if (idComp && idComp.currency === 'IDR') {
        const idShipFee = shippingOverrides.overrides[shopifyProduct.title] ?? XT_SHIPPING_IDR;
        // Indonesia: add 20% for import tax/duties after shipping, then apply 5% discount
        const totalXtPrice = (idComp.price + idShipFee) * 1.20;
        const idNewPrice = Math.round(totalXtPrice * XT_DISCOUNT);

        const currentIdPrice = idFixedPrices[variantGid] || (currentPrice * ID_DEFAULT_MARKUP);

        const change = {
          productTitle: shopifyProduct.title,
          variantTitle: shopifyVariant.title,
          sku: shopifyVariant.sku || '',
          brand: shopifyProduct.vendor || '',
          market: 'ID',
          oldPrice: Math.round(currentIdPrice),
          newPrice: idNewPrice,
          competitorPrice: idComp.price,
          competitorSource: `xtremeinn (+Rp${idShipFee.toLocaleString()} ship +20% tax)`,
          competitorUrl: idComp.url,
          competitorSku: idComp.sku || '',
          shippingFee: idShipFee,
          matchMethod: 'name',
          variantGid,
          skipped: false,
          applied: false,
        };

        if (currentIdPrice <= idNewPrice) {
          change.skipped = true;
          change.newPrice = currentIdPrice;
        } else {
          idPriceUpdates.push({
            variantId: variantGid,
            price: idNewPrice,
            currency: 'IDR'
          });
        }

        priceChanges.push(change);
      }
    }

    // --- ID Market Pricing (IndoSkates - no shipping, no tax) ---
    // If both xtremeinn AND IndoSkates matched, only use the cheaper one
    // to avoid two conflicting price entries for the same variant.
    if (idPriceList && enableID && match.isMatch) {
      const isComp = match.isMatch;
      const idNewPrice = Math.round(isComp.price * IW_DISCOUNT);

      // Check if xtremeinn already produced a cheaper ID price for this variant
      const existingIdChange = priceChanges.find(c => c.variantGid === variantGid && c.market === 'ID');
      if (existingIdChange && !existingIdChange.skipped && existingIdChange.newPrice <= idNewPrice) {
        // xtremeinn was cheaper — skip IndoSkates
      } else {
        // IndoSkates is cheaper (or xtremeinn didn't match/was skipped)
        // Remove the xtremeinn ID entry if it exists
        if (existingIdChange) {
          const idx = priceChanges.indexOf(existingIdChange);
          if (idx >= 0) priceChanges.splice(idx, 1);
          // Also remove from idPriceUpdates
          const upIdx = idPriceUpdates.findIndex(u => u.variantId === variantGid);
          if (upIdx >= 0) idPriceUpdates.splice(upIdx, 1);
        }

        const currentIdPrice = idFixedPrices[variantGid] || (currentPrice * ID_DEFAULT_MARKUP);

        const change = {
          productTitle: shopifyProduct.title,
          variantTitle: shopifyVariant.title,
          sku: shopifyVariant.sku || '',
          brand: shopifyProduct.vendor || '',
          market: 'ID',
          oldPrice: Math.round(currentIdPrice),
          newPrice: idNewPrice,
          competitorPrice: isComp.price,
          competitorSource: 'IndoSkates',
          competitorUrl: isComp.url,
          competitorSku: isComp.sku || '',
          shippingFee: 0,
          matchMethod: match.isMethod || 'name',
          variantGid,
          skipped: false,
          applied: false,
        };

        if (currentIdPrice <= idNewPrice) {
          change.skipped = true;
          change.newPrice = currentIdPrice;
        } else {
          idPriceUpdates.push({
            variantId: variantGid,
            price: idNewPrice,
            currency: 'IDR'
          });
        }

        priceChanges.push(change);
      }
    }

    // --- PH Market Pricing (xtremeinn + shipping + 15% tax/duties) ---
    if (phPriceList && enablePH) {
      const phComp = (match.xtMatch && xtPhProducts.find(p => p.sku === match.xtMatch.sku)) || null;

      if (phComp && phComp.currency === 'PHP') {
        const phShipFee = shippingOverrides.overrides[shopifyProduct.title + ':PH'] ?? XT_SHIPPING_PHP;
        // Philippines: xt price + shipping, then 5% discount (no tax/duties)
        const phNewPrice = Math.round((phComp.price + phShipFee) * XT_DISCOUNT);

        const currentPhPrice = phFixedPrices[variantGid] || (currentPrice * PH_DEFAULT_MARKUP);

        const change = {
          productTitle: shopifyProduct.title,
          variantTitle: shopifyVariant.title,
          sku: shopifyVariant.sku || '',
          brand: shopifyProduct.vendor || '',
          market: 'PH',
          oldPrice: Math.round(currentPhPrice),
          newPrice: phNewPrice,
          competitorPrice: phComp.price,
          competitorSource: `xtremeinn (+PHP${phShipFee.toLocaleString()} ship)`,
          competitorUrl: phComp.url,
          competitorSku: phComp.sku || '',
          shippingFee: phShipFee,
          matchMethod: match.xtMethod || 'name',
          variantGid,
          skipped: false,
          applied: false,
        };

        if (currentPhPrice <= phNewPrice) {
          change.skipped = true;
          change.newPrice = currentPhPrice;
        } else {
          phPriceUpdates.push({
            variantId: variantGid,
            price: phNewPrice,
            currency: 'PHP'
          });
        }

        priceChanges.push(change);
      }
    }

    // --- JP Market Pricing (xtremeinn + shipping, 5% discount, no tax) ---
    if (jpPriceList && enableJP) {
      const jpComp = (match.xtMatch && xtJpProducts.find(p => p.sku === match.xtMatch.sku)) || null;

      if (jpComp && jpComp.currency === 'JPY') {
        const jpShipFee = shippingOverrides.overrides[shopifyProduct.title + ':JP'] ?? XT_SHIPPING_JPY;
        // Japan: xt price + shipping, then 5% discount (no tax/duties)
        const jpNewPrice = Math.round((jpComp.price + jpShipFee) * XT_DISCOUNT);

        const currentJpPrice = jpFixedPrices[variantGid] || (currentPrice * JP_DEFAULT_MARKUP);

        const change = {
          productTitle: shopifyProduct.title,
          variantTitle: shopifyVariant.title,
          sku: shopifyVariant.sku || '',
          brand: shopifyProduct.vendor || '',
          market: 'JP',
          oldPrice: Math.round(currentJpPrice),
          newPrice: jpNewPrice,
          competitorPrice: jpComp.price,
          competitorSource: `xtremeinn (+JPY${jpShipFee.toLocaleString()} ship)`,
          competitorUrl: jpComp.url,
          competitorSku: jpComp.sku || '',
          shippingFee: jpShipFee,
          matchMethod: match.xtMethod || 'name',
          variantGid,
          skipped: false,
          applied: false,
        };

        if (currentJpPrice <= jpNewPrice) {
          change.skipped = true;
          change.newPrice = currentJpPrice;
        } else {
          jpPriceUpdates.push({
            variantId: variantGid,
            price: jpNewPrice,
            currency: 'JPY'
          });
        }

        priceChanges.push(change);
      }
    }

    // --- CA Market Pricing (xtremeinn + shipping, 5% discount, no tax) ---
    if (caPriceList && enableCA) {
      const caComp = (match.xtMatch && xtCaProducts.find(p => p.sku === match.xtMatch.sku)) || null;

      if (caComp && caComp.currency === 'CAD') {
        const caShipFee = shippingOverrides.overrides[shopifyProduct.title + ':CA'] ?? XT_SHIPPING_CAD;
        // Canada: xt price + shipping, then 5% discount (no tax/duties)
        const caNewPrice = Math.round((caComp.price + caShipFee) * XT_DISCOUNT * 100) / 100;

        const currentCaPrice = caFixedPrices[variantGid] || (currentPrice * CA_DEFAULT_MARKUP);

        const change = {
          productTitle: shopifyProduct.title,
          variantTitle: shopifyVariant.title,
          sku: shopifyVariant.sku || '',
          brand: shopifyProduct.vendor || '',
          market: 'CA',
          oldPrice: Math.round(currentCaPrice * 100) / 100,
          newPrice: caNewPrice,
          competitorPrice: caComp.price,
          competitorSource: `xtremeinn (+CAD${caShipFee} ship)`,
          competitorUrl: caComp.url,
          competitorSku: caComp.sku || '',
          shippingFee: caShipFee,
          matchMethod: match.xtMethod || 'name',
          variantGid,
          skipped: false,
          applied: false,
        };

        if (currentCaPrice <= caNewPrice) {
          change.skipped = true;
          change.newPrice = currentCaPrice;
        } else {
          caPriceUpdates.push({
            variantId: variantGid,
            price: caNewPrice,
            currency: 'CAD'
          });
        }

        priceChanges.push(change);
      }
    }
  }

  log('MAIN', `Price changes calculated: ${priceChanges.length} total`);
  log('MAIN', `  US updates: ${usPriceUpdates.length}`);
  log('MAIN', `  AU updates: ${auPriceUpdates.length}`);
  log('MAIN', `  ID updates: ${idPriceUpdates.length}`);
  log('MAIN', `  PH updates: ${phPriceUpdates.length}`);
  log('MAIN', `  JP updates: ${jpPriceUpdates.length}`);
  log('MAIN', `  CA updates: ${caPriceUpdates.length}`);
  log('MAIN', `  Skipped (already cheaper): ${priceChanges.filter(c => c.skipped).length}`);

  // ==========================================
  // 6. Apply prices to Shopify
  // ==========================================
  if (!dryRun) {
    if (usPriceUpdates.length > 0 && usPriceList) {
      log('MAIN', `Step 7a: Applying ${usPriceUpdates.length} US price updates...`);
      await shopify.setFixedPrices(usPriceList.id, usPriceUpdates);
      usPriceUpdates.forEach(u => {
        const change = priceChanges.find(c => c.variantGid === u.variantId && c.market === 'US');
        if (change) change.applied = true;
      });
    }

    if (auPriceUpdates.length > 0 && auPriceList) {
      log('MAIN', `Step 7b: Applying ${auPriceUpdates.length} AU price updates...`);
      await shopify.setFixedPrices(auPriceList.id, auPriceUpdates);
      auPriceUpdates.forEach(u => {
        const change = priceChanges.find(c => c.variantGid === u.variantId && c.market === 'AU');
        if (change) change.applied = true;
      });
    }

    if (idPriceUpdates.length > 0 && idPriceList) {
      log('MAIN', `Step 7c: Applying ${idPriceUpdates.length} ID price updates...`);
      await shopify.setFixedPrices(idPriceList.id, idPriceUpdates);
      idPriceUpdates.forEach(u => {
        const change = priceChanges.find(c => c.variantGid === u.variantId && c.market === 'ID');
        if (change) change.applied = true;
      });
    }

    if (phPriceUpdates.length > 0 && phPriceList) {
      log('MAIN', `Step 7d: Applying ${phPriceUpdates.length} PH price updates...`);
      await shopify.setFixedPrices(phPriceList.id, phPriceUpdates);
      phPriceUpdates.forEach(u => {
        const change = priceChanges.find(c => c.variantGid === u.variantId && c.market === 'PH');
        if (change) change.applied = true;
      });
    }

    if (jpPriceUpdates.length > 0 && jpPriceList) {
      log('MAIN', `Step 7e: Applying ${jpPriceUpdates.length} JP price updates...`);
      await shopify.setFixedPrices(jpPriceList.id, jpPriceUpdates);
      jpPriceUpdates.forEach(u => {
        const change = priceChanges.find(c => c.variantGid === u.variantId && c.market === 'JP');
        if (change) change.applied = true;
      });
    }

    if (caPriceUpdates.length > 0 && caPriceList) {
      log('MAIN', `Step 7f: Applying ${caPriceUpdates.length} CA price updates...`);
      await shopify.setFixedPrices(caPriceList.id, caPriceUpdates);
      caPriceUpdates.forEach(u => {
        const change = priceChanges.find(c => c.variantGid === u.variantId && c.market === 'CA');
        if (change) change.applied = true;
      });
    }
  } else {
    log('MAIN', 'Step 7: SKIPPED (dry run)');
  }

  // ==========================================
  // 7. Generate report
  // ==========================================
  log('MAIN', 'Step 8: Generating Excel report...');
  const reportPath = await report.generate(priceChanges, dryRun);

  // ==========================================
  // 8. Save competitor price history
  // ==========================================
  log('MAIN', 'Step 9: Saving price history...');
  savePriceHistory(iwProducts, xtUsProducts, xtAuProducts);

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  log('MAIN', `=== Price Match Complete in ${elapsed} minutes ===`);
  log('MAIN', `Report: ${reportPath}`);

  // Save dashboard status
  saveStatus(priceChanges, matches, usPriceUpdates, auPriceUpdates, idPriceUpdates, phPriceUpdates, jpPriceUpdates, caPriceUpdates, dryRun, elapsed, null, unmatched);

  // Set output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `report_path=${reportPath}\n` +
      `us_updates=${usPriceUpdates.length}\n` +
      `au_updates=${auPriceUpdates.length}\n` +
      `total_matches=${matches.length}\n`
    );
  }
}

function savePriceHistory(iwProducts, xtUsProducts, xtAuProducts) {
  const historyFile = path.join(__dirname, 'price-history.json');
  const history = loadJSON(historyFile) || { runs: [] };
  const timestamp = new Date().toISOString();

  history.runs.push({
    timestamp,
    iw: iwProducts.map(p => ({ name: p.name, sku: p.sku, price: p.price })),
    xt_us: xtUsProducts.map(p => ({ name: p.name, sku: p.sku, price: p.price })),
    xt_au: xtAuProducts.map(p => ({ name: p.name, sku: p.sku, price: p.price })),
  });

  // Keep last 10 runs
  if (history.runs.length > 10) {
    history.runs = history.runs.slice(-10);
  }

  saveJSON(historyFile, history);
  log('MAIN', `Price history saved (${history.runs.length} runs)`);
}

function saveStatus(priceChanges, matches, usPriceUpdates, auPriceUpdates, idPriceUpdates, phPriceUpdates, jpPriceUpdates, caPriceUpdates, dryRun, elapsed, error, unmatched) {
  const docsDir = path.join(__dirname, 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  const statusFile = path.join(docsDir, 'status.json');
  const existing = loadJSON(statusFile) || { history: [] };

  const run = {
    timestamp: new Date().toISOString(),
    mode: dryRun ? 'DRY RUN' : 'LIVE',
    durationMinutes: parseFloat(elapsed) || 0,
    totalMatches: matches ? matches.length : 0,
    usUpdates: usPriceUpdates ? usPriceUpdates.length : 0,
    auUpdates: auPriceUpdates ? auPriceUpdates.length : 0,
    idUpdates: idPriceUpdates ? idPriceUpdates.length : 0,
    phUpdates: phPriceUpdates ? phPriceUpdates.length : 0,
    jpUpdates: jpPriceUpdates ? jpPriceUpdates.length : 0,
    caUpdates: caPriceUpdates ? caPriceUpdates.length : 0,
    skipped: priceChanges ? priceChanges.filter(c => c.skipped).length : 0,
    totalChanges: priceChanges ? priceChanges.length : 0,
    status: error ? 'error' : 'success',
    error: error || undefined,
  };

  existing.history.push({
    timestamp: run.timestamp,
    mode: run.mode,
    usUpdates: run.usUpdates,
    auUpdates: run.auUpdates,
    idUpdates: run.idUpdates,
    phUpdates: run.phUpdates,
    jpUpdates: run.jpUpdates,
    caUpdates: run.caUpdates,
    status: run.status,
  });
  if (existing.history.length > 20) existing.history = existing.history.slice(-20);

  const status = {
    lastRun: run,
    priceChanges: (priceChanges || []).map(c => ({
      product: c.productTitle,
      variant: c.variantTitle,
      sku: c.sku,
      brand: c.brand,
      market: c.market,
      oldPrice: c.oldPrice,
      newPrice: c.newPrice,
      competitor: c.competitorSource,
      competitorPrice: c.competitorPrice,
      competitorUrl: c.competitorUrl || '',
      matchMethod: c.matchMethod,
      competitorSku: c.competitorSku || '',
      variantGid: c.variantGid,
      shippingFee: c.shippingFee || 0,
      skipped: c.skipped,
      applied: c.applied,
    })),
    unmatched: (unmatched || []).map(u => ({
      source: u.source,
      name: u.name,
      sku: u.sku,
      price: u.price,
      currency: u.currency,
      url: u.url,
    })),
    history: existing.history,
  };

  saveJSON(statusFile, status);
  log('MAIN', 'Dashboard status saved');
}

main().catch(e => {
  log('MAIN', `FATAL ERROR: ${e.message}`);
  console.error(e.stack);
  saveStatus(null, null, null, null, null, null, null, null, false, '0', e.message);
  process.exit(1);
});
