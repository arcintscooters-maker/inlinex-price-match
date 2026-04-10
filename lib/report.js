/**
 * Excel Report Generator
 * Creates a detailed report of all price changes
 */
const ExcelJS = require('exceljs');
const path = require('path');
const { log } = require('./utils');

async function generate(priceChanges, dryRun = false) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Inlinex Price Match';
  workbook.created = new Date();

  // --- Summary Sheet ---
  const summary = workbook.addWorksheet('Summary');
  const timestamp = new Date().toISOString().split('T')[0];

  summary.columns = [
    { header: 'Metric', key: 'metric', width: 35 },
    { header: 'Value', key: 'value', width: 20 },
  ];

  const usChanges = priceChanges.filter(c => c.market === 'US');
  const auChanges = priceChanges.filter(c => c.market === 'AU');
  const totalSavings = priceChanges.reduce((sum, c) => sum + (c.oldPrice - c.newPrice), 0);

  summary.addRows([
    { metric: 'Report Date', value: timestamp },
    { metric: 'Run Type', value: dryRun ? 'DRY RUN' : 'LIVE' },
    { metric: '', value: '' },
    { metric: 'Total Price Changes', value: priceChanges.length },
    { metric: 'US Market Changes', value: usChanges.length },
    { metric: 'AU Market Changes', value: auChanges.length },
    { metric: '', value: '' },
    { metric: 'Avg Price Reduction (%)', value: priceChanges.length > 0
      ? (priceChanges.reduce((s, c) => s + ((c.oldPrice - c.newPrice) / c.oldPrice * 100), 0) / priceChanges.length).toFixed(1) + '%'
      : 'N/A'
    },
    { metric: 'Products Already Cheaper (skipped)', value: priceChanges.filter(c => c.skipped).length },
  ]);

  // Bold header row
  summary.getRow(1).font = { bold: true };

  // --- US Price Changes Sheet ---
  if (usChanges.length > 0) {
    const usSheet = workbook.addWorksheet('US Price Changes');
    addPriceChangeSheet(usSheet, usChanges, 'USD');
  }

  // --- AU Price Changes Sheet ---
  if (auChanges.length > 0) {
    const auSheet = workbook.addWorksheet('AU Price Changes');
    addPriceChangeSheet(auSheet, auChanges, 'AUD');
  }

  // --- All Matches Sheet ---
  const allSheet = workbook.addWorksheet('All Matches');
  addPriceChangeSheet(allSheet, priceChanges, 'Mixed');

  // Save file
  const filename = `price-match-report-${timestamp}${dryRun ? '-DRYRUN' : ''}.xlsx`;
  const filepath = path.join(__dirname, '..', 'reports', filename);

  await workbook.xlsx.writeFile(filepath);
  log('REPORT', `Report saved: ${filepath}`);
  return filepath;
}

function addPriceChangeSheet(sheet, changes, currency) {
  sheet.columns = [
    { header: 'Product', key: 'product', width: 40 },
    { header: 'Variant', key: 'variant', width: 15 },
    { header: 'SKU', key: 'sku', width: 15 },
    { header: 'Brand', key: 'brand', width: 15 },
    { header: 'Market', key: 'market', width: 8 },
    { header: 'Old Price', key: 'oldPrice', width: 12 },
    { header: 'New Price', key: 'newPrice', width: 12 },
    { header: 'Change', key: 'change', width: 12 },
    { header: 'Change %', key: 'changePct', width: 10 },
    { header: 'Competitor', key: 'competitor', width: 18 },
    { header: 'Competitor Price', key: 'compPrice', width: 15 },
    { header: 'Match Method', key: 'matchMethod', width: 15 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Competitor URL', key: 'compUrl', width: 50 },
  ];

  for (const c of changes) {
    const diff = c.oldPrice - c.newPrice;
    const pct = c.oldPrice > 0 ? (diff / c.oldPrice * 100) : 0;

    sheet.addRow({
      product: c.productTitle,
      variant: c.variantTitle,
      sku: c.sku,
      brand: c.brand,
      market: c.market,
      oldPrice: c.oldPrice,
      newPrice: c.newPrice,
      change: -diff,
      changePct: pct.toFixed(1) + '%',
      competitor: c.competitorSource,
      compPrice: c.competitorPrice,
      matchMethod: c.matchMethod,
      status: c.skipped ? 'SKIPPED' : (c.applied ? 'APPLIED' : 'PENDING'),
      compUrl: c.competitorUrl,
    });
  }

  // Style header row
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };

  // Color code price changes
  for (let i = 2; i <= changes.length + 1; i++) {
    const row = sheet.getRow(i);
    const changeVal = row.getCell('change').value;
    if (changeVal < 0) {
      row.getCell('change').font = { color: { argb: 'FF008000' } }; // Green = price decrease
      row.getCell('changePct').font = { color: { argb: 'FF008000' } };
    } else if (changeVal > 0) {
      row.getCell('change').font = { color: { argb: 'FFFF0000' } }; // Red = price increase
      row.getCell('changePct').font = { color: { argb: 'FFFF0000' } };
    }
  }
}

module.exports = { generate };
