/**
 * xtremeinn.com (Tradeinn) Scraper
 * Scrapes product prices for inline skating gear
 *
 * Strategy:
 * - Fetch category/search pages with geo set to US and AU
 * - Extract product names and prices from server-rendered HTML
 * - Product links: .js-href_list_products
 * - Prices: .js-precio_producto (e.g. "59.99 US$" or "79.99 A$")
 */
const { httpGet, log, sleep } = require('./utils');

const BASE_URL = 'https://www.tradeinn.com/xtremeinn';

// Category IDs on tradeinn for skating
const CATEGORIES = {
  'inline_skates': '1627',
  'skate_wheels': '1628',
  'skate_accessories': '1629',
  'skate_helmets': '1635',
  'skate_protection': '1636',
};

// Brand search queries
const BRAND_QUERIES = {
  'Powerslide': 'powerslide',
  'USD': 'usd+skates',
  'Rollerblade': 'rollerblade',
  'FR Skates': 'fr+skates',
  'Flying Eagle': 'flying+eagle',
  'K2': 'k2+inline',
  'Seba': 'seba',
  'Ennui': 'ennui',
};

/**
 * Extract products from xtremeinn HTML
 * The HTML has product cards with .js-href_list_products links and .js-precio_producto prices
 */
function extractProducts(html, currency) {
  const products = [];

  // Extract product blocks - each has a link with product info
  // Pattern: <a class="js-href_list_products" href="/xtremeinn/en/product-name/12345/p">
  const productRegex = /<a[^>]*class="js-href_list_products"[^>]*href="([^"]*\/p)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;

  while ((match = productRegex.exec(html)) !== null) {
    const href = match[1];
    const content = match[2];

    // Extract product name from listado-txt__titulo or similar
    const nameMatch = content.match(/class="[^"]*titulo[^"]*"[^>]*>([\s\S]*?)<\//);
    let name = '';
    if (nameMatch) {
      name = nameMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    }

    // Skip if no name (probably the image-only link)
    if (!name || name.length < 3) continue;

    // Extract price
    const priceMatch = content.match(/class="[^"]*js-precio_producto[^"]*"[^>]*>([\d,.]+)\s*([A-Z$]+)/);
    let price = null;
    let priceCurrency = currency;

    if (priceMatch) {
      price = parseFloat(priceMatch[1].replace(',', ''));
      const currSymbol = priceMatch[2];
      if (currSymbol.includes('US')) priceCurrency = 'USD';
      else if (currSymbol.includes('A')) priceCurrency = 'AUD';
      else if (currSymbol.includes('S')) priceCurrency = 'SGD';
      else if (currSymbol.includes('€') || currSymbol.includes('EUR')) priceCurrency = 'EUR';
    }

    if (!price || price < 1) continue;

    // Extract product ID from URL
    const idMatch = href.match(/\/(\d+)\/p$/);
    const productId = idMatch ? idMatch[1] : '';

    // Build full URL
    const fullUrl = href.startsWith('http') ? href : `https://www.tradeinn.com${href}`;

    // Extract brand from product name (first word usually)
    const brandGuess = name.split(' ')[0];

    products.push({
      name,
      sku: productId,
      price,
      brand: brandGuess,
      url: fullUrl,
      source: 'xtremeinn',
      currency: priceCurrency
    });
  }

  return products;
}

/**
 * Fetch a category page with pagination
 */
async function fetchCategoryPage(categoryId, page, country) {
  // Tradeinn uses URL pattern: /xtremeinn/en/category-name/{categoryId}/s
  // With country cookie for geo pricing
  const lang = 'en';
  const url = `${BASE_URL}/${lang}/-/${categoryId}/s?pg=${page}`;

  const headers = {
    'Cookie': `pais_envio=${country}; divisa=${country === 'US' ? 'USD' : 'AUD'}`,
    'Accept-Language': 'en-US,en;q=0.9',
  };

  try {
    const { body, status } = await httpGet(url, headers);
    if (status !== 200) {
      log('XT', `Category ${categoryId} page ${page} returned ${status}`);
      return [];
    }
    return extractProducts(body, country === 'US' ? 'USD' : 'AUD');
  } catch (e) {
    log('XT', `Error fetching category ${categoryId}: ${e.message}`);
    return [];
  }
}

/**
 * Search for products by brand name
 */
async function searchBrand(brandQuery, country) {
  const currency = country === 'US' ? 'USD' : 'AUD';
  const url = `${BASE_URL}/en/search?q=${encodeURIComponent(brandQuery)}`;

  const headers = {
    'Cookie': `pais_envio=${country}; divisa=${currency}`,
    'Accept-Language': 'en-US,en;q=0.9',
  };

  try {
    const { body, status } = await httpGet(url, headers);
    if (status !== 200) {
      log('XT', `Search "${brandQuery}" returned ${status}`);
      return [];
    }
    return extractProducts(body, currency);
  } catch (e) {
    log('XT', `Error searching "${brandQuery}": ${e.message}`);
    return [];
  }
}

/**
 * Scrape all products from xtremeinn for given country
 */
async function scrapeForCountry(brands, country) {
  log('XT', `=== Scraping xtremeinn for ${country} ===`);
  const allProducts = new Map(); // Dedupe by product ID

  // 1. Scrape by brand search
  for (const [brandName, query] of Object.entries(BRAND_QUERIES)) {
    if (brands && !brands.includes(brandName)) continue;

    log('XT', `Searching: ${brandName} (${country})`);
    const products = await searchBrand(query, country);
    for (const p of products) {
      if (!allProducts.has(p.sku)) allProducts.set(p.sku, p);
    }
    log('XT', `  Found ${products.length} products for ${brandName}`);
    await sleep(1500);
  }

  // 2. Also scrape main inline skates category (first 3 pages)
  for (const [catName, catId] of Object.entries(CATEGORIES)) {
    log('XT', `Category: ${catName} (${country})`);
    for (let page = 1; page <= 3; page++) {
      const products = await fetchCategoryPage(catId, page, country);
      for (const p of products) {
        if (!allProducts.has(p.sku)) allProducts.set(p.sku, p);
      }
      if (products.length === 0) break;
      await sleep(1000);
    }
  }

  const results = [...allProducts.values()];
  log('XT', `=== xtremeinn ${country} complete: ${results.length} products ===`);
  return results;
}

/**
 * Main scrape function - gets prices for both US and AU markets
 */
async function scrapeAll(brands) {
  const usProducts = await scrapeForCountry(brands, 'US');
  const auProducts = await scrapeForCountry(brands, 'AU');

  return { usProducts, auProducts };
}

module.exports = { scrapeAll, scrapeForCountry, extractProducts };
