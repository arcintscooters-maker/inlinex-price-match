/**
 * Inline Warehouse Scraper
 * Scrapes product prices from inlinewarehouse.com
 *
 * Strategy:
 * 1. Fetch leaf-level category pages to get descpage product links (in static HTML)
 * 2. Fetch each product page to get prices (prices are in static HTML)
 */
const { httpGet, log, sleep } = require('./utils');

const BASE_URL = 'https://www.inlinewarehouse.com';

// Real IW category codes per brand (from sitemap)
const BRAND_CATEGORIES = {
  'Powerslide': [
    'POWERSKATE',    // Powerslide Inline Skates (main)
    'PSRECS',        // Powerslide Recreational
    'PSFITS',        // Powerslide Cross-Training
    'PSSKAMEN',      // Powerslide Fitness Mens
    'PSSKAWOM',      // Powerslide Womens
    'PSKIDSSKA',     // Powerslide Kids
    'PSSUWB',        // Powerslide Urban
    'PSSFWB',        // Powerslide Freestyle
    'PSOFFR',        // Powerslide All-Terrain
    'PSSPEED',       // Powerslide Speed
    'PSUNEXT',       // Powerslide Next Urban
    'PSUIMP',        // Powerslide Imperial Urban
    'PSFRAMES',      // Powerslide Frames
    'PSFTYPE',       // Powerslide Fitness Frames
    'PSFTYPES',      // Powerslide Street Frames
    'PSFTYPES2',     // Powerslide Urban Frames
    'PSFTYPE3',      // Powerslide Speed Frames
    'POWERWH',       // Powerslide Wheels
    'PSWTYPE',       // Powerslide Fitness Wheels
    'PSWTYPES',      // Powerslide Street Wheels
    'PSWRIST',       // Powerslide Wrist Protection
    'PSKNEE',        // Powerslide Knee Pads
    'PSACCESS',      // Powerslide Accessories
  ],
  'USD': [
    'USDSKATE',      // USD Skates (main)
    'USDCS',         // USD Aggressive Skates
    'USDSTYPES1',    // USD Aggressive Skates alt
    'USDWHEEL',      // USD Wheels
    'USDPART',       // USD Parts
  ],
  'Rollerblade': [
    'RBSKATES',      // Rollerblade Inline Skates (main)
    'RBRS',          // Rollerblade Recreational
    'RBXFS',         // Rollerblade Cross-Training
    'SKMRBFIT',      // Rollerblade Mens
    'RBSKATEW',      // Rollerblade Womens
    'RBKIDSSKATE',   // Rollerblade Kids
    'RBURSK',        // Rollerblade Urban
    'RBFSK',         // Rollerblade Freestyle
    'RBMS',          // Rollerblade Marathon
    'RSTRS',         // Rollerblade Blank Aggressive
    'RBFRAMES',      // Rollerblade Frames
    'RBFTYPE',       // Rollerblade Fitness Frames
    'RBFTYPES',      // Rollerblade Street Frames
    'RBFITWHEEL',    // Rollerblade Wheels
    'RBWRIST',       // Rollerblade Wrist Guards
    'RBKNEE',        // Rollerblade Knee Pads
    'RBHELMETA',     // Rollerblade Helmets
  ],
  'FR Skates': [
    'FRSK8S',        // FR Inline Skates (main)
    'FRSK8URBAN',    // FR Urban
    'FRSK8MENS',     // FR Mens
    'FRSK8WOMS',     // FR Womens
    'FRSK8FRESTY',   // FR Freestyle
    'FRSK8TYPE',     // FR Street
    'FRFRAMES',      // FR Frames
    'FRFTYPES2',     // FR Urban Frames
    'FRWHEELS',      // FR Wheels
    'FRSK8PARTS',    // FR Parts
  ],
  'Flying Eagle': [
    'FEINLINESK8',   // Flying Eagle Inline Skates (main)
    'FEMENSSKATE',   // Flying Eagle Mens
    'FEURBANSK8S',   // Flying Eagle Urban
    'FEFRESK8S',     // Flying Eagle Freestyle
    'FEAGGSK8S',     // Flying Eagle Aggressive
    'FEFRAMES',      // Flying Eagle Frames
    'FEWHEELS',      // Flying Eagle Wheels
  ],
  'K2': [
    'K2SKATE',       // K2 Inline Skates (main)
    'K2RS',          // K2 Recreational
    'K2XTS',         // K2 Cross-Training
    'K2MSKATE',      // K2 Mens
    'K2SKATEW',      // K2 Womens
    'K2KIDSKATES',   // K2 Kids
    'K2LS',          // K2 Urban
    'K2MPSKATE',     // K2 Speed
    'K2FRAMES',      // K2 Frames
    'K2WHEEL',       // K2 Wheels
  ],
  'Seba': [
    'SEBASKATES',    // Seba Skates (main)
    'SEBASLALOM',    // Seba Freestyle
  ],
  'Ennui': [
    'IENNUI',        // Ennui Brand page
    'DENNHELM',      // Ennui Helmets
    'ENNKNEE',       // Ennui Knee Pads
    'DENNWRIST',     // Ennui Wrist Guards
    'ENNUIELB',      // Ennui Elbow Pads
  ],
  'Undercover': [
    'UCWHEALL',      // UnderCover Wheels (all)
    'UCWTYPES1',     // UnderCover Aggressive Wheels
    'UCWTYPES2',     // UnderCover Urban Wheels
    'UCWTYPES3',     // UnderCover Freestyle Wheels
    'UCWTYPE1',      // UnderCover Cross-Training Wheels
  ],
  'Kizer': [
    'KIZER',         // Kizer Brand page
    'KIZFTYPES',     // Kizer Street Frames
    'KIZFTYPES1',    // Kizer Aggressive Frames
    'FRKIZER',       // Kizer Frames (alt)
    'KIZERBKL',      // Kizer Buckles
    'KIZATFRAME',    // Kizer All-Terrain Frames
  ],
  'GAWDS': [
    'GAWDSCAT',      // GAWDS Brand page
    'GAWDSSKATES',   // GAWDS Skates
    'GASTYPES1',     // GAWDS Aggressive Skates
    'GAWDSWCAT',     // GAWDS Wheels
    'GAWTYPES1',     // GAWDS Aggressive Wheels
  ],
  'Iqon': [
    'IQONSKATES',    // Iqon Skates
    'IQSTYPES',      // Iqon Aggressive Skates
    'IQONFRAMES',    // Iqon Frames
    'IQFTYPES1',     // Iqon AG Frames
    'IQFTYPES',      // Iqon Urban Frames
    'IQWHEALL',      // Iqon Wheels
  ],
  'Endless': [
    'ENDLSFRAMES',   // Endless Frames
    'END2PTFRAME',   // Endless 2pt Mount Frames
    'ENDTRINFRAM',   // Endless Trinity Frames
    'ENDUFSFRAME',   // Endless UFS Frames
  ],
  'Wicked': [
    'WICKBEAR',      // Wicked Bearings
  ],
  'Reign': [
    'REIGNSKATES',   // Reign Skates
    'REIGNSK2018',   // Reign Urban and Hockey Skates
  ],
  'Chaya': [
    'CHAYASKT',      // Chaya Roller Skates
    'CHAYAOSKT',     // Chaya Outdoor Skates
    'CHAYAMEL',      // Chaya Melrose
    'CHAYAVIN',      // Chaya Vintage
    'CHAYAJUMP',     // Chaya Jump
    'CHAYABLIS',     // Chaya Bliss
    'CHAYABKPK',     // Chaya Backpacks
  ],
  'Micro': [
    // No dedicated IW categories found for Micro
  ],
  'Wizard': [
    'WZDFRAMES',     // Wizard Frames
  ],
  'Matter': [
    'MATTERWH',      // Matter Wheels
    'MATWTYPE3',     // Matter Speed Wheels
  ],
  'MPC': [
    'MPCWHEEL',      // MPC Wheels
    'MPCWTYPE3',     // MPC Speed Wheels
  ],
  'Mesmer': [
    // No dedicated IW categories
  ],
  'Intuition': [
    'INTBOOTIES',    // Intuition Booties
  ],
  'PlayLife': [
    // No dedicated IW categories (Powerslide sub-brand)
  ],
  'Swings': [
    // No dedicated IW categories
  ],
  'Impala': [
    // No dedicated IW categories
  ],
};

