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
  if (!data || !data.mappings) return { iw: new Map(), xt: new Map(), is: new Map() };
  // One SKU can map to MULTIPLE Shopify products (array of shopifyMatch strings)
  const iw = new Map();
  const xt = new Map();
  const is = new Map();
  const addMapping = (map, sku, target) => {
    if (!map.has(sku)) map.set(sku, []);
    map.get(sku).push(target.toLowerCase());
  };
  for (const m of data.mappings) {
    const src = m.source || 'iw';
    const sku = m.sku || m.iwSku;
    if (src === 'iw') addMapping(iw, sku, m.shopifyMatch);
    else if (src === 'xt') addMapping(xt, sku, m.shopifyMatch);
    else if (src === 'is') addMapping(is, sku, m.shopifyMatch);
  }
  const countTotal = (map) => [...map.values()].reduce((s, a) => s + a.length, 0);
  log('MATCH', `Loaded ${countTotal(iw)} IW + ${countTotal(xt)} XT + ${countTotal(is)} IS manual mappings`);
  return { iw, xt, is };
}

/**
 * Match Shopify products against competitor products.
 * Priority: manual mapping > SKU exact match > barcode match > name similarity
 *
 * Safety: each competitor product can only match ONE Shopify product (best match wins)
 */
function matchAll(shopifyProducts, iwProducts, xtProducts, isProducts) {
  isProducts = isProducts || [];
  const { iw: iwManualMap, xt: xtManualMap, is: isManualMap } = loadManualMappings();

  // Filter out blocked products
  // Values are arrays of targets; a SKU is blocked only if ALL its targets are '__blocked__'
  const isBlocked = (targets) => Array.isArray(targets) && targets.length > 0 && targets.every(t => t === '__blocked__');
  const blockedIw = new Set([...iwManualMap.entries()].filter(([k,v]) => isBlocked(v)).map(([k]) => k));
  const blockedXt = new Set([...xtManualMap.entries()].filter(([k,v]) => isBlocked(v)).map(([k]) => k));
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
    // If the manual mapping targeted a specific Shopify variant by SKU/barcode,
    // record it here so the price only applies to that one variant (needed for
    // size-differentiated wheels where each IW size row has its own price).
    let iwTargetVariantSku = null;

    // 0. Manual mapping — check if any IW product has a manual mapping to this Shopify product
    // Supports both title keyword match and Shopify SKU match
    const titleLower = product.title.toLowerCase();
    const shopifySkus = product.variants.map(v => v.sku).filter(Boolean);
    const shopifyBarcodes = product.variants.map(v => v.barcode).filter(Boolean);

    for (const p of iwProducts) {
      const baseSku = p.sku.replace(/-\w+$/, '');
      const targets = iwManualMap.get(p.sku) || iwManualMap.get(baseSku);
      if (!targets) continue;

      // Check each target; a variant-SKU/barcode hit is variant-specific,
      // a title-substring hit applies to every variant of the product.
      let matched = false;
      for (const t of targets) {
        const variantBySku = product.variants.find(v => v.sku === t);
        const variantByBarcode = product.variants.find(v => v.barcode === t);
        if (variantBySku || variantByBarcode) {
          iwTargetVariantSku = (variantBySku || variantByBarcode).sku;
          matched = true;
          break;
        }
        if (titleLower.includes(t.toLowerCase())) {
          matched = true;
          break;
        }
      }

      if (matched) {
        iwMatch = p;
        iwMethod = 'manual';
        log('MATCH', `MANUAL: "${product.title}"${iwTargetVariantSku ? ` [variant ${iwTargetVariantSku}]` : ''} -> "${p.name}" ($${p.price})`);
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
    let xtTargetVariantSku = null;

    // 0. XT Manual mapping
    for (const p of xtProducts) {
      const targets = xtManualMap.get(p.sku);
      if (!targets) continue;

      let matched = false;
      for (const t of targets) {
        const variantBySku = product.variants.find(v => v.sku === t);
        const variantByBarcode = product.variants.find(v => v.barcode === t);
        if (variantBySku || variantByBarcode) {
          xtTargetVariantSku = (variantBySku || variantByBarcode).sku;
          matched = true;
          break;
        }
        if (titleLower.includes(t.toLowerCase())) {
          matched = true;
          break;
        }
      }

      if (matched) {
        xtMatch = p;
        xtMethod = 'manual';
        log('MATCH', `MANUAL-XT: "${product.title}"${xtTargetVariantSku ? ` [variant ${xtTargetVariantSku}]` : ''} -> "${p.name}" ($${p.price})`);
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
    let isTargetVariantSku = null;

    // 0. IS Manual mapping first
    for (const p of isProducts) {
      const targets = isManualMap.get(p.sku);
      if (!targets) continue;
      let matched = false;
      for (const t of targets) {
        const variantBySku = product.variants.find(v => v.sku === t);
        const variantByBarcode = product.variants.find(v => v.barcode === t);
        if (variantBySku || variantByBarcode) {
          isTargetVariantSku = (variantBySku || variantByBarcode).sku;
          matched = true;
          break;
        }
        if (titleLower.includes(t.toLowerCase())) {
          matched = true;
          break;
        }
      }
      if (matched) {
        isMatch = p;
        isMethod = 'manual';
        log('MATCH', `MANUAL-IS: "${product.title}"${isTargetVariantSku ? ` [variant ${isTargetVariantSku}]` : ''} -> "${p.name}" (Rp${p.price.toLocaleString()})`);
        break;
      }
    }

    // 1. Substring matching — IS uses short names like "Crossfire"
    if (!isMatch && isProducts.length > 0) {
      const titleLowerFull = product.title.toLowerCase();
      let bestMatchLength = 0;
      for (const p of isProducts) {
        const isNameLower = (p.name || '').toLowerCase().trim();
        if (!isNameLower || isNameLower.length < 4) continue;

        if (titleLowerFull.includes(isNameLower)) {
          if (isNameLower.length > bestMatchLength) {
            bestMatchLength = isNameLower.length;
            isMatch = p;
            isMethod = `substring(${isNameLower.length})`;
          }
        }
      }
    }

    if (iwMatch || xtMatch || isMatch) {
      // Add match for each variant of the product. When a source has a
      // variant-specific target (i.e. the mapping pointed at a Shopify
      // variant SKU/barcode), only that variant receives that source's
      // match — the other variants get null for that source. Other
      // sources still apply broadly to every variant.
      for (const variant of product.variants) {
        const iwAppliesHere = !iwTargetVariantSku || variant.sku === iwTargetVariantSku;
        const xtAppliesHere = !xtTargetVariantSku || variant.sku === xtTargetVariantSku;
        const isAppliesHere = !isTargetVariantSku || variant.sku === isTargetVariantSku;

        const iwM = iwAppliesHere ? iwMatch : null;
        const iwMeth = iwAppliesHere ? iwMethod : null;
        const xtM = xtAppliesHere ? xtMatch : null;
        const xtMeth = xtAppliesHere ? xtMethod : null;
        const isM = isAppliesHere ? isMatch : null;
        const isMeth = isAppliesHere ? isMethod : null;

        if (!iwM && !xtM && !isM) continue;

        candidates.push({
          shopifyProduct: product,
          shopifyVariant: variant,
          variantGid: `gid://shopify/ProductVariant/${variant.id}`,
          currentPrice: parseFloat(variant.price),
          iwMatch: iwM,
          iwMethod: iwMeth,
          xtMatch: xtM,
          xtMethod: xtMeth,
          isMatch: isM,
          isMethod: isMeth,
          iwCompId: iwM ? iwM.sku : null,
          xtCompId: xtM ? xtM.sku : null,
          isCompId: isM ? isM.sku : null,
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

    // If all matches are MANUAL, keep all of them (user intentionally mapped multiple Shopify products to this IW SKU)
    const allManual = group.every(c => c.iwMethod === 'manual');
    if (allManual) {
      for (const c of group) {
        matches.push(c);
        iwUsed.add(compSku);
      }
      if (productIds.length > 1) {
        log('MATCH', `MANUAL: IW ${compSku} mapped to ${productIds.length} Shopify products`);
      }
      continue;
    }

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
  const matchedIsSkus = new Set(matches.filter(m => m.isMatch).map(m => m.isMatch.sku));

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
  for (const p of isProducts) {
    if (!matchedIsSkus.has(p.sku)) {
      unmatched.push({ source: 'is', name: p.name, sku: p.sku, price: p.price, currency: 'IDR', url: p.url });
    }
  }

  const iwMatched = matches.filter(m => m.iwMatch).length;
  const xtMatched = matches.filter(m => m.xtMatch).length;
  const isMatched = matches.filter(m => m.isMatch).length;
  log('MATCH', `Matched ${matches.length} variants (IW: ${iwMatched}, XT: ${xtMatched}, IS: ${isMatched}) | Unmatched: ${unmatched.length}`);

  // Report dead manual mappings — mappings that never found a Shopify product
  // to attach to. These are usually typos or titles that don't match anything
  // in the current Shopify catalog.
  const matchedIwSkus2 = new Set(matches.filter(m => m.iwMatch && m.iwMethod === 'manual').map(m => m.iwMatch.sku));
  const matchedXtSkus2 = new Set(matches.filter(m => m.xtMatch && m.xtMethod === 'manual').map(m => m.xtMatch.sku));
  const matchedIsSkus2 = new Set(matches.filter(m => m.isMatch && m.isMethod === 'manual').map(m => m.isMatch.sku));

  const reportDead = (map, matchedSet, label, competitorProducts) => {
    const compSkuSet = new Set(competitorProducts.map(p => p.sku));
    const deadInShop = []; // mapping exists but no Shopify product matched the target
    const deadNoComp = []; // mapping exists but competitor product wasn't scraped
    for (const [sku, targets] of map) {
      if (!targets || targets.length === 0) continue;
      if (targets.every(t => t === '__blocked__')) continue;
      const competitorHas = compSkuSet.has(sku) || compSkuSet.has(sku.replace(/-\w+$/, ''));
      if (!competitorHas) {
        deadNoComp.push({ sku, targets });
        continue;
      }
      if (!matchedSet.has(sku)) {
        deadInShop.push({ sku, targets });
      }
    }
    if (deadNoComp.length > 0) {
      log('MATCH', `${label}: ${deadNoComp.length} mappings for SKUs not in the current scrape (competitor product missing):`);
      for (const d of deadNoComp.slice(0, 10)) log('MATCH', `  ${label}:${d.sku} -> ${d.targets.join(' | ')}`);
      if (deadNoComp.length > 10) log('MATCH', `  ...and ${deadNoComp.length - 10} more`);
    }
    if (deadInShop.length > 0) {
      log('MATCH', `${label}: ${deadInShop.length} mappings where target didn't match any Shopify product:`);
      for (const d of deadInShop.slice(0, 10)) log('MATCH', `  ${label}:${d.sku} -> ${d.targets.join(' | ')}`);
      if (deadInShop.length > 10) log('MATCH', `  ...and ${deadInShop.length - 10} more`);
    }
  };

  reportDead(iwManualMap, matchedIwSkus2, 'IW', iwProducts);
  reportDead(xtManualMap, matchedXtSkus2, 'XT', xtProducts);
  reportDead(isManualMap, matchedIsSkus2, 'IS', isProducts);

  return { matches, unmatched };
}

module.exports = { matchAll };
