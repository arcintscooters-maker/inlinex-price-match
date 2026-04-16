/**
 * xtremeinn.com (Tradeinn) Scraper
 *
 * Uses Puppeteer to load brand-specific pages and click "Load more" to get all products.
 * Then plain HTTP to fetch each product page for EUR base price.
 * Converts EUR to AUD.
 *
 * Key: product pages have <input type="hidden" id="precio_producto_euros" value="XXX">
 */
const { httpGet, log, sleep } = require('./utils');

const BASE_URL = 'https://www.tradeinn.com';
const EUR_TO_AUD = 1.83;
const EUR_TO_IDR = 21800; // xtremeinn's effective rate (includes their IDR markup/tax)
const EUR_TO_PHP = 62;    // approx current rate; tweak if xtremeinn's effective rate differs

// Load brand pages from JSON file (editable from dashboard)
const path = require('path');
const brandPagesFile = path.join(__dirname, '..', 'brand-pages.json');
let BRAND_PAGES = {};
try {
  BRAND_PAGES = JSON.parse(require('fs').readFileSync(brandPagesFile, 'utf8')).brands || {};
} catch {
  log('XT', 'brand-pages.json not found, using empty brand list');
}

/**
 * Extract product data from a product detail page (plain HTTP)
 */
function extractProductFromPage(html, url, forMarket) {
  const eurMatch = html.match(/id="precio_producto_euros"\s*value="([\d.]+)"/);
  if (!eurMatch) return null;

  const eurPrice = parseFloat(eurMatch[1]);
  if (!eurPrice || eurPrice < 1) return null;

  // Get the local currency price (USD on GitHub Actions since it runs in US)
  const localPriceMatch = html.match(/id="productFinalPrice"\s*value="([\d.]+)"/);
  const localPrice = localPriceMatch ? parseFloat(localPriceMatch[1]) : null;

  // Convert EUR to the target market currency.
  let price, currency;
  if (forMarket === 'US' && localPrice) {
    price = localPrice;
    currency = 'USD';
  } else if (forMarket === 'ID') {
    price = Math.round(eurPrice * EUR_TO_IDR);
    currency = 'IDR';
  } else if (forMarket === 'PH') {
    price = Math.round(eurPrice * EUR_TO_PHP * 100) / 100;
    currency = 'PHP';
  } else {
    price = Math.round(eurPrice * EUR_TO_AUD * 100) / 100;
    currency = 'AUD';
  }

  const nameMatch = html.match(/id="nombre_producto"\s*value="([^"]+)"/);
  const name = nameMatch ? nameMatch[1].trim() : '';
  if (!name) return null;

  if (html.includes('this product is no longer available')) return null;

  // Use the URL ID as the primary SKU — it comes from the brand-page listing
  // card and is consistent with the fast-path scraper. id_producte sometimes
  // differs (xtremeinn updates it independently) causing fast-path US runs
  // and slow-path ID runs to produce different SKUs for the same product,
  // which breaks manual mappings.
  const urlIdMatch = url.match(/\/(\d+)\/p$/);
  const idMatch = html.match(/id="id_producte"\s*value="(\d+)"/);
  const sku = (urlIdMatch ? urlIdMatch[1] : '') || (idMatch ? idMatch[1] : '');

  // Extract URL slug — the one stable identifier xtremeinn exposes. Numeric
  // IDs rotate every few months but the slug (derived from product name) does
  // not. We store it alongside the SKU so manual mappings survive rotations.
  //
  // Try canonical link first (reliable even when fetched via /-/{sku}/p
  // backfill URL where the URL slug is a literal "-"). Fall back to the URL.
  let slug = '';
  const canonical = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/);
  if (canonical) {
    const m = canonical[1].match(/\/xtremeinn\/en\/([^/]+)\/\d+\/p/);
    if (m && m[1] !== '-') slug = m[1];
  }
  if (!slug) {
    const ogUrl = html.match(/<meta[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/);
    if (ogUrl) {
      const m = ogUrl[1].match(/\/xtremeinn\/en\/([^/]+)\/\d+\/p/);
      if (m && m[1] !== '-') slug = m[1];
    }
  }
  if (!slug) {
    const m = url.match(/\/xtremeinn\/en\/([^/]+)\/\d+\/p/);
    if (m && m[1] !== '-') slug = m[1];
  }

  const brand = name.split(' ')[0];

  return {
    name, sku, slug,
    price, eurPrice,
    brand, url,
    source: 'xtremeinn',
    currency
  };
}