// Broader category codes as fallback
const GENERAL_CATEGORIES = [
  'RST', 'CTST', 'UST', 'AGT', 'SKT', 'FSST', 'ALLT',
  'FITJRSKATE', 'FITMSK8', 'IFSGPW',
  'WHFITNESS', 'SKATEBRGS', 'PARTFRAME',
  'FITPGHELMET', 'FITPGWRIST', 'FITPGELBOW', 'FITKNEEPAD',
  'CLRSK8FIT', 'SKATECLST',
];

/**
 * Extract descpage product URLs from a category page's HTML
 */
function extractProductUrls(html) {
  const urls = new Set();
  const regex = /href="([^"]*descpage-[A-Za-z0-9_-]+\.html)"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    let url = match[1];
    if (!url.startsWith('http')) {
      url = url.startsWith('/') ? BASE_URL + url : BASE_URL + '/' + url;
    }
    // Remove anchor fragments
    url = url.split('#')[0];
    urls.add(url);
  }
  return [...urls];
}

/**
 * Extract product data from a product detail page (descpage).
 * Returns an ARRAY of products — one per size/variant if the page has a size selector,
 * or a single-element array if it's a single-variant product.
 */
function extractProductsFromPage(html, url) {
  // Extract SKU from URL
  const skuMatch = url.match(/descpage-([A-Za-z0-9_-]+)\.html/);
  const baseSku = skuMatch ? skuMatch[1] : '';

  // Extract product name from <h1>
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  let baseName = '';
  if (h1Match) {
    baseName = h1Match[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }

  // Extract brand from "Shop All XXX" link
  const brandMatch = html.match(/Shop All ([A-Za-z\s]+)/i);
  const brand = brandMatch ? brandMatch[1].trim() : '';

  // Extract model number from specs
  const modelMatch = html.match(/(?:Model|Part|Item|Mfg)\s*#?\s*:?\s*([A-Z0-9][\w-]+)/i);
  const modelNumber = modelMatch ? modelMatch[1] : '';

  // --- Try to extract per-variant rows ---
  // IW uses <tr> rows in a js-ordering-table. Each row has its own price.
  // Rows can be SIZE variants (68mm, 72mm), MODEL variants (AG60 C, AG60),
  // or pack/hardness variants — all have their own price. Treat them all as
  // distinct products so the manual mapper can target each one.
  const variants = [];
  const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const tr of trs) {
    const priceMatch = tr.match(/js-ordering-price[^>]*>([\d.]+)/);
    if (!priceMatch) continue;

    const price = parseFloat(priceMatch[1]);
    if (!price || price < 1) continue;

    const styleItemCode = tr.match(/data-styleitemcode="([^"]+)"/)?.[1];
    const styleItemName = tr.match(/js-ordering-style-item-name[^>]*>([^<]+)/)?.[1]?.trim();
    const styleAbbrev = tr.match(/data-styleabbrev="([^"]+)"/)?.[1];

    if (!styleItemName) continue;

    const isSize = styleAbbrev === 'SIZE' || /\d+mm/i.test(styleItemName);
    const skuSuffix = styleItemCode || styleItemName.replace(/[^a-z0-9]/gi, '');

    variants.push({
      name: `${baseName} ${styleItemName}`,
      sku: `${baseSku}-${skuSuffix}`,
      price,
      size: isSize ? styleItemName : undefined,
      variantLabel: !isSize ? styleItemName : undefined,
      brand,
      modelNumber,
      url,
      source: 'inline_warehouse',
      currency: 'USD'
    });
  }

  // Dedupe by SKU (same variant can appear in multiple size rows with same price).
  const seenSku = new Set();
  const deduped = [];
  for (const v of variants) {
    if (seenSku.has(v.sku)) continue;
    seenSku.add(v.sku);
    deduped.push(v);
  }

  // Split into true size variants (80mm, 84mm ...) vs model/color variants (Black, AG60 C ...)
  const sizeRows = deduped.filter(v => v.size);
  const nonSizeRows = deduped.filter(v => !v.size);

  let result;
  if (sizeRows.length > 1) {
    const uniqueSizePrices = new Set(sizeRows.map(v => v.price));
    if (uniqueSizePrices.size === 1) {
      // Skates: all sizes at the same price → one entry, strip size
      result = [{
        ...sizeRows[0],
        name: baseName,
        sku: baseSku,
        size: undefined,
      }];
    } else {
      // Wheels: different prices per size → keep per-size so size-aware matcher works
      result = sizeRows;
    }
  } else if (nonSizeRows.length > 1) {
    // Color / model rows — only split if prices actually differ.
    // Otherwise collapse to a single product (e.g. 4 color rows all at $34.97
    // is really one listing, not four).
    const uniquePrices = new Set(nonSizeRows.map(v => v.price));
    if (uniquePrices.size > 1) {
      // Distinct prices → keep one per unique price (e.g. AG60 C at $109 + AG60 at $79.99)
      const seenPrice = new Set();
      result = [];
      for (const v of nonSizeRows) {
        if (seenPrice.has(v.price)) continue;
        seenPrice.add(v.price);
        result.push(v);
      }
    } else {
      // All same price → one product. Use the base name, not "... Black".
      result = [{
        ...nonSizeRows[0],
        name: baseName,
        sku: baseSku,
        variantLabel: undefined,
      }];
    }
  } else {
    result = deduped;
  }

  if (result.length > 1) {
    return result;
  }

  // --- Single variant product (no size selector) ---
  let price = null;

  // Try js-ordering-price first (most reliable)
  const orderPriceMatch = html.match(/class="js-ordering-price[^"]*"[^>]*>([\d.]+)/);
  if (orderPriceMatch) price = parseFloat(orderPriceMatch[1]);

  // Try afterpay-full_price
  if (!price) {
    const afterpayMatch = html.match(/class="afterpay-full_price"[^>]*>([\d.]+)/);
    if (afterpayMatch) price = parseFloat(afterpayMatch[1]);
  }

  // Try sale price pattern
  if (!price) {
    const salePriceMatch = html.match(/class="price is-sale"[\s\S]*?\$([\d.]+)/);
    if (salePriceMatch) price = parseFloat(salePriceMatch[1]);
  }

  if (!price || price < 1) return [];

  return [{
    name: baseName,
    sku: baseSku,
    price,
    brand,
    modelNumber,
    url,
    source: 'inline_warehouse',
    currency: 'USD'
  }];
}

