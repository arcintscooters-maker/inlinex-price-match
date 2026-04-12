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

// Shopify vendor -> xtremeinn brand page path
const BRAND_PAGES = {
  'Powerslide': '/xtremeinn/en/powerslide/6068/m',
  'Rollerblade': '/xtremeinn/en/rollerblade/4857/m',
  'K2': '/xtremeinn/en/k2/101/m',
  'FR': '/xtremeinn/en/fr-skates/23563/m',
  'Flying Eagle': '/xtremeinn/en/flying-eagle/23562/m',
  'USD': '/xtremeinn/en/usd-skates/6070/m',
  'Chaya': '/xtremeinn/en/chaya/6069/m',
  'Ennui': '/xtremeinn/en/ennui/6071/m',
  'Undercover': '/xtremeinn/en/undercover/6072/m',
  'Kizer': '/xtremeinn/en/kizer/6314/m',
  'Seba': '/xtremeinn/en/seba/6386/m',
  'PlayLife': '/xtremeinn/en/playlife/15809/m',
  'GAWDS': '/xtremeinn/en/gawds/15810/m',
  'Wicked': '/xtremeinn/en/wicked/15811/m',
  'Roces': '/xtremeinn/en/roces/6384/m',
};

/**
 * Extract product data from a product detail page (plain HTTP)
 */
function extractProductFromPage(html, url) {
  const eurMatch = html.match(/id="precio_producto_euros"\s*value="([\d.]+)"/);
  if (!eurMatch) return null;

  const eurPrice = parseFloat(eurMatch[1]);
  if (!eurPrice || eurPrice < 1) return null;

  const audPrice = Math.round(eurPrice * EUR_TO_AUD * 100) / 100;

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
    price: audPrice,
    eurPrice,
    brand, url,
    source: 'xtremeinn',
    currency: 'AUD'
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

  // Determine which brand pages to scrape
  const pagesToScrape = [];
  if (brands) {
    for (const b of brands) {
      const path = BRAND_PAGES[b];
      if (path) pagesToScrape.push({ brand: b, path });
      else log('XT', `No xtremeinn brand page for "${b}" — skipping`);
    }
  } else {
    for (const [brand, path] of Object.entries(BRAND_PAGES)) {
      pagesToScrape.push({ brand, path });
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
async function scrapeAll(brands) {
  log('XT', '=== Starting xtremeinn scrape ===');
  log('XT', `EUR to AUD rate: ${EUR_TO_AUD}`);

  const urls = await getProductUrlsWithPuppeteer(brands);
  log('XT', `Scraping ${urls.length} product pages for EUR prices...`);

  const products = [];
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
        const product = extractProductFromPage(body, url);
        if (product) {
          products.push(product);
        } else {
          unavailable++;
        }
      }

      scraped++;
      if (scraped % 50 === 0) {
        log('XT', `Progress: ${scraped}/${urls.length} scraped, ${products.length} valid`);
      }
      await sleep(500);
    } catch (e) {
      failed++;
      if (failed <= 5) log('XT', `Error scraping ${url}: ${e.message}`);
    }
  }

  log('XT', `=== xtremeinn scrape complete: ${products.length} products (${unavailable} unavailable, ${failed} errors) ===`);
  return { usProducts: [], auProducts: products };
}

module.exports = { scrapeAll, extractProductFromPage };
