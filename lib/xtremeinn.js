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
const EUR_TO_IDR = 17500; // ~17500 IDR per EUR as of April 2026

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

  // For US market: use the local price (USD from US IP) directly
  // For AU market: convert EUR to AUD
  // For ID market: convert EUR to IDR
  let price, currency;
  if (forMarket === 'US' && localPrice) {
    price = localPrice;
    currency = 'USD';
  } else if (forMarket === 'ID') {
    price = Math.round(eurPrice * EUR_TO_IDR);
    currency = 'IDR';
  } else {
    price = Math.round(eurPrice * EUR_TO_AUD * 100) / 100;
    currency = 'AUD';
  }

  const nameMatch = html.match(/id="nombre_producto"\s*value="([^"]+)"/);
  const name = nameMatch ? nameMatch[1].trim() : '';
  if (!name) return null;

  if (html.includes('this product is no longer available')) return null;

  const idMatch = html.match(/id="id_producte"\s*value="(\d+)"/);
  const urlIdMatch = url.match(/\/(\d+)\/p$/);
  const sku = (idMatch ? idMatch[1] : '') || (urlIdMatch ? urlIdMatch[1] : '');

  const brand = name.split(' ')[0];

  return {
    name, sku,
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

          // Determine currency from symbol
          let currency = 'USD';
          if (sym.includes('A')) currency = 'AUD';
          else if (sym.includes('S')) currency = 'SGD';
          else if (sym.includes('€') || sym.toUpperCase().includes('EUR')) currency = 'EUR';

          // Strip tracking params from URL and extract SKU
          const cleanUrl = c.url.split('?')[0];
          const skuMatch = cleanUrl.match(/\/(\d+)\/p$/);
          if (!skuMatch) continue;
          const sku = skuMatch[1];

          if (seen.has(sku)) continue;
          seen.add(sku);

          products.push({
            name: c.name,
            sku,
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
async function scrapeAll(brands, markets) {
  log('XT', '=== Starting xtremeinn scrape ===');
  const enableUS = !markets || markets.includes('US');
  const enableAU = !markets || markets.includes('AU');
  const enableID = markets && markets.includes('ID');

  // FAST PATH: US-only scrape using listing page data (no individual page fetches)
  if (enableUS && !enableAU && !enableID) {
    const listingProducts = await getListingProducts(brands);
    const usProducts = listingProducts.filter(p => p.currency === 'USD' || p.currency === 'SGD' || p.currency === 'AUD');
    log('XT', `=== xtremeinn fast scrape complete: US:${usProducts.length} ===`);
    return { usProducts, auProducts: [], idProducts: [] };
  }

  // SLOW PATH: AU/ID or multiple markets — need individual product pages for EUR
  const urls = await getProductUrlsWithPuppeteer(brands);
  log('XT', `Scraping ${urls.length} product pages...`);

  const usProducts = [];
  const auProducts = [];
  const idProducts = [];
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
      }
      scraped++;
      if (scraped % 50 === 0) {
        log('XT', `Progress: ${scraped}/${urls.length} scraped, US:${usProducts.length} AU:${auProducts.length} ID:${idProducts.length}`);
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

  log('XT', `=== xtremeinn complete: US:${usProducts.length} AU:${auProducts.length} ID:${idProducts.length} (${unavailable} unavail, ${failed} errors) ===`);
  return { usProducts, auProducts, idProducts };
}

module.exports = { scrapeAll, extractProductFromPage };
