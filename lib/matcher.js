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
  if (!data || !data.mappings) return new Map();
  const map = new Map();
  for (const m of data.mappings) {
    map.set(m.iwSku, m.shopifyMatch.toLowerCase());
  }
  log('MATCH', `Loaded ${map.size} manual mappings`);
  return map;
}

/**
 * Match Shopify products against competitor products.
 * Priority: manual mapping > SKU exact match > barcode match > name similarity
 *
 * Safety: each competitor product can only match ONE Shopify product (best match wins)
 */
function matchAll(shopifyProducts, iwProducts, xtProducts) {
  const manualMap = loadManualMappings();

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
    const titleLower = product.title.toLowerCase();
    for (const p of iwProducts) {
      const manualTarget = manualMap.get(p.sku);
      if (manualTarget && titleLower.includes(manualTarget)) {
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

    // Try matching against xtremeinn (same logic)
    let xtMatch = null;
    let xtMethod = null;

    for (const variant of product.variants) {
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

    if (iwMatch || xtMatch) {
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
          iwCompId: iwMatch ? iwMatch.sku : null,
          xtCompId: xtMatch ? xtMatch.sku : null,
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

  // Add candidates that only had XT matches (no IW match)
  for (const c of candidates) {
    if (!c.iwMatch && c.xtMatch) {
      matches.push(c);
    }
  }

  log('MATCH', `Matched ${matches.length} variants (IW: ${matches.filter(m => m.iwMatch).length}, XT: ${matches.filter(m => m.xtMatch).length})`);
  return matches;
}

module.exports = { matchAll };
