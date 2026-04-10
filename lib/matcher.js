const { normalize, similarity, log } = require('./utils');

const MIN_SIMILARITY = 0.55;

/**
 * Match Shopify products against competitor products.
 * Priority: SKU exact match > barcode match > name similarity
 */
function matchAll(shopifyProducts, iwProducts, xtProducts) {
  const matches = [];

  // Build lookup indexes for competitor products
  const iwBySku = new Map();
  const iwByName = [];
  for (const p of iwProducts) {
    if (p.sku) iwBySku.set(normalize(p.sku), p);
    iwByName.push(p);
  }

  const xtBySku = new Map();
  const xtByName = [];
  for (const p of xtProducts) {
    if (p.sku) xtBySku.set(normalize(p.sku), p);
    xtByName.push(p);
  }

  for (const product of shopifyProducts) {
    for (const variant of product.variants) {
      const skuNorm = normalize(variant.sku || '');
      const barcodeNorm = normalize(variant.barcode || '');
      const fullName = `${product.vendor || ''} ${product.title}`.trim();
      const variantName = variant.title !== 'Default Title'
        ? `${fullName} ${variant.title}`
        : fullName;

      // Try matching against Inline Warehouse
      let iwMatch = null;
      let iwMethod = null;

      // 1. SKU match
      if (skuNorm && iwBySku.has(skuNorm)) {
        iwMatch = iwBySku.get(skuNorm);
        iwMethod = 'sku';
      }

      // 2. Barcode/model number match
      if (!iwMatch && barcodeNorm) {
        for (const p of iwByName) {
          if (p.modelNumber && normalize(p.modelNumber) === barcodeNorm) {
            iwMatch = p;
            iwMethod = 'barcode';
            break;
          }
        }
      }

      // 3. Name similarity
      if (!iwMatch) {
        let bestScore = 0;
        for (const p of iwByName) {
          // Match brand first
          const vendorNorm = normalize(product.vendor || '');
          const compBrandNorm = normalize(p.brand || '');
          if (vendorNorm && compBrandNorm && !compBrandNorm.includes(vendorNorm) && !vendorNorm.includes(compBrandNorm)) {
            continue; // Different brand, skip
          }

          const score = similarity(fullName, p.name);
          if (score > bestScore && score >= MIN_SIMILARITY) {
            bestScore = score;
            iwMatch = p;
            iwMethod = `name(${score.toFixed(2)})`;
          }
        }
      }

      // Try matching against xtremeinn
      let xtMatch = null;
      let xtMethod = null;

      if (skuNorm && xtBySku.has(skuNorm)) {
        xtMatch = xtBySku.get(skuNorm);
        xtMethod = 'sku';
      }

      if (!xtMatch && barcodeNorm) {
        for (const p of xtByName) {
          if (p.sku && normalize(p.sku) === barcodeNorm) {
            xtMatch = p;
            xtMethod = 'barcode';
            break;
          }
        }
      }

      if (!xtMatch) {
        let bestScore = 0;
        for (const p of xtByName) {
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

      if (iwMatch || xtMatch) {
        matches.push({
          shopifyProduct: product,
          shopifyVariant: variant,
          variantGid: `gid://shopify/ProductVariant/${variant.id}`,
          currentPrice: parseFloat(variant.price),
          iwMatch,
          iwMethod,
          xtMatch,
          xtMethod
        });
      }
    }
  }

  log('MATCH', `Matched ${matches.length} variants (IW: ${matches.filter(m => m.iwMatch).length}, XT: ${matches.filter(m => m.xtMatch).length})`);
  return matches;
}

module.exports = { matchAll };
