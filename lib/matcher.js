const { normalize, similarity, log, loadJSON } = require('./utils');
const path = require('path');

const MIN_SIMILARITY = 0.75; // Raised from 0.55 to prevent false matches
const MAX_PRICE_RATIO = 2.0; // Reject if competitor price is >2x or <0.5x of Shopify price

// Rough FX rates for the price-sanity-check only — precise enough to catch
// order-of-magnitude mismatches, not for actual pricing. Shopify variant
// prices are in the shop base currency (SGD for inlinex.com.sg).
const SHOPIFY_BASE_CURRENCY = 'SGD';
const FX_TO_USD = {
  USD: 1,
  SGD: 0.75,
  AUD: 0.66,
  EUR: 1.08,
  IDR: 1 / 15900,
  PHP: 1 / 56,
};
function toUsdForCheck(price, currency) {
  const rate = FX_TO_USD[currency || 'USD'] ?? 1;
  return price * rate;
}

/**
 * Load manual mappings: IW SKU -> Shopify product title substring
 *
 * Also returns an xtSlugMap so dead-SKU rebinds can resolve by the stable
 * xtremeinn URL slug (e.g. "powerslide-zoom-pro-80-inline-skates"), which
 * survives catalog rotations that change numeric IDs.
 */
function loadManualMappings() {
  const file = path.join(__dirname, '..', 'manual-mappings.json');
  const data = loadJSON(file);
  if (!data || !data.mappings) {
    return { iw: new Map(), xt: new Map(), is: new Map(), xtSlugToSku: new Map() };
  }
  // One SKU can map to MULTIPLE Shopify products (array of shopifyMatch strings)
  const iw = new Map();
  const xt = new Map();
  const is = new Map();
  const xtSlugToSku = new Map(); // slug -> [sku, sku, ...]
  const addMapping = (map, sku, target) => {
    if (!map.has(sku)) map.set(sku, []);
    map.get(sku).push(target.toLowerCase());
  };
  for (const m of data.mappings) {
    const src = m.source || 'iw';
    const sku = m.sku || m.iwSku;
    if (src === 'iw') addMapping(iw, sku, m.shopifyMatch);
    else if (src === 'xt') {
      addMapping(xt, sku, m.shopifyMatch);
      // Reject the literal "-" placeholder slug from earlier buggy backfills.
      if (m.slug && m.slug !== '-' && m.slug.length > 1) {
        if (!xtSlugToSku.has(m.slug)) xtSlugToSku.set(m.slug, new Set());
        xtSlugToSku.get(m.slug).add(sku);
      }
    }
    else if (src === 'is') addMapping(is, sku, m.shopifyMatch);
  }
  const countTotal = (map) => [...map.values()].reduce((s, a) => s + a.length, 0);
  log('MATCH', `Loaded ${countTotal(iw)} IW + ${countTotal(xt)} XT + ${countTotal(is)} IS manual mappings`);
  return { iw, xt, is, xtSlugToSku };
}

/**
 * Match Shopify products against competitor products.
 * Priority: manual mapping > SKU exact match > barcode match > name similarity
 *
 * Safety: each competitor product can only match ONE Shopify product (best match wins)
 */