/**
 * Use Puppeteer to load brand pages and extract FULL product data (name + price + URL)
 * directly from the listing cards. Skips the need to fetch individual product pages.
 *
 * Each card on the brand listing page has:
 *   li.product-listing-wrapper_carrousel
 *     a[href*="/NNNN/p"]  (product URL, may have tracking params)
 *     .js-nombre_producto_listado  (product name)
 *     .js-precio_producto          (current price, e.g. "$ 297.99")
 *     .js-precio_producto_anterior (old/RRP price if discounted)
 *
 * Prices are in local currency (USD when running from US IP like Railway).
 * For AU market we still need EUR conversion, so this fast-path is US-only.
 */
async function getListingProducts(brands) {
  let puppeteer;
  try { puppeteer = require('puppeteer'); }
  catch { return []; }

  // Determine which brand pages to scrape
  const pagesToScrape = [];
  const addBrand = (brand, paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    for (const path of list) pagesToScrape.push({ brand, path });
  };
  if (brands) {
    for (const b of brands) {
      const paths = BRAND_PAGES[b];
      if (paths) addBrand(b, paths);
      else log('XT', `No xtremeinn brand page for "${b}" — skipping`);
    }
  } else {
    for (const [brand, paths] of Object.entries(BRAND_PAGES)) addBrand(brand, paths);
  }

  if (pagesToScrape.length === 0) return [];

  log('XT', `[Fast] Extracting listing data for ${pagesToScrape.length} brand(s)`);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const products = [];
  const seen = new Set();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    for (const { brand, path } of pagesToScrape) {
      const brandUrl = `${BASE_URL}${path}`;
      log('XT', `Loading ${brand}: ${path}`);

      try {
        await page.goto(brandUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Click "Load more" button until all products are loaded
        for (let click = 0; click < 30; click++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await sleep(800);
          const hasMore = await page.evaluate(() => {
            const btn = document.querySelector('.btn-cargar-mas');
            if (btn && btn.offsetParent !== null) { btn.scrollIntoView(); btn.click(); return true; }
            return false;
          });
          if (!hasMore) break;
          await sleep(2000);
        }

        // Extract all product data from listing cards
        // Main grid uses .product-listing-wrapper.js-hover-producto (NOT the _carrousel variant which is the featured carousel)
        const cards = await page.evaluate(() => {
          const list = [];
          const cardEls = document.querySelectorAll('li.product-listing-wrapper.js-hover-producto, li.product-listing-wrapper_carrousel');
          for (const card of cardEls) {
            const nameEl = card.querySelector('.js-nombre_producto_listado');
            const priceEl = card.querySelector('.js-precio_producto');
            const oldPriceEl = card.querySelector('.js-precio_producto_anterior');

            // Find product URL
            const links = card.querySelectorAll('a[href*="/p"]');
            let url = '';
            for (const link of links) {
              const match = link.href.match(/\/(\d+)\/p/);
              if (match) { url = link.href; break; }
            }

            const name = nameEl ? nameEl.textContent.trim() : '';
            const priceText = priceEl ? priceEl.textContent.trim() : '';
            const oldPriceText = oldPriceEl ? oldPriceEl.textContent.trim() : '';
            if (!name || !priceText || !url) continue;

            list.push({ name, priceText, oldPriceText, url });
          }
          return list;
        });

        let added = 0;
        for (const c of cards) {
          // Parse price text: "$ 297.99" or "A$ 297.99" or "S$ 297.99"
          const priceMatch = c.priceText.match(/([A-Za-z$€]*)\s*([\d,]+\.?\d*)/);
          if (!priceMatch) continue;
          const sym = priceMatch[1].trim();
          const price = parseFloat(priceMatch[2].replace(/,/g, ''));
          if (!price) continue;

          // Determine currency from symbol — be specific to avoid
          // misidentifying "US$" as SGD (sym.includes('S') is too broad).
          let currency = 'USD';
          if (sym.includes('A$') || sym.includes('AU')) currency = 'AUD';
          else if (sym.includes('S$') || sym.includes('SG')) currency = 'SGD';
          else if (sym.includes('€') || sym.toUpperCase().includes('EUR')) currency = 'EUR';

          // Strip tracking params from URL and extract SKU + stable slug
          const cleanUrl = c.url.split('?')[0];
          const skuMatch = cleanUrl.match(/\/(\d+)\/p$/);
          if (!skuMatch) continue;
          const sku = skuMatch[1];
          const slugMatch = cleanUrl.match(/\/xtremeinn\/en\/([^/]+)\/\d+\/p/);
          const slug = slugMatch ? slugMatch[1] : '';

          if (seen.has(sku)) continue;
          seen.add(sku);

          products.push({
            name: c.name,
            sku, slug,
            price,
            brand: c.name.split(' ')[0],
            url: cleanUrl,
            source: 'xtremeinn',
            currency
          });
          added++;
        }
        log('XT', `  ${brand}: ${added} products extracted`);
      } catch (e) {
        log('XT', `  Error loading ${brand}: ${e.message}`);
      }
    }

    log('XT', `[Fast] Puppeteer total: ${products.length} products`);
  } catch (e) {
    log('XT', `Puppeteer error: ${e.message}`);
  } finally {
    await browser.close();
  }

  return products;
}

