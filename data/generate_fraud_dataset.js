/**
 * TenderWatch — Targeted Fraud Synthetic Data Generator
 * 
 * Generates 75 additional tenders (total 150) with deliberate, realistic
 * examples covering ALL THREE fraud types:
 * 
 * TYPE 1: PRICE ANOMALY         — Quoted price > 2× acceptable variance
 * TYPE 2: VENDOR CONCENTRATION  — Winning vendor has >85% dept award share
 * TYPE 3: BIDDER RELATIONSHIP   — Competitors share registered address/director
 *
 * Each fraud block has 8–10 tenders. The rest are clean (control group).
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname);

// ── Load existing datasets ────────────────────────────────────────────────
const marketRateTable    = JSON.parse(readFileSync(join(DATA_DIR, 'market_rate_table.json'), 'utf-8'));
const vendorAwardHistory = JSON.parse(readFileSync(join(DATA_DIR, 'vendor_award_history.json'), 'utf-8'));
const bidderRegistry     = JSON.parse(readFileSync(join(DATA_DIR, 'bidder_registry.json'), 'utf-8'));
const tenders            = JSON.parse(readFileSync(join(DATA_DIR, 'tender_dataset.json'), 'utf-8'));

const rateMap = Object.fromEntries(marketRateTable.categories.map(c => [c.category, c]));

let nextId = tenders.length + 1;
const newTenders = [];

// ── Helpers ───────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(3, '0'); }
function randDate() {
  const m = String(Math.floor(1 + Math.random() * 11)).padStart(2, '0');
  const d = String(Math.floor(1 + Math.random() * 27)).padStart(2, '0');
  return `2025-${m}-${d}`;
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function ensureBidder(id, name, address, pincode, director, gst) {
  if (!bidderRegistry.bidders.find(b => b.bidder_id === id)) {
    bidderRegistry.bidders.push({ bidder_id: id, name, registration_number: `REG-${id}`, address, pincode, gst_number: gst, director_name: director, phone: `98${id.replace(/\D/g, '').slice(0,8)}` });
  }
}

function ensureVendor(vendorId, vendorName, dept, concentration) {
  if (!vendorAwardHistory.vendors.find(v => v.vendor_id === vendorId)) {
    const total = 30;
    const deptAwards = Math.round(total * concentration);
    const otherAwards = total - deptAwards;
    vendorAwardHistory.vendors.push({
      vendor_id: vendorId,
      vendor_name: vendorName,
      total_awards: total,
      total_value: total * 8000000,
      awards_by_department: [
        { department: dept, awards: deptAwards, total_value: deptAwards * 8000000, concentration_ratio: parseFloat(concentration.toFixed(2)) },
        { department: 'Other Departments', awards: otherAwards, total_value: otherAwards * 8000000, concentration_ratio: parseFloat((otherAwards / total).toFixed(2)) }
      ],
      districts: ['Lucknow', 'Patna'],
      state: 'Uttar Pradesh',
      flags: concentration >= 0.85 ? ['HIGH_CONCENTRATION'] : []
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// FRAUD TYPE 1 — PRICE ANOMALY (15 tenders)
// Quoted price is 2×–4× above acceptable variance limit
// ═══════════════════════════════════════════════════════════════════

const priceAnomalyBlocks = [
  { category: 'bitumen',          state: 'Uttar Pradesh', district: 'Lucknow',     dept: 'Public Works Department',  inflationFactor: 2.1, bidderCount: 3 },
  { category: 'cement',           state: 'Bihar',         district: 'Patna',        dept: 'Education Department',     inflationFactor: 2.5, bidderCount: 2 },
  { category: 'steel',            state: 'Madhya Pradesh',district: 'Bhopal',       dept: 'Public Works Department',  inflationFactor: 2.8, bidderCount: 4 },
  { category: 'IT hardware',      state: 'Rajasthan',     district: 'Jaipur',       dept: 'General Administration',   inflationFactor: 2.3, bidderCount: 2 },
  { category: 'solar panels',     state: 'Haryana',       district: 'Gurugram',     dept: 'Energy Department',        inflationFactor: 3.0, bidderCount: 1 },
  { category: 'medical supplies', state: 'Punjab',        district: 'Amritsar',     dept: 'Health Department',        inflationFactor: 2.6, bidderCount: 3 },
  { category: 'diesel',           state: 'Uttar Pradesh', district: 'Agra',         dept: 'District Administration',  inflationFactor: 2.2, bidderCount: 2 },
  { category: 'electrical cable', state: 'Jharkhand',     district: 'Ranchi',       dept: 'Energy Department',        inflationFactor: 2.9, bidderCount: 2 },
  { category: 'paint',            state: 'Chhattisgarh',  district: 'Raipur',       dept: 'Public Works Department',  inflationFactor: 2.4, bidderCount: 3 },
  { category: 'gravel',           state: 'Assam',         district: 'Guwahati',     dept: 'Public Works Department',  inflationFactor: 2.7, bidderCount: 4 },
  { category: 'water pipes',      state: 'Himachal Pradesh', district: 'Shimla',   dept: 'Jal Jeevan Mission',       inflationFactor: 2.2, bidderCount: 2 },
  { category: 'furniture',        state: 'Kerala',        district: 'Thiruvananthapuram', dept: 'Education Department', inflationFactor: 2.5, bidderCount: 3 },
  { category: 'stationery',       state: 'Goa',           district: 'Panaji',       dept: 'General Administration',   inflationFactor: 2.3, bidderCount: 2 },
  { category: 'sand',             state: 'Uttarakhand',   district: 'Dehradun',     dept: 'Public Works Department',  inflationFactor: 2.6, bidderCount: 3 },
  { category: 'bricks',           state: 'Telangana',     district: 'Hyderabad',    dept: 'Housing Department',       inflationFactor: 3.1, bidderCount: 1 },
];

priceAnomalyBlocks.forEach((block, i) => {
  const tid = `T-${pad(nextId++)}`;
  const rateInfo = rateMap[block.category];
  const baseRate = rateInfo.market_rate_per_unit;
  const variance = rateInfo.acceptable_variance_pct / 100;
  // Price is at inflationFactor × (1 + variance) × market rate, well beyond threshold
  const quotedPrice = Math.round(baseRate * (1 + variance) * block.inflationFactor);
  const quantity    = 500 + Math.floor(Math.random() * 2000);
  const vendorName  = `InflateCo Supplies ${i + 1} Ltd`;
  const vendorId    = `V-PA-${pad(i + 1)}`;
  const bidderIds   = [];

  // Bidders (no collusion here — the fraud is purely price)
  for (let b = 0; b < block.bidderCount; b++) {
    const bid = `BID-PA-${pad(i+1)}-${b}`;
    bidderIds.push(bid);
    ensureBidder(bid, b === 0 ? vendorName : `Bidder ${b} for ${tid}`,
      `${20 + b}, Main Road, ${block.district}`, `${400000 + i * 10 + b}`,
      `Director-PA-${i}-${b}`, `GST${bid.replace(/\D/g,'').slice(0,10)}`);
  }
  ensureVendor(vendorId, vendorName, block.dept, 0.55); // Normal concentration

  newTenders.push({
    tender_id: tid,
    title: `Supply of ${block.category.replace(/\b\w/g, c => c.toUpperCase())} — ${block.district} Infrastructure Package`,
    department: block.dept,
    category: block.category,
    vendor: vendorName,
    quoted_price: quotedPrice,
    unit: rateInfo.unit,
    quantity,
    bidder_count: block.bidderCount,
    bidders: bidderIds,
    award_date: randDate(),
    district: block.district,
    state: block.state,
    tender_value: quotedPrice * quantity,
    _fraud_type: 'PRICE_ANOMALY' // metadata for audit tracing
  });
});

// ═══════════════════════════════════════════════════════════════════
// FRAUD TYPE 2 — VENDOR CONCENTRATION (15 tenders)
// Single vendor winning >85% of all contracts in one department
// ═══════════════════════════════════════════════════════════════════

// Each of the 5 concentrated vendors captures ~87–95% of dept awards
const concentratedVendors = [
  { id: 'V-VC-001', name: 'Monopoly Road Works Pvt Ltd',   dept: 'Public Works Department',  state: 'Uttar Pradesh', concentration: 0.91 },
  { id: 'V-VC-002', name: 'United Pharma Suppliers Ltd',   dept: 'Health Department',         state: 'Bihar',         concentration: 0.88 },
  { id: 'V-VC-003', name: 'AceTech Digital Solutions',     dept: 'Education Department',      state: 'Rajasthan',     concentration: 0.93 },
  { id: 'V-VC-004', name: 'Srinivasa Infra Corp',          dept: 'Jal Jeevan Mission',        state: 'Andhra Pradesh',concentration: 0.87 },
  { id: 'V-VC-005', name: 'Himalayan Power Systems',       dept: 'Energy Department',         state: 'Himachal Pradesh', concentration: 0.95 },
];

const vcDistricts = {
  'Uttar Pradesh': ['Lucknow', 'Kanpur', 'Varanasi'],
  'Bihar': ['Patna', 'Gaya', 'Bhagalpur'],
  'Rajasthan': ['Jaipur', 'Jodhpur', 'Udaipur'],
  'Andhra Pradesh': ['Visakhapatnam', 'Vijayawada', 'Tirupati'],
  'Himachal Pradesh': ['Shimla', 'Manali', 'Dharamshala']
};

concentratedVendors.forEach(v => ensureVendor(v.id, v.name, v.dept, v.concentration));

const vcCategoryMap = {
  'Public Works Department':  ['bitumen', 'cement', 'steel'],
  'Health Department':        ['medical supplies', 'stationery'],
  'Education Department':     ['IT hardware', 'furniture', 'stationery'],
  'Jal Jeevan Mission':       ['water pipes', 'gravel'],
  'Energy Department':        ['solar panels', 'electrical cable'],
};

concentratedVendors.forEach((cv, ci) => {
  const cats = vcCategoryMap[cv.dept];
  // 3 tenders per vendor = 15 total
  for (let t = 0; t < 3; t++) {
    const tid = `T-${pad(nextId++)}`;
    const category = cats[t % cats.length];
    const rateInfo = rateMap[category];
    const quotedPrice = Math.round(rateInfo.market_rate_per_unit * (1 + Math.random() * 0.08)); // Fair price, fraud is concentration
    const quantity = 300 + Math.floor(Math.random() * 1500);
    const districts = vcDistricts[cv.state];
    const district = districts[t % districts.length];
    const bidderCount = 2 + Math.floor(Math.random() * 2); // 2–3 bidders but always same vendor wins
    const bidderIds = [];

    for (let b = 0; b < bidderCount; b++) {
      const bid = `BID-VC-${pad(ci+1)}-${pad(t)}-${b}`;
      bidderIds.push(bid);
      ensureBidder(bid, b === 0 ? cv.name : `Token Bidder ${bid}`,
        `${100 + t * 10 + b}, Ring Road, ${district}`, `${500000 + ci * 100 + t * 10 + b}`,
        `Director-VC-${ci}`, `GSTVC${bid.replace(/\D/g,'').slice(0,10)}`);
    }

    newTenders.push({
      tender_id: tid,
      title: `${category.replace(/\b\w/g, c => c.toUpperCase())} Procurement — ${cv.dept}, ${district}`,
      department: cv.dept,
      category,
      vendor: cv.name,
      quoted_price: quotedPrice,
      unit: rateInfo.unit,
      quantity,
      bidder_count: bidderCount,
      bidders: bidderIds,
      award_date: randDate(),
      district,
      state: cv.state,
      tender_value: quotedPrice * quantity,
      _fraud_type: 'VENDOR_CONCENTRATION'
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// FRAUD TYPE 3 — BIDDER RELATIONSHIP / BID-RIGGING (15 tenders)
// Competing bidders share the same registered address and/or director
// ═══════════════════════════════════════════════════════════════════

const collusionGroups = [
  // Group A: 3 companies, same address in Lucknow, same director
  {
    groupId: 'CG-A',
    address: '14-B, Hazratganj Commercial Complex, Lucknow, UP',
    pincode: '226001',
    director: 'Ramesh Kumar Srivastava',
    bidders: [
      { id: 'BID-CG-A-001', name: 'Lucknow Infra Builders Pvt Ltd',   gst: 'GSTUPCGA001A1Z2' },
      { id: 'BID-CG-A-002', name: 'Capital City Construction Ltd',     gst: 'GSTUPCGA002A1Z3' },
      { id: 'BID-CG-A-003', name: 'North India Projects Corp',         gst: 'GSTUPCGA003A1Z4' },
    ],
    winner: 0, state: 'Uttar Pradesh', district: 'Lucknow', dept: 'Public Works Department', categories: ['bitumen', 'steel', 'gravel']
  },
  // Group B: 2 companies, same address in Chennai, different directors but same pincode
  {
    groupId: 'CG-B',
    address: '7, Anna Salai, Nungambakkam, Chennai',
    pincode: '600034',
    director: 'Karthik Venkataraman',
    bidders: [
      { id: 'BID-CG-B-001', name: 'Chennai Tech Procurements Ltd',     gst: 'GSTTNCGB001A1Z5' },
      { id: 'BID-CG-B-002', name: 'SouthStar IT Services Pvt Ltd',     gst: 'GSTTNCGB002A1Z6' },
    ],
    winner: 0, state: 'Tamil Nadu', district: 'Chennai', dept: 'Education Department', categories: ['IT hardware', 'furniture', 'stationery']
  },
  // Group C: 3 companies sharing director in Patna
  {
    groupId: 'CG-C',
    address: '22, Fraser Road, Patna, Bihar',
    pincode: '800001',
    director: 'Anil Kumar Mishra',
    bidders: [
      { id: 'BID-CG-C-001', name: 'Bihar General Traders Pvt Ltd',     gst: 'GSTBRCGC001A1Z7' },
      { id: 'BID-CG-C-002', name: 'Patna Procurement Solutions Ltd',   gst: 'GSTBRCGC002A1Z8' },
      { id: 'BID-CG-C-003', name: 'Ganga Infra Services Corp',         gst: 'GSTBRCGC003A1Z9' },
    ],
    winner: 0, state: 'Bihar', district: 'Patna', dept: 'Jal Jeevan Mission', categories: ['water pipes', 'cement', 'sand']
  },
  // Group D: 2 companies, same registered address in Hyderabad
  {
    groupId: 'CG-D',
    address: 'Plot 23, Cyber Towers, Hitech City, Hyderabad',
    pincode: '500081',
    director: 'Suresh Naidu Reddy',
    bidders: [
      { id: 'BID-CG-D-001', name: 'HydroTech Systems Pvt Ltd',         gst: 'GSTTSCGD001A1Z1' },
      { id: 'BID-CG-D-002', name: 'Deccan Energy Solutions Ltd',        gst: 'GSTTSCGD002A1Z2' },
    ],
    winner: 0, state: 'Telangana', district: 'Hyderabad', dept: 'Energy Department', categories: ['solar panels', 'electrical cable', 'diesel']
  },
  // Group E: 3 companies, shared address AND director in Jaipur
  {
    groupId: 'CG-E',
    address: 'B-107, Malviya Nagar Industrial Area, Jaipur',
    pincode: '302017',
    director: 'Vijay Singh Shekhawat',
    bidders: [
      { id: 'BID-CG-E-001', name: 'Rajputana Medical Supplies Pvt Ltd', gst: 'GSTRJCGE001A1Z3' },
      { id: 'BID-CG-E-002', name: 'Desert State Pharma Corp',           gst: 'GSTRJCGE002A1Z4' },
      { id: 'BID-CG-E-003', name: 'Jaipur Healthcare Traders Ltd',      gst: 'GSTRJCGE003A1Z5' },
    ],
    winner: 0, state: 'Rajasthan', district: 'Jaipur', dept: 'Health Department', categories: ['medical supplies', 'stationery', 'furniture']
  },
];

// Register all collusion group members in bidder_registry
collusionGroups.forEach(grp => {
  grp.bidders.forEach(b => {
    ensureBidder(b.id, b.name, grp.address, grp.pincode, grp.director, b.gst);
  });
});

// Generate 3 tenders per collusion group = 15 tenders
collusionGroups.forEach(grp => {
  for (let t = 0; t < 3; t++) {
    const tid = `T-${pad(nextId++)}`;
    const category = grp.categories[t % grp.categories.length];
    const rateInfo = rateMap[category];
    const quotedPrice = Math.round(rateInfo.market_rate_per_unit * (1 + Math.random() * 0.1)); // Fair price
    const quantity    = 200 + Math.floor(Math.random() * 1000);
    const bidderIds   = grp.bidders.map(b => b.id);
    const winnerName  = grp.bidders[grp.winner].name;

    // Register a vendor entry for this winner
    const vendorId = `V-BR-${grp.groupId}-${t}`;
    ensureVendor(vendorId, winnerName, grp.dept, 0.6); // Normal concentration, fraud is bidder overlap

    newTenders.push({
      tender_id: tid,
      title: `${category.replace(/\b\w/g, c => c.toUpperCase())} Procurement — ${grp.dept}, ${grp.district}`,
      department: grp.dept,
      category,
      vendor: winnerName,
      quoted_price: quotedPrice,
      unit: rateInfo.unit,
      quantity,
      bidder_count: grp.bidders.length,
      bidders: bidderIds,
      award_date: randDate(),
      district: grp.district,
      state: grp.state,
      tender_value: quotedPrice * quantity,
      _fraud_type: 'BIDDER_RELATIONSHIP'
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// CLEAN CONTROL GROUP (30 tenders)
// Realistic, genuine tenders with fair pricing and diverse bidders
// ═══════════════════════════════════════════════════════════════════

const cleanStates = [
  { name: 'Maharashtra', districts: ['Mumbai', 'Pune', 'Nagpur', 'Nashik'] },
  { name: 'Karnataka',   districts: ['Bengaluru', 'Mysuru', 'Hubballi'] },
  { name: 'Gujarat',     districts: ['Ahmedabad', 'Surat', 'Rajkot'] },
  { name: 'Tamil Nadu',  districts: ['Coimbatore', 'Madurai', 'Trichy'] },
  { name: 'Kerala',      districts: ['Kochi', 'Kozhikode', 'Thrissur'] },
];

const cleanVendors = [
  'Sunrise Construction Pvt Ltd',   'National Building Materials',
  'ProTech Systems India',          'AquaFlow Pipes Co.',
  'MediCare Distributors Ltd',      'BrightPath Solar Pvt Ltd',
  'GreenBuild Infra',               'Reliable Cement Corp',
  'SafeRoad Bitumen Pvt Ltd',       'EduTech Hardware Solutions',
];

const cleanDepts = [
  'Public Works Department', 'Jal Jeevan Mission', 'Education Department',
  'Health Department', 'Energy Department', 'General Administration'
];

const cleanCategories = Object.keys(rateMap);

for (let i = 0; i < 30; i++) {
  const tid = `T-${pad(nextId++)}`;
  const category = cleanCategories[i % cleanCategories.length];
  const rateInfo = rateMap[category];
  // Fair price: within ±5% of market
  const deviation = (Math.random() * 10) - 5;
  const quotedPrice = Math.round(rateInfo.market_rate_per_unit * (1 + deviation / 100));
  const quantity = 100 + Math.floor(Math.random() * 3000);
  const stateObj = cleanStates[i % cleanStates.length];
  const district = pick(stateObj.districts);
  const dept = cleanDepts[i % cleanDepts.length];
  const vendorName = cleanVendors[i % cleanVendors.length];
  const vendorId = `V-CLEAN-${pad(i+1)}`;
  const bidderCount = 3 + Math.floor(Math.random() * 5); // 3–7 bidders
  const bidderIds = [];

  ensureVendor(vendorId, vendorName, dept, 0.3 + Math.random() * 0.3); // 30-60% concentration

  for (let b = 0; b < bidderCount; b++) {
    const bid = `BID-CLEAN-${pad(i+1)}-${b}`;
    bidderIds.push(bid);
    ensureBidder(
      bid,
      b === 0 ? vendorName : `Clean Bidder ${b} for ${tid}`,
      `${50 + b * 12}, Industrial Estate, Block ${b+1}, ${district}`,
      `${600000 + i * 7 + b}`,
      `Director-CL-${i}-${b}`,
      `GSTCL${bid.replace(/\D/g,'').slice(0,10)}`
    );
  }

  newTenders.push({
    tender_id: tid,
    title: `${category.replace(/\b\w/g, c => c.toUpperCase())} Supply — ${dept} ${stateObj.name}`,
    department: dept,
    category,
    vendor: vendorName,
    quoted_price: quotedPrice,
    unit: rateInfo.unit,
    quantity,
    bidder_count: bidderCount,
    bidders: bidderIds,
    award_date: randDate(),
    district,
    state: stateObj.name,
    tender_value: quotedPrice * quantity,
    _fraud_type: 'CLEAN'
  });
}

// ── Merge and save ─────────────────────────────────────────────────────────
const allTenders = [...tenders, ...newTenders];

writeFileSync(join(DATA_DIR, 'tender_dataset.json'),     JSON.stringify(allTenders, null, 2));
writeFileSync(join(DATA_DIR, 'vendor_award_history.json'), JSON.stringify(vendorAwardHistory, null, 2));
writeFileSync(join(DATA_DIR, 'bidder_registry.json'),    JSON.stringify(bidderRegistry, null, 2));

// ── Report ─────────────────────────────────────────────────────────────────
const byType = {};
newTenders.forEach(t => { byType[t._fraud_type] = (byType[t._fraud_type] || 0) + 1; });

console.log('\n══════════════════════════════════════════════════════');
console.log('   TenderWatch Targeted Fraud Dataset Generator');
console.log('══════════════════════════════════════════════════════');
console.log(`✅ Generated ${newTenders.length} new tenders`);
console.log(`   📊 Total dataset now has: ${allTenders.length} tenders`);
console.log(`   💰 Type 1 — PRICE_ANOMALY:        ${byType['PRICE_ANOMALY']} tenders`);
console.log(`   🏢 Type 2 — VENDOR_CONCENTRATION: ${byType['VENDOR_CONCENTRATION']} tenders`);
console.log(`   🔗 Type 3 — BIDDER_RELATIONSHIP:  ${byType['BIDDER_RELATIONSHIP']} tenders`);
console.log(`   🟢 CLEAN control group:           ${byType['CLEAN']} tenders`);
console.log(`   📁 Bidder registry total: ${bidderRegistry.bidders.length} bidders`);
console.log(`   🏭 Vendor registry total: ${vendorAwardHistory.vendors.length} vendors`);
console.log('══════════════════════════════════════════════════════\n');