// Backwards compat alias
function extractProductFromPage(html, url) {
  const products = extractProductsFromPage(html, url);
  return products.length > 0 ? products[0] : null;
}

/**
 * Fetch all product URLs from category pages for given brands
 */
async function getProductUrls(brands) {
  const allUrls = new Set();

  // Try brand-specific categories first
  for (const [brand, codes] of Object.entries(BRAND_CATEGORIES)) {
    if (brands && !brands.includes(brand)) continue;

    for (const code of codes) {
      try {
        const url = `${BASE_URL}/catpage-${code}.html`;
        log('IW', `Fetching category: ${code}`);
        let body, status;
        // Retry up to 3 times on server errors
        for (let attempt = 1; attempt <= 3; attempt++) {
          ({ body, status } = await httpGet(url));
          if (status === 200 || status === 404) break;
          log('IW', `  Attempt ${attempt}/3 returned ${status}, retrying...`);
          await sleep(2000 * attempt);
        }
        if (status === 200) {
          const urls = extractProductUrls(body);
          urls.forEach(u => allUrls.add(u));
          if (urls.length > 0) log('IW', `  Found ${urls.length} products in ${code}`);
        }
        await sleep(800);
      } catch (e) {
        log('IW', `  Error fetching ${code}: ${e.message}`);
      }
    }
  }

  // If we got very few results, try general categories
  if (allUrls.size < 20) {
    log('IW', 'Few products found via brand categories, trying general categories...');
    for (const code of GENERAL_CATEGORIES) {
      try {
        const url = `${BASE_URL}/catpage-${code}.html`;
        log('IW', `Fetching general category: ${code}`);
        const { body, status } = await httpGet(url);
        if (status === 200) {
          const urls = extractProductUrls(body);
          urls.forEach(u => allUrls.add(u));
          log('IW', `  Found ${urls.length} products in ${code}`);
        }
        await sleep(800);
      } catch (e) {
        log('IW', `  Error fetching ${code}: ${e.message}`);
      }
    }
  }

  log('IW', `Total unique product URLs: ${allUrls.size}`);
  return [...allUrls];
}