/**
 * LEGACY: Use Puppeteer to get product URLs only (used when AU market is needed,
 * since AU requires visiting individual pages for EUR→AUD conversion)
 */
async function getProductUrlsWithPuppeteer(brands) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    log('XT', 'Puppeteer not installed — falling back to static HTML');
    return getProductUrlsStatic(brands);
  }

  // Determine which brand pages to scrape (some brands have multiple pages)
  const pagesToScrape = [];
  const addBrand = (brand, paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    for (const path of list) pagesToScrape.push({ brand, path });
  };

  if (brands) {
    for (const b of brands) {
      const paths = BRAND_PAGES[b];
      if (paths) addBrand(b, paths);
      else log('XT', `No xtremeinn brand page for "${b}" — skipping`);
    }
  } else {
    for (const [brand, paths] of Object.entries(BRAND_PAGES)) {
      addBrand(brand, paths);
    }
  }

  if (pagesToScrape.length === 0) {
    log('XT', 'No brand pages to scrape');
    return [];
  }

  log('XT', `Launching Puppeteer for ${pagesToScrape.length} brand(s): ${pagesToScrape.map(p => p.brand).join(', ')}`);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const allUrls = new Set();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    for (const { brand, path } of pagesToScrape) {
      const brandUrl = `${BASE_URL}${path}`;
      log('XT', `Loading ${brand}: ${path}`);

      try {
        await page.goto(brandUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        const beforeCount = allUrls.size;

        // Click "Load more" button until all products are loaded
        for (let click = 0; click < 30; click++) {
          // Collect product URLs
          const urls = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href*="/p"]'))
              .map(a => a.href)
              .filter(h => h.match(/\/\d+\/p$/));
          });
          for (const u of urls) allUrls.add(u);

          // Scroll down to reveal button, then click it
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await sleep(1000);

          const hasMore = await page.evaluate(() => {
            const btn = document.querySelector('.btn-cargar-mas');
            if (btn && btn.offsetParent !== null) {
              btn.scrollIntoView();
              btn.click();
              return true;
            }
            return false;
          });

          if (!hasMore) break;
          await sleep(2500);
        }

        // Final collection for this brand
        const finalUrls = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a[href*="/p"]'))
            .map(a => a.href)
            .filter(h => h.match(/\/\d+\/p$/));
        });
        for (const u of finalUrls) allUrls.add(u);

        const brandCount = allUrls.size - beforeCount;
        log('XT', `  ${brand}: ${brandCount} products found`);
      } catch (e) {
        log('XT', `  Error loading ${brand}: ${e.message}`);
      }
    }

    log('XT', `Puppeteer total: ${allUrls.size} product URLs`);
  } catch (e) {
    log('XT', `Puppeteer error: ${e.message}`);
  } finally {
    await browser.close();
  }

  return [...allUrls];
}

/**
 * Fallback: static HTML (page 1 only)
 */
async function getProductUrlsStatic(brands) {
  const allUrls = new Set();
  const catUrl = `${BASE_URL}/xtremeinn/en/skates/11625/f`;

  try {
    const { body, status } = await httpGet(catUrl);
    if (status === 200) {
      const links = body.match(/href="(\/xtremeinn\/en\/[^"]*\/\d+\/p)"/g) || [];
      for (const link of links) {
        const match = link.match(/href="([^"]+)"/);
        if (match) allUrls.add(BASE_URL + match[1]);
      }
    }
  } catch (e) {
    log('XT', `Static fallback error: ${e.message}`);
  }

  log('XT', `Static fallback found ${allUrls.size} URLs (page 1 only)`);
  return [...allUrls];
}

