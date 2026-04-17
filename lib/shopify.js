const https = require('https');
const { log, sleep } = require('./utils');

const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'inline-skate.myshopify.com';
const API_VERSION = '2025-04';

// --- REST API ---

function shopifyRest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: SHOPIFY_STORE,
      path: `/admin/api/${API_VERSION}${path}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN
      }
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); }
        catch (e) { reject(new Error(`Shopify parse error: ${data.substring(0, 200)}`)); }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Shopify REST timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// --- GraphQL API ---

function shopifyGraphQL(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const options = {
      hostname: SHOPIFY_STORE,
      path: `/admin/api/${API_VERSION}/graphql.json`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.errors) reject(new Error(`GraphQL: ${JSON.stringify(parsed.errors)}`));
          else resolve(parsed.data);
        } catch (e) {
          reject(new Error(`GraphQL parse error: ${data.substring(0, 300)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('GraphQL timeout')); });
    req.write(body);
    req.end();
  });
}

// --- Products (REST) ---

async function getAllProducts() {
  const products = [];
  let sinceId = 0;
  const fields = 'id,title,vendor,handle,tags,variants,status,product_type';

  for (let page = 0; page < 50; page++) {
    const data = await shopifyRest('GET',
      `/products.json?since_id=${sinceId}&limit=250&status=active&fields=${fields}`);
    if (!data.products || data.products.length === 0) break;
    products.push(...data.products);
    sinceId = data.products[data.products.length - 1].id;
    log('SHOPIFY', `Fetched ${products.length} products...`);
    if (data.products.length < 250) break;
    await sleep(500);
  }

  return products;
}

// --- Price Lists (GraphQL) ---

async function getMarketPriceLists() {
  // Query without markets field (requires read_markets scope which may not be granted)
  // Instead, identify price lists by name/currency convention
  const query = `{
    priceLists(first: 25) {
      nodes {
        id
        name
        currency
        parent {
          adjustment {
            type
            value
          }
        }
      }
    }
  }`;

  const data = await shopifyGraphQL(query);
  const lists = data.priceLists.nodes;

  let usPriceList = null;
  let auPriceList = null;
  let idPriceList = null;
  let phPriceList = null;

  for (const pl of lists) {
    const nameLower = (pl.name || '').toLowerCase();

    if (pl.currency === 'USD' && !usPriceList) {
      usPriceList = { id: pl.id, name: pl.name, currency: pl.currency };
      log('SHOPIFY', `US price list: ${pl.name} (${pl.id}) - ${pl.currency}`);
    }
    if (pl.currency === 'AUD' && !auPriceList) {
      auPriceList = { id: pl.id, name: pl.name, currency: pl.currency };
      log('SHOPIFY', `AU price list: ${pl.name} (${pl.id}) - ${pl.currency}`);
    }
    if (pl.currency === 'IDR' && !idPriceList) {
      idPriceList = { id: pl.id, name: pl.name, currency: pl.currency };
      log('SHOPIFY', `ID price list: ${pl.name} (${pl.id}) - ${pl.currency}`);
    }
    if (pl.currency === 'PHP' && !phPriceList) {
      phPriceList = { id: pl.id, name: pl.name, currency: pl.currency };
      log('SHOPIFY', `PH price list: ${pl.name} (${pl.id}) - ${pl.currency}`);
    }
  }

  if (!usPriceList || !auPriceList || !idPriceList || !phPriceList) {
    log('SHOPIFY', `All price lists found: ${lists.map(pl => `${pl.name} (${pl.currency})`).join(', ')}`);
  }

  return { usPriceList, auPriceList, idPriceList, phPriceList };
}