/**
 * Scrape all products from Inline Warehouse
 */
async function scrapeAll(brands) {
  log('IW', '=== Starting Inline Warehouse scrape ===');

  // 1. Get all product URLs
  const urls = await getProductUrls(brands);
  log('IW', `Scraping ${urls.length} product pages...`);

  // 2. Scrape each product page
  const products = [];
  let scraped = 0;
  let failed = 0;

  const CONCURRENCY = 10;
  const scrapeOne = async (url) => {
    try {
      const { body, status } = await httpGet(url);
      if (status === 200) {
        const pageProducts = extractProductsFromPage(body, url);
        for (const product of pageProducts) {
          if (brands && product.brand) {
            const matchesBrand = brands.some(b =>
              product.brand.toLowerCase().includes(b.toLowerCase()) ||
              b.toLowerCase().includes(product.brand.toLowerCase())
            );
            if (!matchesBrand && product.name) {
              const matchesName = brands.some(b =>
                product.name.toLowerCase().includes(b.toLowerCase())
              );
              if (!matchesName) continue;
            }
          }
          products.push(product);
        }
      }
      scraped++;
      if (scraped % 25 === 0) {
        log('IW', `Progress: ${scraped}/${urls.length} scraped, ${products.length} valid`);
      }
    } catch (e) {
      failed++;
      if (failed <= 5) log('IW', `Error scraping ${url}: ${e.message}`);
    }
  };

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(scrapeOne));
  }

  log('IW', `=== IW scrape complete: ${products.length} products scraped (${failed} errors) ===`);
  return products;
}

module.exports = { scrapeAll, extractProductFromPage, extractProductsFromPage, extractProductUrls };