/**
 * Scrape all products from xtremeinn
 *
 * Fast path (US only): Extract name/price/URL directly from listing cards.
 *   ~30 seconds for 660 products, no individual page fetches.
 *
 * Slow path (AU or both): Get URLs from listing, then fetch each product page
 *   to read EUR base price and convert to AUD.
 */
/**
 * xtremeinn rotates product IDs off brand listing pages but the product pages
 * themselves keep working. For every xt SKU that's in manual-mappings.json but
 * not in the scrape, fetch its product page directly so the manual mapping can
 * still fire.
 */
async function backfillMappedProducts(scrapedProducts, markets) {
  const { loadJSON } = require('./utils');
  const path = require('path');
  const mappingFile = path.join(__dirname, '..', 'manual-mappings.json');
  const data = loadJSON(mappingFile);
  if (!data || !data.mappings) return { usProducts: [], auProducts: [], idProducts: [], phProducts: [] };

  const mappedXtSkus = new Set(
    data.mappings
      .filter(m => (m.source || 'iw') === 'xt' && m.shopifyMatch !== '__blocked__')
      .map(m => m.sku)
  );
  const scrapedSkus = new Set(scrapedProducts.map(p => p.sku));
  const missing = [...mappedXtSkus].filter(sku => !scrapedSkus.has(sku));
  if (missing.length === 0) return { usProducts: [], auProducts: [], idProducts: [], phProducts: [] };

  log('XT', `Backfilling ${missing.length} mapped xt SKUs not in the listing scrape...`);
  const enableUS = !markets || markets.includes('US');
  const enableAU = !markets || markets.includes('AU');
  const enableID = markets && markets.includes('ID');
  const enablePH = markets && markets.includes('PH');

  const usProducts = [];
  const auProducts = [];
  const idProducts = [];
  const phProducts = [];
  const CONCURRENCY = 10;

  // Build a lookup: sku -> mapping target(s) so we can sanity-check
  // that the backfilled product is actually the same product, not a
  // recycled SKU pointing to a t-shirt or weapons magazine.
  const { normalize, similarity } = require('./utils');
  const skuToTargets = new Map();
  for (const m of data.mappings) {
    if ((m.source || 'iw') !== 'xt') continue;
    if (!skuToTargets.has(m.sku)) skuToTargets.set(m.sku, []);
    const t = m.shopifyMatch || '';
    const handleMatch = t.match(/\/products\/([^?#]+)/);
    skuToTargets.get(m.sku).push(handleMatch ? handleMatch[1].replace(/-/g, ' ') : t);
  }

  let recycled = 0;
  const fetchOne = async (sku) => {
    const url = `${BASE_URL}/xtremeinn/en/-/${sku}/p`;
    try {
      const { body, status } = await httpGet(url);
      if (status !== 200) return;
      const testProduct = extractProductFromPage(body, url, 'US');
      if (!testProduct) return;

      // Sanity check: does the returned product name resemble the mapping target?
      // If xtremeinn recycled this SKU to a completely different product (e.g. a
      // hiking t-shirt), the name will have zero overlap. Reject it.
      const targets = skuToTargets.get(sku) || [];
      const STOP = new Set(['skates','skate','inline','aggressive','adjustable','junior','woman','women','men','kids','adult','usd','powerslide','rollerblade','fr','seba']);
      const strip = s => normalize(s).split(' ').filter(w => w.length >= 2 && !STOP.has(w)).join(' ');
      const nameClean = strip(testProduct.name);
      const bestSim = Math.max(0, ...targets.map(t => similarity(strip(t), nameClean)));
      if (bestSim < 0.25) {
        recycled++;
        if (recycled <= 10) {
          log('XT', `  RECYCLED SKU ${sku}: "${testProduct.name}" ≠ mapping target (sim ${bestSim.toFixed(2)}) — skipping`);
        }
        return;
      }

      if (enableUS) usProducts.push(testProduct);
      if (enableAU) {
        const p = extractProductFromPage(body, url, 'AU');
        if (p) auProducts.push(p);
      }
      if (enableID) {
        const p = extractProductFromPage(body, url, 'ID');
        if (p) idProducts.push(p);
      }
      if (enablePH) {
        const p = extractProductFromPage(body, url, 'PH');
        if (p) phProducts.push(p);
      }
    } catch (e) {
      log('XT', `  backfill ${sku}: ${e.message}`);
    }
  };

  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    await Promise.all(missing.slice(i, i + CONCURRENCY).map(fetchOne));
  }
  if (recycled > 0) log('XT', `Backfill: rejected ${recycled} recycled SKUs (product changed to something unrelated)`);
  log('XT', `Backfill: +${usProducts.length} US, +${auProducts.length} AU, +${idProducts.length} ID, +${phProducts.length} PH`);
  return { usProducts, auProducts, idProducts, phProducts };
}

async function scrapeAll(brands, markets) {
  log('XT', '=== Starting xtremeinn scrape ===');
  const enableUS = !markets || markets.includes('US');
  const enableAU = !markets || markets.includes('AU');
  const enableID = markets && markets.includes('ID');
  const enablePH = markets && markets.includes('PH');

  // FAST PATH: US-only scrape using listing page data (no individual page fetches)
  if (enableUS && !enableAU && !enableID && !enablePH) {
    const listingProducts = await getListingProducts(brands);
    const usProducts = listingProducts.filter(p => p.currency === 'USD' || p.currency === 'SGD' || p.currency === 'AUD');
    // Backfill any manually-mapped xt SKUs that weren't in the listing
    const backfill = await backfillMappedProducts(usProducts, markets);
    usProducts.push(...backfill.usProducts);
    log('XT', `=== xtremeinn fast scrape complete: US:${usProducts.length} ===`);
    return { usProducts, auProducts: [], idProducts: [], phProducts: [] };
  }

  // SLOW PATH: AU/ID/PH or multiple markets — need individual product pages for EUR
  const urls = await getProductUrlsWithPuppeteer(brands);
  log('XT', `Scraping ${urls.length} product pages...`);

  const usProducts = [];
  const auProducts = [];
  const idProducts = [];
  const phProducts = [];
  let scraped = 0;
  let failed = 0;
  let unavailable = 0;

  // Parallel scraping with concurrency limit
  const CONCURRENCY = 10;
  const scrapeOne = async (url) => {
    try {
      let body, status;
      for (let attempt = 1; attempt <= 2; attempt++) {
        ({ body, status } = await httpGet(url));
        if (status === 200) break;
        await sleep(1000);
      }
      if (status === 200) {
        if (enableUS) {
          const usProd = extractProductFromPage(body, url, 'US');
          if (usProd) usProducts.push(usProd);
        }
        if (enableAU) {
          const auProd = extractProductFromPage(body, url, 'AU');
          if (auProd) auProducts.push(auProd);
          else unavailable++;
        }
        if (enableID) {
          const idProd = extractProductFromPage(body, url, 'ID');
          if (idProd) idProducts.push(idProd);
        }
        if (enablePH) {
          const phProd = extractProductFromPage(body, url, 'PH');
          if (phProd) phProducts.push(phProd);
        }
      }
      scraped++;
      if (scraped % 50 === 0) {
        log('XT', `Progress: ${scraped}/${urls.length} scraped, US:${usProducts.length} AU:${auProducts.length} ID:${idProducts.length} PH:${phProducts.length}`);
      }
    } catch (e) {
      failed++;
      if (failed <= 5) log('XT', `Error scraping ${url}: ${e.message}`);
    }
  };

  // Run in parallel batches
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(scrapeOne));
  }

  // Backfill any manually-mapped xt SKUs that weren't returned by the listing scrape
  const allScraped = [...usProducts, ...auProducts, ...idProducts, ...phProducts];
  const backfill = await backfillMappedProducts(allScraped, markets);
  usProducts.push(...backfill.usProducts);
  auProducts.push(...backfill.auProducts);
  idProducts.push(...backfill.idProducts);
  phProducts.push(...(backfill.phProducts || []));

  log('XT', `=== xtremeinn complete: US:${usProducts.length} AU:${auProducts.length} ID:${idProducts.length} PH:${phProducts.length} (${unavailable} unavail, ${failed} errors) ===`);
  return { usProducts, auProducts, idProducts, phProducts };
}

module.exports = { scrapeAll, extractProductFromPage };