// --- Get effective contextual prices (fixed + percentage rules) ---
// Returns a map of variantGid -> effective price for the given country.
// This works regardless of whether the catalog uses FIXED or RELATIVE pricing.
async function getContextualPrices(productIds, countryCode) {
  const prices = {};
  const BATCH = 20; // smaller to stay under Shopify's 1000 query cost limit
  for (let i = 0; i < productIds.length; i += BATCH) {
    const batch = productIds.slice(i, i + BATCH);
    const aliases = batch.map((pid, idx) => {
      const pidStr = String(pid);
      const gid = pidStr.startsWith('gid://') ? pidStr : `gid://shopify/Product/${pidStr}`;
      return `p${idx}: product(id: "${gid}") {
        variants(first: 20) {
          nodes {
            id
            contextualPricing(context: { country: ${countryCode} }) {
              price { amount currencyCode }
            }
          }
        }
      }`;
    }).join('\n');

    const query = `{ ${aliases} }`;
    try {
      const data = await shopifyGraphQL(query);
      for (const key of Object.keys(data)) {
        const product = data[key];
        if (!product) continue;
        const variants = product.variants?.nodes || [];
        for (const v of variants) {
          const p = v.contextualPricing?.price;
          if (p?.amount) prices[v.id] = parseFloat(p.amount);
        }
      }
    } catch (e) {
      log('SHOPIFY', `Contextual pricing batch ${i} error: ${e.message.substring(0, 150)}`);
    }
    await sleep(150);
  }
  log('SHOPIFY', `Fetched contextual prices for ${Object.keys(prices).length} variants (${countryCode})`);
  return prices;
}

// --- Get current fixed prices from a price list ---

async function getFixedPrices(priceListId) {
  const prices = {};
  let cursor = null;

  for (let page = 0; page < 100; page++) {
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `{
      priceList(id: "${priceListId}") {
        prices(first: 250, originType: FIXED${afterClause}) {
          edges {
            cursor
            node {
              variant { id }
              price { amount currencyCode }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    }`;

    const data = await shopifyGraphQL(query);
    const edges = data.priceList?.prices?.edges || [];

    for (const edge of edges) {
      const vid = edge.node.variant.id;
      prices[vid] = parseFloat(edge.node.price.amount);
      cursor = edge.cursor;
    }

    if (!data.priceList?.prices?.pageInfo?.hasNextPage) break;
    await sleep(150);
  }

  return prices;
}

// --- Set fixed prices ---

async function setFixedPrices(priceListId, priceInputs) {
  const results = [];

  for (let i = 0; i < priceInputs.length; i += 50) {
    const batch = priceInputs.slice(i, i + 50);
    const mutation = `
      mutation SetFixedPrices($priceListId: ID!, $prices: [PriceListPriceInput!]!) {
        priceListFixedPricesAdd(priceListId: $priceListId, prices: $prices) {
          prices {
            variant { id }
            price { amount currencyCode }
          }
          userErrors { field code message }
        }
      }
    `;

    const data = await shopifyGraphQL(mutation, {
      priceListId,
      prices: batch.map(p => ({
        variantId: p.variantId,
        price: { amount: p.price.toFixed(2), currencyCode: p.currency }
      }))
    });

    const result = data.priceListFixedPricesAdd;
    if (result.userErrors?.length > 0) {
      log('SHOPIFY', `Price errors: ${JSON.stringify(result.userErrors)}`);
    }
    results.push(...(result.prices || []));
    log('SHOPIFY', `Updated prices ${i + 1}-${i + batch.length} of ${priceInputs.length}`);
    await sleep(500);
  }

  return results;
}

// --- Delete fixed prices (reset a price list) ---
// Removes the given variantIds from the price list entirely, causing them
// to fall back to the shop's default pricing for that market.
async function deleteFixedPrices(priceListId, variantIds) {
  const results = [];
  for (let i = 0; i < variantIds.length; i += 100) {
    const batch = variantIds.slice(i, i + 100);
    const mutation = `
      mutation DeleteFixedPrices($priceListId: ID!, $variantIds: [ID!]!) {
        priceListFixedPricesDelete(priceListId: $priceListId, variantIds: $variantIds) {
          deletedFixedPriceVariantIds
          userErrors { field code message }
        }
      }
    `;
    const data = await shopifyGraphQL(mutation, { priceListId, variantIds: batch });
    const result = data.priceListFixedPricesDelete;
    if (result.userErrors?.length > 0) {
      log('SHOPIFY', `Delete errors: ${JSON.stringify(result.userErrors)}`);
    }
    results.push(...(result.deletedFixedPriceVariantIds || []));
    log('SHOPIFY', `Deleted prices ${i + 1}-${i + batch.length} of ${variantIds.length}`);
    await sleep(500);
  }
  return results;
}

module.exports = { getAllProducts, getMarketPriceLists, getFixedPrices, getContextualPrices, setFixedPrices, deleteFixedPrices, shopifyGraphQL };
