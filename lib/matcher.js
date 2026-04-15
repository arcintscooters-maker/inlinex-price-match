const { normalize, similarity, log, loadJSON } = require('./utils');
const path = require('path');

const MIN_SIMILARITY = 0.75; // Raised from 0.55 to prevent false matches
const MAX_PRICE_RATIO = 2.0; // Reject if competitor price is >2x or <0.5x of Shopify price

/**
 * Load manual mappings: IW SKU -> Shopify product title substring
 */
function loadManualMappings() {
  const file = path.join(__dirname, '..', 'manual-mappings.json');
  const data = loadJSON(file);
  if (!data || !data.mappings) return { iw: new Map(), xt: new Map() };
  const iw = new Map();
  const xt = new Map();
  for (const m of data.mappings) {
    const src = m.source || 'iw';
    const sku = m.sku || m.iwSku; // backwards compat
    if (src === 'iw') iw.set(sku, m.shopifyMatch.toLowerCase());
    else if (src === 'xt') xt.set(sku, m.shopifyMatch.toLowerCase());
  }
  log('MATCH', `Loaded ${iw.size} IW + ${xt.size} XT manual mappings`);
  return { iw, xt };
}

/**
 * Match Shopify products against competitor products.
 * Priority: manual mapping > SKU exact match > barcode match > name similarity
 *
 * Safety: each competitor product can only match ONE Shopify product (best match wins)
 */
