/**
 * IndoSkates.com Scraper (Indonesia)
 *
 * WooCommerce site with server-rendered HTML — no Puppeteer needed.
 * Prices are in IDR directly (no conversion).
 * No shipping, no tax (they're already in Indonesia).
 */
const { httpGet, log, sleep } = require('./utils');

const BASE_URL = 'https://indoskates.com';

// Categories to scrape
const CATEGORIES = [
  'inline-skates',
  'race',
  'accessories',
  'wheels',
  'frames',
  'bearings',
  'helmets',
  'protector',
];

const MAX_PAGES = 20; // Max pagination pages per category

/**
 * Parse IDR price text: "Rp8.250.000" -> 8250000
 * Handles "Rp9.000.000 - Rp7.500.000" (range) by picking the lower/sale price
 */
function parsePrice(text) {
  if (!text) return null;
  // Find all Rp prices
  const matches = text.match(/Rp([\d.]+)/g) || [];
  if (matches.length === 0) return null;
  const prices = matches.map(m => {
    const num = m.replace(/Rp/, '').replace(/\./g, '');
    return parseInt(num, 10);
  }).filter(n => n > 0);
  if (prices.length === 0) return null;
  // If range (e.g. old price + new price), pick the lowest (sale price)
  return Math.min(...prices);
}

/**
 * Extract product cards from a category listing page HTML.
 * Strategy: split the HTML by <li class="product"> boundaries, each segment
 * contains one product card's data (until the next li.product or page bottom).
 */
function extractProductsFromListing(html) {
  const products = [];

  // Find start positions of each product card
  const liRegex = /<li[^>]*class="[^"]*\bproduct\b[^"]*"[^>]*>/g;
  const positions = [];
  let m;
  while ((m = liRegex.exec(html)) !== null) {
    positions.push(m.index);
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : start + 10000;
    const card = html.substring(start, end);

    // Extract product URL
    const urlMatch = card.match(/href="(https:\/\/indoskates\.com\/product\/[^"?]+)/);
    if (!urlMatch) continue;
    const url = urlMatch[1];

    // Extract product name
    const nameMatch = card.match(/class="woocommerce-loop-product__title"[^>]*>([^<]+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

    // Extract price — look for the whole <span class="price">...</span> block
    const priceMatch = card.match(/class="price"[^>]*>([\s\S]{0,2000})/);
    const priceText = priceMatch ? priceMatch[1] : card;
    const price = parsePrice(priceText);
    if (!price) continue;

    const slugMatch = url.match(/\/product\/([^/]+)\/?$/);
    const sku = slugMatch ? slugMatch[1] : url;
    const brand = name.split(' ')[0];

    products.push({
      name,
      sku,
      price,
      brand,
      url,
      source: 'indoskates',
      currency: 'IDR',
    });
  }

  return products;
}

/**
 * Get total product count from "Showing X–Y of Z results"
 */
function extractTotalCount(html) {
  const match = html.match(/of\s+(\d+)\s+results?/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Scrape all products from a single category (with pagination)
 */
async function scrapeCategory(category, brands) {
  const products = [];
  let pageUrl = `${BASE_URL}/product-category/${category}/`;
  let pageNum = 1;
  let total = null;

  for (; pageNum <= MAX_PAGES; pageNum++) {
    const url = pageNum === 1
      ? pageUrl
      : `${BASE_URL}/product-category/${category}/page/${pageNum}/`;

    try {
      let body, status;
      for (let attempt = 1; attempt <= 3; attempt++) {
        ({ body, status } = await httpGet(url));
        if (status === 200) break;
        if (status === 404) { return products; } // End of pagination
        log('IS', `  ${category} page ${pageNum}: attempt ${attempt} got status ${status}`);
        await sleep(1500);
      }
      if (status !== 200) {
        log('IS', `  ${category}: giving up at page ${pageNum} (status ${status})`);
        break;
      }

      if (pageNum === 1) {
        total = extractTotalCount(body);
        log('IS', `${category}: ${total || '?'} total products (body size ${body.length})`);
      }

      const pageProducts = extractProductsFromListing(body);
      if (pageProducts.length === 0) {
        log('IS', `  ${category} page ${pageNum}: 0 products extracted from HTML`);
        break;
      }
      products.push(...pageProducts);

      if (total !== null && products.length >= total) break;

      await sleep(500);
    } catch (e) {
      log('IS', `  Error on ${category} page ${pageNum}: ${e.message}`);
      break;
    }
  }

  return products;
}

/**
 * Scrape all products from IndoSkates
 */
async function scrapeAll(brands) {
  log('IS', '=== Starting IndoSkates scrape ===');
  if (brands) log('IS', `Filtering by brands: ${brands.join(', ')}`);

  const allProducts = [];
  const seen = new Set();

  // Parallel category scraping (limit concurrency)
  const CONCURRENCY = 3;
  const categoryResults = [];

  for (let i = 0; i < CATEGORIES.length; i += CONCURRENCY) {
    const batch = CATEGORIES.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(cat => scrapeCategory(cat, brands)));
    categoryResults.push(...results);
  }

  for (const products of categoryResults) {
    for (const p of products) {
      if (seen.has(p.url)) continue;
      seen.add(p.url);
      allProducts.push(p);
    }
  }

  log('IS', `=== IndoSkates scrape complete: ${allProducts.length} products ===`);
  return allProducts;
}

module.exports = { scrapeAll, extractProductsFromListing, parsePrice };
