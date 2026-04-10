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
        catalog {
          ... on MarketCatalog {
            markets(first: 10) {
              nodes {
                id
                name
                enabled
                regions(first: 20) {
                  nodes {
                    ... on MarketRegionCountry {
                      code
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

  const data = await shopifyGraphQL(query);
  const lists = data.priceLists.nodes;

  let usPriceList = null;
  let auPriceList = null;

  for (const pl of lists) {
    const markets = pl.catalog?.markets?.nodes || [];
    for (const market of markets) {
      const regions = market.regions?.nodes || [];
      const countryCodes = regions.map(r => r.code);

      if (countryCodes.includes('US') && !usPriceList) {
        usPriceList = { id: pl.id, name: pl.name, currency: pl.currency, marketName: market.name };
        log('SHOPIFY', `US price list: ${pl.name} (${pl.id}) - ${pl.currency}`);
      }
      if (countryCodes.includes('AU') && !auPriceList) {
        auPriceList = { id: pl.id, name: pl.name, currency: pl.currency, marketName: market.name };
        log('SHOPIFY', `AU price list: ${pl.name} (${pl.id}) - ${pl.currency}`);
      }
    }
  }

  return { usPriceList, auPriceList };
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
    await sleep(300);
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

module.exports = { getAllProducts, getMarketPriceLists, getFixedPrices, setFixedPrices, shopifyGraphQL };