function matchAll(shopifyProducts, iwProducts, xtProducts, isProducts) {
  isProducts = isProducts || [];
  const { iw: iwManualMap, xt: xtManualMap } = loadManualMappings();

  // Filter out blocked products
  const blockedIw = new Set([...iwManualMap.entries()].filter(([k,v]) => v === '__blocked__').map(([k]) => k));
  const blockedXt = new Set([...xtManualMap.entries()].filter(([k,v]) => v === '__blocked__').map(([k]) => k));
  iwProducts = iwProducts.filter(p => !blockedIw.has(p.sku) && !blockedIw.has(p.sku.replace(/-\w+$/, '')));
  xtProducts = xtProducts.filter(p => !blockedXt.has(p.sku));

  // Build lookup indexes for competitor products
  const iwBySku = new Map();
  for (const p of iwProducts) {
    if (p.sku) iwBySku.set(normalize(p.sku), p);
  }

  const xtBySku = new Map();
  for (const p of xtProducts) {
    if (p.sku) xtBySku.set(normalize(p.sku), p);
  }

  // First pass: collect all candidate matches with scores
  const candidates = [];

  for (const product of shopifyProducts) {
    // Only match the first variant per product for name-based matching
    // (all variants of the same product should match the same competitor product)
    const firstVariant = product.variants[0];
    if (!firstVariant) continue;

    const fullName = `${product.vendor || ''} ${product.title}`.trim();
    const shopifyBasePrice = parseFloat(firstVariant.price);

    // Try matching against Inline Warehouse
    let iwMatch = null;
    let iwMethod = null;

    // 0. Manual mapping — check if any IW product has a manual mapping to this Shopify product
    // Supports both title keyword match and Shopify SKU match
    const titleLower = product.title.toLowerCase();
    const shopifySkus = product.variants.map(v => v.sku).filter(Boolean);
    const shopifyBarcodes = product.variants.map(v => v.barcode).filter(Boolean);

    for (const p of iwProducts) {
      const baseSku = p.sku.replace(/-\w+$/, '');
      const manualTarget = iwManualMap.get(p.sku) || iwManualMap.get(baseSku);
      if (!manualTarget) continue;

      // Check if manualTarget matches a Shopify SKU/barcode or title keyword
      const matched = shopifySkus.includes(manualTarget) ||
        shopifyBarcodes.includes(manualTarget) ||
        titleLower.includes(manualTarget.toLowerCase());

      if (matched) {
        iwMatch = p;
        iwMethod = 'manual';
        log('MATCH', `MANUAL: "${product.title}" -> "${p.name}" ($${p.price})`);
        break;
      }
    }

    // 1. SKU match — check all variants
    if (!iwMatch) for (const variant of product.variants) {
      const skuNorm = normalize(variant.sku || '');
      const barcodeNorm = normalize(variant.barcode || '');

      if (skuNorm && iwBySku.has(skuNorm)) {
        iwMatch = iwBySku.get(skuNorm);
        iwMethod = 'sku';
        break;
      }

      // 2. Barcode/model number match
      if (barcodeNorm) {
        for (const p of iwProducts) {
          if (p.modelNumber && normalize(p.modelNumber) === barcodeNorm) {
            iwMatch = p;
            iwMethod = 'barcode';
            break;
          }
        }
        if (iwMatch) break;
      }
    }

    // 3. Name similarity (only if no SKU/barcode match)
    if (!iwMatch) {
      let bestScore = 0;
      // Extract size from Shopify product name (e.g. "68mm" from "Vortex 68mm Wheels")
      const shopifySizeMatch = fullName.match(/(\d+)\s*mm/i);
      const shopifySize = shopifySizeMatch ? shopifySizeMatch[1] : null;

      for (const p of iwProducts) {
        // Match brand first
        const vendorNorm = normalize(product.vendor || '');
        const compBrandNorm = normalize(p.brand || '');
        if (vendorNorm && compBrandNorm && !compBrandNorm.includes(vendorNorm) && !vendorNorm.includes(compBrandNorm)) {
          continue;
        }

        let score = similarity(fullName, p.name);

        // Size-aware matching: if both have a size, boost score when sizes match, reject when they don't
        if (shopifySize && p.size) {
          const compSize = p.size.replace(/mm/i, '');
          if (compSize === shopifySize) {
            score = Math.min(1, score + 0.25); // Boost matching sizes
          } else {
            continue; // Different sizes — skip entirely
          }
        }

        if (score > bestScore && score >= MIN_SIMILARITY) {
          bestScore = score;
          iwMatch = p;
          iwMethod = `name(${score.toFixed(2)})`;
        }
      }
    }

    // Price sanity check for name-based matches
    if (iwMatch && iwMethod && iwMethod.startsWith('name')) {
      const ratio = iwMatch.price / shopifyBasePrice;
      if (ratio > MAX_PRICE_RATIO || ratio < (1 / MAX_PRICE_RATIO)) {
        log('MATCH', `REJECTED: "${product.title}" -> "${iwMatch.name}" (price ratio ${ratio.toFixed(2)}x: $${shopifyBasePrice} vs $${iwMatch.price})`);
        iwMatch = null;
        iwMethod = null;
      }
    }

    // Try matching against xtremeinn
    let xtMatch = null;
    let xtMethod = null;

    // 0. XT Manual mapping
    for (const p of xtProducts) {
      const manualTarget = xtManualMap.get(p.sku);
      if (!manualTarget) continue;

      const matched = shopifySkus.includes(manualTarget) ||
        shopifyBarcodes.includes(manualTarget) ||
        titleLower.includes(manualTarget.toLowerCase());

      if (matched) {
        xtMatch = p;
        xtMethod = 'manual';
        log('MATCH', `MANUAL-XT: "${product.title}" -> "${p.name}" ($${p.price})`);
        break;
      }
    }

    if (!xtMatch) for (const variant of product.variants) {
      const skuNorm = normalize(variant.sku || '');
      const barcodeNorm = normalize(variant.barcode || '');

      if (skuNorm && xtBySku.has(skuNorm)) {
        xtMatch = xtBySku.get(skuNorm);
        xtMethod = 'sku';
        break;
      }
      if (barcodeNorm) {
        for (const p of xtProducts) {
          if (p.sku && normalize(p.sku) === barcodeNorm) {
            xtMatch = p;
            xtMethod = 'barcode';
            break;
          }
        }
        if (xtMatch) break;
      }
    }

    if (!xtMatch) {
      let bestScore = 0;
      for (const p of xtProducts) {
        const vendorNorm = normalize(product.vendor || '');
        const compBrandNorm = normalize(p.brand || '');
        if (vendorNorm && compBrandNorm && !compBrandNorm.includes(vendorNorm) && !vendorNorm.includes(compBrandNorm)) {
          continue;
        }
        const score = similarity(fullName, p.name);
        if (score > bestScore && score >= MIN_SIMILARITY) {
          bestScore = score;
          xtMatch = p;
          xtMethod = `name(${score.toFixed(2)})`;
        }
      }
    }

    if (xtMatch && xtMethod && xtMethod.startsWith('name')) {
      const ratio = xtMatch.price / shopifyBasePrice;
      if (ratio > MAX_PRICE_RATIO || ratio < (1 / MAX_PRICE_RATIO)) {
        log('MATCH', `REJECTED: "${product.title}" -> "${xtMatch.name}" (price ratio ${ratio.toFixed(2)}x)`);
        xtMatch = null;
        xtMethod = null;
      }
    }

    // Try matching against IndoSkates (ID market)
    let isMatch = null;
    let isMethod = null;
    if (isProducts.length > 0) {
      let bestScore = 0;
      for (const p of isProducts) {
        const score = similarity(fullName, p.name);
        if (score > bestScore && score >= MIN_SIMILARITY) {
          bestScore = score;
          isMatch = p;
          isMethod = `name(${score.toFixed(2)})`;
        }
      }
      // Price sanity for name-based IS matches (IDR prices, so ratio check in different scale)
      if (isMatch && isMethod && isMethod.startsWith('name')) {
        // Use oldPrice from Shopify (IDR catalog price) to compare — but we don't have it here yet.
        // Skip the ratio check for IS since IDR scale differs; rely on 0.75 similarity threshold.
      }
    }

    if (iwMatch || xtMatch || isMatch) {
      // Add match for each variant of the product
      for (const variant of product.variants) {
        candidates.push({
          shopifyProduct: product,
          shopifyVariant: variant,
          variantGid: `gid://shopify/ProductVariant/${variant.id}`,
          currentPrice: parseFloat(variant.price),
          iwMatch,
          iwMethod,
          xtMatch,
          xtMethod,
          isMatch,
          isMethod,
          iwCompId: iwMatch ? iwMatch.sku : null,
          xtCompId: xtMatch ? xtMatch.sku : null,
          isCompId: isMatch ? isMatch.sku : null,
        });
      }
    }
  }

  // Second pass: deduplicate — each competitor product should only match one Shopify product
  // If multiple Shopify products matched the same IW product, keep the best name match
  const iwUsed = new Set();
  const matches = [];

  // Group candidates by competitor product
  const byIwSku = new Map();
  for (const c of candidates) {
    if (!c.iwCompId) continue;
    if (!byIwSku.has(c.iwCompId)) byIwSku.set(c.iwCompId, []);
    byIwSku.get(c.iwCompId).push(c);
  }

  // For each competitor product, pick the best Shopify product match
  for (const [compSku, group] of byIwSku) {
    // Get unique Shopify products in this group
    const productIds = [...new Set(group.map(c => c.shopifyProduct.id))];

    if (productIds.length > 1) {
      // Multiple Shopify products matched same IW product — pick the one with highest similarity or SKU match
      let bestProductId = null;
      let bestScore = -1;

      for (const pid of productIds) {
        const sample = group.find(c => c.shopifyProduct.id === pid);
        if (sample.iwMethod === 'sku' || sample.iwMethod === 'barcode') {
          bestProductId = pid;
          break;
        }
        const scoreMatch = (sample.iwMethod || '').match(/name\(([\d.]+)\)/);
        const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
        if (score > bestScore) {
          bestScore = score;
          bestProductId = pid;
        }
      }

      const rejected = productIds.filter(id => id !== bestProductId);
      for (const rid of rejected) {
        const sample = group.find(c => c.shopifyProduct.id === rid);
        log('MATCH', `DEDUP: "${sample.shopifyProduct.title}" also matched IW "${sample.iwMatch.name}" but "${group.find(c => c.shopifyProduct.id === bestProductId).shopifyProduct.title}" is a better match`);
      }

      // Only keep variants from the best product
      for (const c of group) {
        if (c.shopifyProduct.id === bestProductId) {
          matches.push(c);
          iwUsed.add(compSku);
        }
      }
    } else {
      // Only one Shopify product matched — keep all its variants
      for (const c of group) {
        matches.push(c);
        iwUsed.add(compSku);
      }
    }
  }

  // Add candidates that only had XT or IS matches (no IW match)
  for (const c of candidates) {
    if (!c.iwMatch && (c.xtMatch || c.isMatch)) {
      matches.push(c);
    }
  }

  // Collect unmatched competitor products
  const matchedIwSkus = new Set(matches.filter(m => m.iwMatch).map(m => m.iwMatch.sku));
  const matchedXtSkus = new Set(matches.filter(m => m.xtMatch).map(m => m.xtMatch.sku));

  const unmatched = [];
  for (const p of iwProducts) {
    const baseSku = p.sku.replace(/-\w+$/, '');
    if (!matchedIwSkus.has(p.sku) && !matchedIwSkus.has(baseSku)) {
      unmatched.push({ source: 'iw', name: p.name, sku: p.sku, price: p.price, currency: p.currency || 'USD', url: p.url });
    }
  }
  for (const p of xtProducts) {
    if (!matchedXtSkus.has(p.sku)) {
      unmatched.push({ source: 'xt', name: p.name, sku: p.sku, price: p.price, currency: p.currency || 'AUD', url: p.url });
    }
  }

  log('MATCH', `Matched ${matches.length} variants (IW: ${matches.filter(m => m.iwMatch).length}, XT: ${matches.filter(m => m.xtMatch).length}) | Unmatched: ${unmatched.length}`);
  return { matches, unmatched };
}

module.exports = { matchAll };
