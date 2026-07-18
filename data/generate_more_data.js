import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname);

// Load original tables
const marketRateTable = JSON.parse(readFileSync(join(DATA_DIR, 'market_rate_table.json'), 'utf-8'));
const vendorAwardHistory = JSON.parse(readFileSync(join(DATA_DIR, 'vendor_award_history.json'), 'utf-8'));
const bidderRegistry = JSON.parse(readFileSync(join(DATA_DIR, 'bidder_registry.json'), 'utf-8'));
const tenders = JSON.parse(readFileSync(join(DATA_DIR, 'tender_dataset.json'), 'utf-8'));

const states = [
  { name: 'Karnataka', districts: ['Bengaluru', 'Mysuru', 'Hubballi', 'Mangaluru'] },
  { name: 'Gujarat', districts: ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot'] },
  { name: 'Tamil Nadu', districts: ['Chennai', 'Coimbatore', 'Madurai', 'Trichy'] },
  { name: 'West Bengal', districts: ['Kolkata', 'Howrah', 'Darjeeling', 'Durgapur'] },
  { name: 'Odisha', districts: ['Bhubaneswar', 'Cuttack', 'Rourkela', 'Puri'] }
];

const departments = [
  'Public Works Department',
  'Jal Jeevan Mission',
  'Energy Department',
  'District Administration',
  'Health Department',
  'Education Department',
  'General Administration'
];

const categories = marketRateTable.categories.map(c => c.category);

// Standard mock entities
const mockVendors = [
  'Apex Infra Projects',
  'BlueStar Office Supplies',
  'Cauvery Construction Materials',
  'Delta IT Solutions',
  'Eastern Pharma Hub',
  'Falcon Steel Corp',
  'GreenPower Energy Systems',
  'Hindustan Pipe Distributors',
  'Indo Cement Traders',
  'Jyoti Medical Supplies'
];

// Add vendors to registry & award history if not exists
mockVendors.forEach((vName, idx) => {
  const vId = `V-GEN-${idx + 10}`;
  if (!vendorAwardHistory.vendors.some(v => v.vendor_name === vName)) {
    const totalAwards = 10 + Math.floor(Math.random() * 15);
    const mainDept = departments[Math.floor(Math.random() * departments.length)];
    const primaryAwards = Math.floor(totalAwards * (0.4 + Math.random() * 0.3)); // 40-70% concentration
    const secondaryAwards = totalAwards - primaryAwards;
    const secondDept = departments.filter(d => d !== mainDept)[Math.floor(Math.random() * (departments.length - 1))];

    vendorAwardHistory.vendors.push({
      vendor_id: vId,
      vendor_name: vName,
      total_awards: totalAwards,
      total_value: totalAwards * 5000000,
      awards_by_department: [
        { department: mainDept, awards: primaryAwards, total_value: primaryAwards * 5000000, concentration_ratio: primaryAwards / totalAwards },
        { department: secondDept, awards: secondaryAwards, total_value: secondaryAwards * 5000000, concentration_ratio: secondaryAwards / totalAwards }
      ],
      districts: ['Bengaluru', 'Chennai'],
      state: 'Karnataka',
      flags: []
    });
  }
});

// Generate 50 new tenders
const startId = tenders.length + 1;
for (let i = 0; i < 50; i++) {
  const tenderId = `T-${String(startId + i).padStart(3, '0')}`;
  const category = categories[Math.floor(Math.random() * categories.length)];
  const rateInfo = marketRateTable.categories.find(c => c.category === category);
  
  // Decide price variation (-5% to +40%)
  const isInflated = Math.random() > 0.8; // 20% chance of high price inflation
  const deviation = isInflated ? (rateInfo.acceptable_variance_pct * 2 + Math.floor(Math.random() * 20)) : (Math.floor(Math.random() * 20) - 5);
  const quotedPrice = Math.round(rateInfo.market_rate_per_unit * (1 + deviation / 100));

  const quantity = Math.floor(100 + Math.random() * 4900);
  const tenderValue = quotedPrice * quantity;
  
  const stateObj = states[Math.floor(Math.random() * states.length)];
  const district = stateObj.districts[Math.floor(Math.random() * stateObj.districts.length)];
  const state = stateObj.name;
  
  const bidderCount = Math.floor(1 + Math.random() * 5); // 1 to 5 bidders
  const bidderIds = [];
  
  const winningVendor = mockVendors[Math.floor(Math.random() * mockVendors.length)];

  // Create bidder entries for this tender
  for (let b = 0; b < bidderCount; b++) {
    const bId = `BID-GEN-${startId + i}-${b}`;
    bidderIds.push(bId);

    const bName = b === 0 ? winningVendor : `Co-Bidder ${bId}`;
    if (!bidderRegistry.bidders.some(reg => reg.bidder_id === bId)) {
      // 10% chance of sharing address with winner (collusion) if multiple bidders
      const isColluding = b > 0 && Math.random() > 0.9;
      const winnerBidderId = `BID-GEN-${startId + i}-0`;
      const winnerRec = bidderRegistry.bidders.find(reg => reg.bidder_id === winnerBidderId);

      bidderRegistry.bidders.push({
        bidder_id: bId,
        name: bName,
        registration_number: `${state.substring(0, 2)}/GST/2022/00${startId + i}${b}`,
        address: isColluding && winnerRec ? winnerRec.address : `${10 + b * 5}, Commercial Street, ${district}`,
        pincode: isColluding && winnerRec ? winnerRec.pincode : `${560000 + Math.floor(Math.random() * 999)}`,
        gst_number: `29AABC${startId + i}${b}A1Z9`,
        director_name: isColluding && winnerRec ? winnerRec.director_name : `Director ${bName}`,
        phone: `9900000${startId + i}${b}`
      });
    }
  }

  tenders.push({
    tender_id: tenderId,
    title: `Procurement of ${category} for ${state} development scheme`,
    department: departments[Math.floor(Math.random() * departments.length)],
    category,
    vendor: winningVendor,
    quoted_price: quotedPrice,
    unit: rateInfo.unit,
    quantity,
    bidder_count: bidderCount,
    bidders: bidderIds,
    award_date: `2025-07-${String(Math.floor(1 + Math.random() * 28)).padStart(2, '0')}`,
    district,
    state,
    tender_value: tenderValue
  });
}

// Write everything back
writeFileSync(join(DATA_DIR, 'tender_dataset.json'), JSON.stringify(tenders, null, 2));
writeFileSync(join(DATA_DIR, 'vendor_award_history.json'), JSON.stringify(vendorAwardHistory, null, 2));
writeFileSync(join(DATA_DIR, 'bidder_registry.json'), JSON.stringify(bidderRegistry, null, 2));

console.log(`Generated 50 new tenders. Total dataset now has ${tenders.length} tenders.`);
console.log(`Total bidders in registry: ${bidderRegistry.bidders.length}`);
console.log(`Total vendors in database: ${vendorAwardHistory.vendors.length}`);
