/**
 * xtremeinn.com (Tradeinn) Scraper
 * Scrapes product prices for inline skating gear
 *
 * Strategy:
 * - Fetch category listing pages to get product URLs (links are in static HTML)
 * - Fetch each product page to get EUR base price from hidden input
 * - Convert EUR to AUD using current exchange rate
 *
 * Key discovery: product pages have <input type="hidden" id="precio_producto_euros" value="420.85">
 * which gives the base EUR price regardless of geo/cookie. We convert this to AUD.
 */
const { httpGet, log, sleep } = require('./utils');

const BASE_URL = 'https://www.tradeinn.com';

// EUR to AUD exchange rate (update periodically)
// As of April 2026: ~1.83 AUD per EUR
const EUR_TO_AUD = 1.83;

// xtremeinn shipping to AU is advertised as free/included ("No extra charges at delivery")
// so we use 0 for shipping
const XT_SHIPPING_AUD = 0;

// Category pages that have product links in static HTML
const CATEGORY_PAGES = [
  '/xtremeinn/en/skates/11625/f',       // All skates (page 1)
];
const MAX_PAGES = 10; // Paginate up to this many pages per category

/**
 * Extract product URLs from a category/listing page
 */
function extractProductUrls(html) {
  const links = html.match(/href="(\/xtremeinn\/en\/[^"]*\/\d+\/p)"/g) || [];
  const urls = new Set();
  for (const link of links) {
    const match = link.match(/href="([^"]+)"/);
    if (match) urls.add(BASE_URL + match[1]);
  }
  return [...urls];
}

/**
 * Extract product data from a product detail page
 * Returns null if product is unavailable or price not found
 */
function extractProductFromPage(html, url) {
  // Get EUR base price from hidden input
  const eurMatch = html.match(/id="precio_producto_euros"\s*value="([\d.]+)"/);
  if (!eurMatch) return null;

  const eurPrice = parseFloat(eurMatch[1]);
  if (!eurPrice || eurPrice < 1) return null;

  // Convert to AUD
  const audPrice = Math.round(eurPrice * EUR_TO_AUD * 100) / 100;

  // Get product name
  const nameMatch = html.match(/id="nombre_producto"\s*value="([^"]+)"/);
  const name = nameMatch ? nameMatch[1].trim() : '';
  if (!name) return null;

  // Check if product is available
  if (html.includes('this product is no longer available') || html.includes('no longer available')) {
    return null;
  }

  // Get product ID
  const idMatch = html.match(/id="id_producte"\s*value="(\d+)"/);
  const productId = idMatch ? idMatch[1] : '';

  // Get product ID from URL as fallback
  const urlIdMatch = url.match(/\/(\d+)\/p$/);
  const sku = productId || (urlIdMatch ? urlIdMatch[1] : '');

  // Extract brand from product name (first word)
  const brand = name.split(' ')[0];

  // Get local currency price for reference
  const localPriceMatch = html.match(/id="productFinalPrice"\s*value="([\d.]+)"/);
  const localPrice = localPriceMatch ? parseFloat(localPriceMatch[1]) : null;

  return {
    name,
    sku,
    price: audPrice,
    eurPrice,
    localPrice,
    brand,
    url,
    source: 'xtremeinn',
    currency: 'AUD'
  };
}

/**
 * Get all product URLs from category pages with pagination
 */
async function getProductUrls(brands) {
  const allUrls = new Set();

  for (const catPath of CATEGORY_PAGES) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${BASE_URL}${catPath}${page > 1 ? '?pg=' + page : ''}`;
      log('XT', `Fetching category page ${page}: ${catPath}`);

      try {
        let body, status;
        for (let attempt = 1; attempt <= 3; attempt++) {
          ({ body, status } = await httpGet(url));
          if (status === 200 || status === 404) break;
          log('XT', `  Attempt ${attempt}/3 returned ${status}, retrying...`);
          await sleep(2000 * attempt);
        }

        if (status !== 200) break;

        const urls = extractProductUrls(body);
        if (urls.length === 0) {
          log('XT', `  No more products on page ${page}`);
          break;
        }

        // Filter by brand if needed (check URL slug)
        for (const u of urls) {
          if (brands) {
            const slug = u.toLowerCase();
            const matchesBrand = brands.some(b => slug.includes(b.toLowerCase().replace(/\s+/g, '-')));
            if (matchesBrand) allUrls.add(u);
          } else {
            allUrls.add(u);
          }
        }

        log('XT', `  Found ${urls.length} products on page ${page} (${allUrls.size} total)`);
        await sleep(1000);
      } catch (e) {
        log('XT', `  Error fetching page ${page}: ${e.message}`);
        break;
      }
    }
  }

  log('XT', `Total unique product URLs: ${allUrls.size}`);
  return [...allUrls];
}

/**
 * Scrape all products from xtremeinn
 */
async function scrapeAll(brands) {
  log('XT', '=== Starting xtremeinn scrape ===');
  log('XT', `EUR to AUD rate: ${EUR_TO_AUD}`);

  // 1. Get product URLs
  const urls = await getProductUrls(brands);
  log('XT', `Scraping ${urls.length} product pages...`);

  // 2. Scrape each product page for EUR price
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
          // Filter by brand name if specified
          if (brands) {
            const matchesBrand = brands.some(b =>
              product.brand.toLowerCase().includes(b.toLowerCase()) ||
              product.name.toLowerCase().includes(b.toLowerCase())
            );
            if (!matchesBrand) { scraped++; continue; }
          }
          products.push(product);
        } else {
          unavailable++;
        }
      }

      scraped++;
      if (scraped % 25 === 0) {
        log('XT', `Progress: ${scraped}/${urls.length} scraped, ${products.length} valid, ${unavailable} unavailable`);
      }
      await sleep(600);
    } catch (e) {
      failed++;
      if (failed <= 5) log('XT', `Error scraping ${url}: ${e.message}`);
    }
  }

  log('XT', `=== xtremeinn scrape complete: ${products.length} products (${unavailable} unavailable, ${failed} errors) ===`);

  // Return in the format expected by price-match.js
  return { usProducts: [], auProducts: products };
}

module.exports = { scrapeAll, extractProductFromPage, extractProductUrls };
