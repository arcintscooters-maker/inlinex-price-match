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
  let price, currency;
  if (forMarket === 'US' && localPrice) {
    price = localPrice;
    currency = 'USD';
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
 * Use Puppeteer to load brand pages and click "Load more" to get ALL product URLs.
 * Goes directly to /xtremeinn/en/brand-name/ID/m — much faster than scraping all 3000+ products.
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
 */
async function scrapeAll(brands, markets) {
  log('XT', '=== Starting xtremeinn scrape ===');
  const enableUS = !markets || markets.includes('US');
  const enableAU = !markets || markets.includes('AU');

  const urls = await getProductUrlsWithPuppeteer(brands);
  log('XT', `Scraping ${urls.length} product pages...`);

  const usProducts = [];
  const auProducts = [];
  let scraped = 0;
  let failed = 0;
  let unavailable = 0;

  for (const url of urls) {
    try {
      let body, status;
      for (let attempt = 1; attempt <= 2; attempt++) {
        ({ body, status } = await httpGet(url));
        if (status === 200) break;
        await sleep(1500);
      }

      if (status === 200) {
        // Extract for US (uses productFinalPrice in USD from US-based GH Actions)
        if (enableUS) {
          const usProd = extractProductFromPage(body, url, 'US');
          if (usProd) usProducts.push(usProd);
        }
        // Extract for AU (converts EUR to AUD)
        if (enableAU) {
          const auProd = extractProductFromPage(body, url, 'AU');
          if (auProd) auProducts.push(auProd);
          else unavailable++;
        }
        if (!enableAU && !enableUS) unavailable++;
      }

      scraped++;
      if (scraped % 50 === 0) {
        log('XT', `Progress: ${scraped}/${urls.length} scraped, US:${usProducts.length} AU:${auProducts.length}`);
      }
      await sleep(500);
    } catch (e) {
      failed++;
      if (failed <= 5) log('XT', `Error scraping ${url}: ${e.message}`);
    }
  }

  log('XT', `=== xtremeinn complete: US:${usProducts.length} AU:${auProducts.length} (${unavailable} unavail, ${failed} errors) ===`);
  return { usProducts, auProducts };
}

module.exports = { scrapeAll, extractProductFromPage };
