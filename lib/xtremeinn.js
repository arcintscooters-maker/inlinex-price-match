/**
 * xtremeinn.com (Tradeinn) Scraper
 *
 * Uses Puppeteer to browse category pages (JS-rendered product grid)
 * then plain HTTP to fetch each product page for EUR base price.
 * Converts EUR to AUD.
 *
 * Key: product pages have <input type="hidden" id="precio_producto_euros" value="XXX">
 */
const { httpGet, log, sleep } = require('./utils');

const BASE_URL = 'https://www.tradeinn.com';
const EUR_TO_AUD = 1.83;

// Shopify vendor -> xtremeinn URL slug prefix
const BRAND_SLUGS = {
  'Powerslide': ['powerslide', 'myfit'],
  'FR': ['fr-skates', 'fr-'],
  'Rollerblade': ['rollerblade'],
  'Flying Eagle': ['flying-eagle', 'flying'],
  'Undercover': ['undercover'],
  'USD': ['usd-'],
  'Chaya': ['chaya'],
  'Kizer': ['kizer'],
  'K2': ['k2-'],
  'Iqon': ['iqon'],
  'Ennui': ['ennui'],
  'Seba': ['seba-'],
  'Endless': ['endless'],
  'Wicked': ['wicked'],
  'Reign': ['reign'],
  'PlayLife': ['playlife'],
  'GAWDS': ['gawds'],
  'Matter': ['matter'],
  'MPC': ['mpc-'],
  'Micro': ['micro-'],
  'Wizard': ['wizard'],
};

/**
 * Extract product data from a product detail page (plain HTTP — no Puppeteer needed)
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
 * Use Puppeteer to scroll through xtremeinn category pages and collect ALL product URLs.
 * xtremeinn uses infinite scroll — products load as you scroll down.
 */
async function getProductUrlsWithPuppeteer(brands) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    log('XT', 'Puppeteer not installed — falling back to static HTML scraper');
    return getProductUrlsStatic();
  }

  log('XT', 'Launching Puppeteer...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const allUrls = new Set();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Set shipping to Australia for correct pricing display
    await page.setCookie({
      name: 'pais_envio',
      value: 'AU',
      domain: '.tradeinn.com',
      path: '/',
    });

    const categoryUrl = `${BASE_URL}/xtremeinn/en/skates/11625/f`;
    log('XT', `Navigating to ${categoryUrl}`);
    await page.goto(categoryUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Click "View more products" button repeatedly to load all products
    // xtremeinn uses .btn-cargar-mas button, loads ~96 products per click
    for (let click = 0; click < 20; click++) {
      // Collect current product URLs
      const urls = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/p"]');
        return Array.from(links)
          .map(a => a.href)
          .filter(h => h.match(/\/\d+\/p$/));
      });
      for (const u of urls) allUrls.add(u);

      // Try clicking the "View more products" button
      const hasMore = await page.evaluate(() => {
        const btn = document.querySelector('.btn-cargar-mas');
        if (btn && btn.offsetParent !== null) {
          btn.click();
          return true;
        }
        return false;
      });

      log('XT', `Load ${click + 1}: ${allUrls.size} products found`);

      if (!hasMore) {
        log('XT', 'No more "Load more" button — all products loaded');
        break;
      }

      await sleep(3000); // Wait for new products to load
    }

    // Final collection after last click
    const finalUrls = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/p"]');
      return Array.from(links)
        .map(a => a.href)
        .filter(h => h.match(/\/\d+\/p$/));
    });
    for (const u of finalUrls) allUrls.add(u);

    log('XT', `Puppeteer found ${allUrls.size} total product URLs`);
  } catch (e) {
    log('XT', `Puppeteer error: ${e.message}`);
  } finally {
    await browser.close();
  }

  // Filter by brand
  let urls = [...allUrls];
  if (brands) {
    const slugsToMatch = [];
    for (const b of brands) {
      const mapped = BRAND_SLUGS[b];
      if (mapped) slugsToMatch.push(...mapped);
      else slugsToMatch.push(b.toLowerCase().replace(/\s+/g, '-'));
    }
    urls = urls.filter(u => {
      const slug = u.toLowerCase();
      return slugsToMatch.some(s => slug.includes(s));
    });
    log('XT', `Filtered to ${urls.length} URLs matching: ${brands.join(', ')}`);
  }

  return urls;
}

/**
 * Fallback: static HTML scraper (page 1 only, ~96 products)
 */
async function getProductUrlsStatic() {
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

  // 1. Get product URLs via Puppeteer (or static fallback)
  const urls = await getProductUrlsWithPuppeteer(brands);
  log('XT', `Scraping ${urls.length} product pages for EUR prices...`);

  // 2. Scrape each product page via plain HTTP (EUR price is in static HTML)
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

module.exports = { scrapeAll, extractProductFromPage, extractProductUrls: getProductUrlsStatic };