function matchAll(shopifyProducts, iwProducts, xtProducts, isProducts) {
  isProducts = isProducts || [];
  const { iw: iwManualMap, xt: xtManualMap, is: isManualMap, xtSlugToSku } = loadManualMappings();

  // --- Repair dead xt mappings ---
  // xtremeinn rotates numeric product IDs every few months but keeps the same
  // URL slug (e.g. "powerslide-zoom-renegade-125-inline-skates-refurbished").
  // When a mapping's xt SKU is no longer in the current scrape:
  //   1. If the mapping entry remembers a slug, resolve it by slug (safe).
  //   2. Otherwise fall back to Jaccard similarity on the target name.
  {
    const liveSkus = new Set(xtProducts.map(p => p.sku));
    const liveBySlug = new Map();
    for (const p of xtProducts) {
      if (p.slug) liveBySlug.set(p.slug, p);
    }
    const rebindings = [];
    // First pass: slug-based recovery. For every xt mapping entry that has a
    // slug stored alongside the sku, if the sku is dead but the slug is still
    // live in the current scrape, rebind instantly — this is safe because the
    // slug is xtremeinn's stable identifier.
    for (const [slug, skuSet] of xtSlugToSku) {
      const liveP = liveBySlug.get(slug);
      if (!liveP) continue;
      for (const deadSku of skuSet) {
        if (deadSku === liveP.sku) continue; // same sku, not a rotation
        if (liveSkus.has(deadSku)) continue; // both live — nothing to do
        const targets = xtManualMap.get(deadSku);
        if (!targets || targets.every(t => t === '__blocked__')) continue;
        if (!xtManualMap.has(liveP.sku)) xtManualMap.set(liveP.sku, []);
        for (const t of targets) {
          if (!xtManualMap.get(liveP.sku).includes(t)) xtManualMap.get(liveP.sku).push(t);
          rebindings.push({ dead: deadSku, live: liveP.sku, target: t, name: liveP.name, score: 1.0, via: 'slug' });
        }
      }
    }

    // Stopwords stripped before Jaccard comparison so "Aggressive Skate" vs
    // "Inline Skates" doesn't tank the score. Defined once outside the loop.
    const REBIND_STOP = new Set([
      'skates', 'skate', 'inline', 'aggressive', 'adjustable',
      'junior', 'woman', 'women', 'men', 'kids', 'adult',
      'usd', 'powerslide', 'rollerblade', 'fr', 'seba',
    ]);
    const stripStop = (str) =>
      normalize(str).split(' ').filter(w => w.length >= 2 && !REBIND_STOP.has(w)).join(' ');

    const deadCount = [...xtManualMap.keys()].filter(k => !liveSkus.has(k)).length;
    log('MATCH', `[REBIND v3] ${liveSkus.size} live xt SKUs, ${xtManualMap.size} mapped, ${deadCount} dead → attempting similarity rebind...`);

    for (const [deadSku, targets] of [...xtManualMap.entries()]) {
      if (liveSkus.has(deadSku)) continue;
      if (!targets || targets.every(t => t === '__blocked__')) continue;

      for (const target of targets) {
        if (target === '__blocked__') continue;

        // Derive a clean "comparison name" from the target
        let comparisonTarget = target;
        const handleMatch = target.match(/\/products\/([a-z0-9][a-z0-9-]*)/);
        if (handleMatch) {
          comparisonTarget = handleMatch[1].replace(/-/g, ' ');
        }

        // Compare with stopwords stripped
        const targetClean = stripStop(comparisonTarget);
        let best = null, bestScore = 0;
        let second = 0;
        for (const p of xtProducts) {
          if (!p.name) continue;
          const score = similarity(targetClean, stripStop(p.name));
          if (score > bestScore) {
            second = bestScore;
            bestScore = score;
            best = p;
          } else if (score > second) {
            second = score;
          }
        }

        if (best && bestScore >= 0.65 && (bestScore - second) >= 0.10) {
          if (!xtManualMap.has(best.sku)) xtManualMap.set(best.sku, []);
          if (!xtManualMap.get(best.sku).includes(target)) xtManualMap.get(best.sku).push(target);
          rebindings.push({ dead: deadSku, live: best.sku, target, name: best.name, score: bestScore });
        } else if (best && bestScore >= 0.40) {
          // Log near-misses so we can see why rebinds are failing
          if (rebindings.length + deadCount < 30) { // limit verbosity
            log('MATCH', `  Rebind miss xt:${deadSku} "${comparisonTarget.slice(0,50)}" → best "${best.name.slice(0,50)}" sim=${bestScore.toFixed(2)} gap=${(bestScore-second).toFixed(2)}`);
          }
        }
      }
    }
    // Always try to backfill slugs for live mappings (first-time migration
    // for existing mappings that don't have a slug yet). Even with zero
    // rebinds this can persist changes.
    const needsPersist = rebindings.length > 0 || xtProducts.some(p => p.slug);

    if (rebindings.length > 0) {
      log('MATCH', `Rebound ${rebindings.length} dead xt mapping(s) to new SKUs (xtremeinn catalog rotation):`);
      for (const r of rebindings.slice(0, 20)) {
        const via = r.via ? ` via ${r.via}` : '';
        log('MATCH', `  xt:${r.dead} -> xt:${r.live} | "${r.target.slice(0,60)}" matched "${r.name}" (sim ${r.score.toFixed(2)}${via})`);
      }
      if (rebindings.length > 20) log('MATCH', `  ...and ${rebindings.length - 20} more`);
    }

    if (needsPersist) {

      // Persist rebinds to manual-mappings.json so future runs start clean
      // and the mapping "sticks" across xtremeinn catalog rotations.
      try {
        const fs = require('fs');
        const path = require('path');
        const file = path.join(__dirname, '..', 'manual-mappings.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        // Map sku -> slug from the current live xtProducts (reject "-" junk).
        const skuToSlug = new Map();
        for (const p of xtProducts) {
          if (p.slug && p.slug !== '-' && p.slug.length > 1) skuToSlug.set(p.sku, p.slug);
        }
        // Also strip any junk "-" slugs already in the file
        for (const m of data.mappings) {
          if ((m.source || 'iw') === 'xt' && (m.slug === '-' || m.slug === '')) delete m.slug;
        }
        let modified = 0;
        // Track which dead SKUs were successfully rebound so we can
        // remove ALL old entries for that dead SKU (including URL-based
        // duplicates from the colleague) to prevent buildup.
        const reboundDeadSkus = new Set();
        for (const r of rebindings) {
          // First: check if the live SKU already has this target
          // (from a previous rebind or duplicate). Skip if so.
          const alreadyExists = data.mappings.some(m =>
            (m.source || 'iw') === 'xt' &&
            (m.sku || m.iwSku) === r.live &&
            (m.shopifyMatch || '').toLowerCase() === r.target
          );
          if (alreadyExists) {
            // Just mark the dead sku for cleanup, don't add a duplicate
            reboundDeadSkus.add(r.dead);
            continue;
          }

          for (const m of data.mappings) {
            if ((m.source || 'iw') !== 'xt') continue;
            if ((m.sku || m.iwSku) !== r.dead) continue;
            if ((m.shopifyMatch || '').toLowerCase() !== r.target) continue;
            m.sku = r.live;
            const newSlug = skuToSlug.get(r.live);
            if (newSlug) m.slug = newSlug;
            m.note = `Auto-rebound from ${r.dead} via ${r.via || 'similarity'} (xtremeinn rotation)`;
            reboundDeadSkus.add(r.dead);
            modified++;
            break;
          }
        }

        // Remove ONLY the specific dead-SKU entries whose target was
        // successfully rebound. Don't delete targets that weren't rebound
        // — those are still needed for future rebind attempts.
        if (reboundDeadSkus.size > 0) {
          // Build set of (deadSku, target) pairs that were rebound
          const reboundPairs = new Set();
          for (const r of rebindings) {
            reboundPairs.add(`${r.dead}||${r.target}`);
          }
          const beforeLen = data.mappings.length;
          data.mappings = data.mappings.filter(m => {
            if ((m.source || 'iw') !== 'xt') return true;
            const sku = m.sku || m.iwSku;
            if (!reboundDeadSkus.has(sku)) return true;
            const t = (m.shopifyMatch || '').toLowerCase();
            // Only remove if this specific (sku, target) pair was rebound
            return !reboundPairs.has(`${sku}||${t}`);
          });
          const removed = beforeLen - data.mappings.length;
          if (removed > 0) {
            log('MATCH', `Cleaned up ${removed} old dead-SKU entries after rebind`);
            modified += removed;
          }
        }
        // Also backfill slugs for any xt mapping whose sku is live but has no
        // slug stored yet — so the NEXT rotation can recover instantly.
        for (const m of data.mappings) {
          if ((m.source || 'iw') !== 'xt') continue;
          if (m.slug) continue;
          const slug = skuToSlug.get(m.sku || m.iwSku);
          if (slug) {
            m.slug = slug;
            modified++;
          }
        }
        if (modified > 0) {
          const tmp = file + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
          fs.renameSync(tmp, file);
          log('MATCH', `Persisted ${modified} mapping change(s) (rebinds + slug backfill)`);
        }
      } catch (e) {
        log('MATCH', `Could not persist rebinds to manual-mappings.json: ${e.message}`);
      }
    }
  }

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
    // Supports several target shapes:
    //   - Shopify variant SKU or barcode (exact) → variant-specific match
    //   - Shopify product handle (slug) → whole-product match
    //   - Shopify product URL containing /products/{handle} → whole-product match
    //   - Plain title substring → whole-product match
    // Use normalize() (lowercase + strip punctuation + collapse whitespace) so
    // invisible characters and smart punctuation from copy-paste don't break it.
    const titleLower = product.title.toLowerCase();
    const titleNorm = normalize(product.title);
    const productHandle = (product.handle || '').toLowerCase();
    const shopifySkus = product.variants.map(v => v.sku).filter(Boolean);
    const shopifyBarcodes = product.variants.map(v => v.barcode).filter(Boolean);

    // Helper: given a mapping target, return true if it refers to this product
    // by URL or handle.
    const matchesByHandle = (target) => {
      if (!productHandle) return false;
      const t = target.toLowerCase().trim();
      // Full URL: https://.../products/{handle}(?...|#...|/)
      const urlMatch = t.match(/\/products\/([a-z0-9][a-z0-9-]*)/);
      if (urlMatch && urlMatch[1] === productHandle) return true;
      // Bare handle: "usd-shadow-team-white-aggressive-skates"
      if (/^[a-z0-9][a-z0-9-]*$/.test(t) && t === productHandle) return true;
      return false;
    };

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
        if (matchesByHandle(t) || titleNorm.includes(normalize(t))) {
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
      // Compare in a common currency — raw numbers don't work when shop is
      // SGD and competitor is IDR (ratio ~10000x always).
      const shopUsd = toUsdForCheck(shopifyBasePrice, SHOPIFY_BASE_CURRENCY);
      const compUsd = toUsdForCheck(iwMatch.price, iwMatch.currency || 'USD');
      const ratio = compUsd / shopUsd;
      if (ratio > MAX_PRICE_RATIO || ratio < (1 / MAX_PRICE_RATIO)) {
        log('MATCH', `REJECTED: "${product.title}" -> "${iwMatch.name}" (price ratio ${ratio.toFixed(2)}x: ~$${shopUsd.toFixed(0)} vs ~$${compUsd.toFixed(0)})`);
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
        if (matchesByHandle(t) || titleNorm.includes(normalize(t))) {
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
      const shopUsd = toUsdForCheck(shopifyBasePrice, SHOPIFY_BASE_CURRENCY);
      const compUsd = toUsdForCheck(xtMatch.price, xtMatch.currency || 'USD');
      const ratio = compUsd / shopUsd;
      if (ratio > MAX_PRICE_RATIO || ratio < (1 / MAX_PRICE_RATIO)) {
        log('MATCH', `REJECTED: "${product.title}" -> "${xtMatch.name}" (ratio ${ratio.toFixed(2)}x: ~$${shopUsd.toFixed(0)} vs ~$${compUsd.toFixed(0)})`);
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
        if (matchesByHandle(t) || titleNorm.includes(normalize(t))) {
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
