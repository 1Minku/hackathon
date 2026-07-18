import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');
const OUTPUT_DIR = join(__dirname, '..', 'output');

// ─── Load data files once at startup ───────────────────────────────────────
const marketRateTable = JSON.parse(readFileSync(join(DATA_DIR, 'market_rate_table.json'), 'utf-8'));
const vendorAwardHistory = JSON.parse(readFileSync(join(DATA_DIR, 'vendor_award_history.json'), 'utf-8'));
const bidderRegistry = JSON.parse(readFileSync(join(DATA_DIR, 'bidder_registry.json'), 'utf-8'));
const tenderDataset = JSON.parse(readFileSync(join(DATA_DIR, 'tender_dataset.json'), 'utf-8'));
const employeeRegistry = JSON.parse(readFileSync(join(DATA_DIR, 'employee_registry.json'), 'utf-8'));

// ─── MCP Server setup ──────────────────────────────────────────────────────
const server = new McpServer({
  name: 'tenderwatch',
  version: '2.0.0',
  description: 'TenderWatch MCP Server — procurement anomaly investigation tools'
});

// ──────────────────────────────────────────────────────────────────────────
// TOOL 1: check_price_anomaly
// ──────────────────────────────────────────────────────────────────────────
server.tool(
  'check_price_anomaly',
  'Compare a tender\'s quoted price against the market reference rate for its category. Returns deviation percentage and severity flag.',
  {
    tender_id: z.string().describe('The unique tender identifier (e.g. T-007)'),
    category: z.string().describe('Procurement category (e.g. bitumen, cement, IT hardware)'),
    quoted_price: z.number().describe('The price quoted in the tender per unit'),
    unit: z.string().describe('The unit of measurement (e.g. per metric ton, per bag)'),
    quantity: z.number().describe('Total quantity ordered'),
  },
  async ({ tender_id, category, quoted_price, unit, quantity }) => {
    const categoryLower = category.toLowerCase();
    const entry = marketRateTable.categories.find(
      c => c.category.toLowerCase() === categoryLower ||
           categoryLower.includes(c.category.toLowerCase()) ||
           c.category.toLowerCase().includes(categoryLower)
    );

    if (!entry) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            tender_id,
            status: 'CATEGORY_NOT_FOUND',
            message: `No reference rate found for category: "${category}". Available categories: ${marketRateTable.categories.map(c => c.category).join(', ')}`,
            flag: false
          }, null, 2)
        }]
      };
    }

    const deviation_pct = ((quoted_price - entry.market_rate_per_unit) / entry.market_rate_per_unit) * 100;
    const abs_deviation = Math.abs(deviation_pct);
    const threshold = entry.acceptable_variance_pct;
    const total_tender_value = quoted_price * quantity;
    const total_market_value = entry.market_rate_per_unit * quantity;
    const overpayment = total_tender_value - total_market_value;

    let severity = 'CLEAN';
    let flag = false;
    let severity_reason = '';

    if (deviation_pct > 0) {
      if (abs_deviation <= threshold) {
        severity = 'CLEAN';
        severity_reason = `Quoted price is ${deviation_pct.toFixed(1)}% above market rate, within the acceptable ${threshold}% variance band.`;
      } else if (abs_deviation <= threshold * 2) {
        severity = 'WORTH_NOTING';
        flag = true;
        severity_reason = `Quoted price is ${deviation_pct.toFixed(1)}% above market rate, exceeding the acceptable ${threshold}% band. Warrants review.`;
      } else {
        severity = 'ESCALATE';
        flag = true;
        severity_reason = `Quoted price is ${deviation_pct.toFixed(1)}% above market rate — more than double the acceptable ${threshold}% variance. Significant overpayment of ₹${overpayment.toLocaleString('en-IN')} implied at this quantity.`;
      }
    } else {
      severity = 'CLEAN';
      severity_reason = `Quoted price is ${Math.abs(deviation_pct).toFixed(1)}% below market rate — unusually low, but not a concern for overpayment. May indicate quality compromise.`;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          tender_id,
          category: entry.category,
          quoted_price_per_unit: quoted_price,
          market_rate_per_unit: entry.market_rate_per_unit,
          unit: entry.unit,
          acceptable_variance_pct: threshold,
          deviation_pct: parseFloat(deviation_pct.toFixed(2)),
          quantity,
          total_tender_value,
          total_market_value,
          implied_overpayment: Math.round(overpayment),
          severity,
          flag,
          severity_reason,
          market_source: entry.source,
          market_notes: entry.notes
        }, null, 2)
      }]
    };
  }
);

// ──────────────────────────────────────────────────────────────────────────
// TOOL 2: check_vendor_history
// ──────────────────────────────────────────────────────────────────────────
server.tool(
  'check_vendor_history',
  'Check a vendor\'s historical award concentration in a specific department. High concentration ratios may indicate favouritism or a captured procurement process.',
  {
    vendor_name: z.string().describe('Name of the winning vendor as listed in the tender'),
    department: z.string().describe('The awarding department (e.g. Public Works Department)'),
  },
  async ({ vendor_name, department }) => {
    const vendorLower = vendor_name.toLowerCase();
    const vendor = vendorAwardHistory.vendors.find(
      v => v.vendor_name.toLowerCase() === vendorLower ||
           v.vendor_name.toLowerCase().includes(vendorLower) ||
           vendorLower.includes(v.vendor_name.toLowerCase())
    );

    if (!vendor) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            vendor_name,
            department,
            status: 'VENDOR_NOT_FOUND',
            message: `No award history found for vendor: "${vendor_name}". Vendor may be new to the system.`,
            total_awards: 0,
            concentration_ratio: null,
            flag: false,
            severity: 'CLEAN',
            severity_reason: 'No prior award history found — cannot assess concentration. May be a new or shell vendor.'
          }, null, 2)
        }]
      };
    }

    const deptLower = department.toLowerCase();
    const deptRecord = vendor.awards_by_department.find(
      d => d.department.toLowerCase() === deptLower ||
           d.department.toLowerCase().includes(deptLower) ||
           deptLower.includes(d.department.toLowerCase())
    );

    const dept_awards = deptRecord ? deptRecord.awards : 0;
    const dept_value = deptRecord ? deptRecord.total_value : 0;
    const concentration_ratio = deptRecord ? deptRecord.concentration_ratio : 0;

    let severity = 'CLEAN';
    let flag = false;
    let severity_reason = '';

    if (concentration_ratio >= 0.85) {
      severity = 'ESCALATE';
      flag = true;
      severity_reason = `Vendor has received ${(concentration_ratio * 100).toFixed(0)}% of their total awards (${dept_awards} out of ${vendor.total_awards}) from ${department} alone. This extreme concentration (≥85%) strongly suggests a non-competitive relationship with the department.`;
    } else if (concentration_ratio >= 0.65) {
      severity = 'WORTH_NOTING';
      flag = true;
      severity_reason = `Vendor receives ${(concentration_ratio * 100).toFixed(0)}% of awards from ${department}. This level of concentration (≥65%) warrants scrutiny, especially if combined with other anomalies.`;
    } else {
      severity = 'CLEAN';
      severity_reason = `Vendor has ${(concentration_ratio * 100).toFixed(0)}% concentration in ${department} — within acceptable range for a specialized supplier.`;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          vendor_name: vendor.vendor_name,
          department,
          total_awards_all_depts: vendor.total_awards,
          total_value_all_depts: vendor.total_value,
          awards_to_this_dept: dept_awards,
          value_to_this_dept: dept_value,
          concentration_ratio: parseFloat(concentration_ratio.toFixed(3)),
          concentration_pct: parseFloat((concentration_ratio * 100).toFixed(1)),
          all_dept_breakdown: vendor.awards_by_department,
          existing_flags: vendor.flags,
          severity,
          flag,
          severity_reason
        }, null, 2)
      }]
    };
  }
);

// ──────────────────────────────────────────────────────────────────────────
// TOOL 3: check_bidder_relationship
// ──────────────────────────────────────────────────────────────────────────
server.tool(
  'check_bidder_relationship',
  'Investigate whether bidders on a tender share addresses, PINcodes, GST numbers, or directors — potential indicators of bid-rigging or collusion.',
  {
    bidder_ids: z.array(z.string()).describe('List of bidder IDs from the tender record (e.g. ["BID-1401", "BID-1402"])'),
  },
  async ({ bidder_ids }) => {
    const registryBidders = bidderRegistry.bidders.filter(b => bidder_ids.includes(b.bidder_id));
    const foundIds = registryBidders.map(b => b.bidder_id);
    const notFoundIds = bidder_ids.filter(id => !foundIds.includes(id));

    const suspicious_pairs = [];
    const overlap_summary = {};

    for (let i = 0; i < registryBidders.length; i++) {
      for (let j = i + 1; j < registryBidders.length; j++) {
        const a = registryBidders[i];
        const b = registryBidders[j];
        const overlaps = [];

        if (a.address === b.address) overlaps.push({ type: 'SHARED_ADDRESS', value: a.address });
        if (a.pincode === b.pincode && a.address !== b.address) overlaps.push({ type: 'SHARED_PINCODE', value: a.pincode });
        if (a.director_name === b.director_name) overlaps.push({ type: 'SHARED_DIRECTOR', value: a.director_name });
        if (a.gst_number === b.gst_number) overlaps.push({ type: 'SHARED_GST', value: a.gst_number });
        if (a.phone === b.phone) overlaps.push({ type: 'SHARED_PHONE', value: a.phone });

        if (overlaps.length > 0) {
          suspicious_pairs.push({
            bidder_a: { id: a.bidder_id, name: a.name },
            bidder_b: { id: b.bidder_id, name: b.name },
            overlaps
          });
          overlaps.forEach(o => {
            if (!overlap_summary[o.type]) overlap_summary[o.type] = 0;
            overlap_summary[o.type]++;
          });
        }
      }
    }

    let severity = 'CLEAN';
    let flag = false;
    let severity_reason = '';

    if (suspicious_pairs.length > 0) {
      const hasAddressOverlap = suspicious_pairs.some(p => p.overlaps.some(o => o.type === 'SHARED_ADDRESS'));
      const hasDirectorOverlap = suspicious_pairs.some(p => p.overlaps.some(o => o.type === 'SHARED_DIRECTOR'));

      if (hasAddressOverlap && hasDirectorOverlap) {
        severity = 'ESCALATE';
        flag = true;
        severity_reason = `${suspicious_pairs.length} suspicious bidder pair(s) found sharing both physical address AND director name. This is strong evidence of bid-rigging — these entities are almost certainly controlled by the same party to create a false appearance of competition.`;
      } else if (hasAddressOverlap) {
        severity = 'ESCALATE';
        flag = true;
        severity_reason = `${suspicious_pairs.length} bidder pair(s) share the same registered address. Competing bids from the same address constitute a strong indicator of bid-rigging, potentially invalidating the competitive tender process.`;
      } else if (hasDirectorOverlap) {
        severity = 'ESCALATE';
        flag = true;
        severity_reason = `${suspicious_pairs.length} bidder pair(s) share the same director name. Related-party bids undermine competitive integrity.`;
      } else {
        severity = 'WORTH_NOTING';
        flag = true;
        severity_reason = `${suspicious_pairs.length} bidder pair(s) share the same PIN code. This may be coincidental in commercial districts but warrants cross-referencing.`;
      }
    } else {
      severity = 'CLEAN';
      severity_reason = `No relationship overlaps found among ${registryBidders.length} registered bidders checked. All bidders appear to be independent entities.`;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          bidder_ids_queried: bidder_ids,
          bidders_found_in_registry: foundIds,
          bidders_not_in_registry: notFoundIds,
          total_compared: registryBidders.length,
          suspicious_pairs_count: suspicious_pairs.length,
          suspicious_pairs,
          overlap_summary,
          severity,
          flag,
          severity_reason,
          registered_bidders_detail: registryBidders.map(b => ({
            bidder_id: b.bidder_id,
            name: b.name,
            address: b.address,
            pincode: b.pincode,
            director_name: b.director_name
          }))
        }, null, 2)
      }]
    };
  }
);

// ──────────────────────────────────────────────────────────────────────────
// TOOL 4 (NEW): prioritize_tenders
// Supervisor agent uses this to get a ranked list of tenders by risk score
// before deciding investigation order. Avoids random processing.
// ──────────────────────────────────────────────────────────────────────────
server.tool(
  'prioritize_tenders',
  'Rank all tenders in the dataset by estimated risk score based on quick heuristics (value, bidder count, known vendor flags). Returns a priority queue for the supervisor agent.',
  {
    limit: z.number().optional().describe('Max number of tenders to return (default: all)'),
    min_value: z.number().optional().describe('Only include tenders above this total value (INR)'),
    strategy: z.enum(['risk_first', 'value_first', 'bidder_count_first']).optional().describe('Prioritization strategy (default: risk_first)')
  },
  async ({ limit, min_value, strategy = 'risk_first' }) => {
    const scored = tenderDataset.map(t => {
      let risk_score = 0;
      const signals = [];

      // Risk signal: low bidder count (0-40 pts)
      if (t.bidder_count === 1) { risk_score += 40; signals.push('single_bidder'); }
      else if (t.bidder_count === 2) { risk_score += 25; signals.push('very_low_bidders'); }
      else if (t.bidder_count === 3) { risk_score += 10; signals.push('low_bidders'); }

      // Risk signal: high tender value (0-30 pts)
      if (t.tender_value >= 10000000) { risk_score += 30; signals.push('high_value_crore'); }
      else if (t.tender_value >= 3000000) { risk_score += 15; signals.push('medium_value'); }

      // Risk signal: known flagged vendor (0-30 pts)
      const vendorLower = t.vendor.toLowerCase();
      const vendorRecord = vendorAwardHistory.vendors.find(
        v => vendorLower.includes(v.vendor_name.toLowerCase()) || v.vendor_name.toLowerCase().includes(vendorLower)
      );
      if (vendorRecord?.flags?.length > 0) {
        risk_score += 30;
        signals.push(`vendor_flagged:${vendorRecord.flags.join(',')}`);
      }

      return {
        tender_id: t.tender_id,
        title: t.title,
        department: t.department,
        vendor: t.vendor,
        tender_value: t.tender_value,
        bidder_count: t.bidder_count,
        category: t.category,
        state: t.state,
        risk_score,
        risk_signals: signals,
        priority: risk_score >= 60 ? 'HIGH' : risk_score >= 30 ? 'MEDIUM' : 'LOW'
      };
    });

    let filtered = scored;
    if (min_value) filtered = scored.filter(t => t.tender_value >= min_value);

    let sorted;
    if (strategy === 'value_first') sorted = filtered.sort((a, b) => b.tender_value - a.tender_value);
    else if (strategy === 'bidder_count_first') sorted = filtered.sort((a, b) => a.bidder_count - b.bidder_count);
    else sorted = filtered.sort((a, b) => b.risk_score - a.risk_score); // risk_first default

    const result = limit ? sorted.slice(0, limit) : sorted;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          total_tenders: tenderDataset.length,
          returned: result.length,
          strategy,
          priority_queue: result,
          summary: {
            high_priority: result.filter(t => t.priority === 'HIGH').length,
            medium_priority: result.filter(t => t.priority === 'MEDIUM').length,
            low_priority: result.filter(t => t.priority === 'LOW').length
          }
        }, null, 2)
      }]
    };
  }
);

// ──────────────────────────────────────────────────────────────────────────
// TOOL 5 (NEW): cross_tender_correlation
// Checks if a vendor or bidder appears suspicious across multiple tenders.
// Gives the supervisor cross-tender pattern visibility.
// ──────────────────────────────────────────────────────────────────────────
server.tool(
  'cross_tender_correlation',
  'Identify if a specific vendor or bidder entity appears in multiple tenders across different departments or states — a potential indicator of systematic corruption or cartel behavior.',
  {
    entity_name: z.string().describe('Name of the vendor or company to cross-reference across all tenders'),
    entity_type: z.enum(['vendor', 'bidder']).describe('Whether to search as winning vendor or as a bidder participant')
  },
  async ({ entity_name, entity_type }) => {
    const nameLower = entity_name.toLowerCase();
    const matches = [];

    for (const tender of tenderDataset) {
      if (entity_type === 'vendor') {
        if (tender.vendor.toLowerCase().includes(nameLower) || nameLower.includes(tender.vendor.toLowerCase().split(' ')[0])) {
          matches.push({
            tender_id: tender.tender_id,
            role: 'winning_vendor',
            title: tender.title,
            department: tender.department,
            state: tender.state,
            tender_value: tender.tender_value,
            bidder_count: tender.bidder_count,
            award_date: tender.award_date
          });
        }
      } else {
        // Search bidder names in registry
        const bidderRecs = bidderRegistry.bidders.filter(b =>
          b.name.toLowerCase().includes(nameLower) && tender.bidders.includes(b.bidder_id)
        );
        if (bidderRecs.length > 0) {
          matches.push({
            tender_id: tender.tender_id,
            role: 'bidder_participant',
            bidder_records: bidderRecs.map(b => ({ id: b.bidder_id, name: b.name })),
            title: tender.title,
            department: tender.department,
            state: tender.state,
            tender_value: tender.tender_value,
            award_date: tender.award_date
          });
        }
      }
    }

    // Compute cross-department and cross-state spread
    const departments = [...new Set(matches.map(m => m.department))];
    const states = [...new Set(matches.map(m => m.state))];
    const totalValue = matches.reduce((s, m) => s + m.tender_value, 0);

    let severity = 'CLEAN';
    let flag = false;
    let cross_pattern_summary = '';

    if (matches.length >= 5 && departments.length >= 3) {
      severity = 'ESCALATE';
      flag = true;
      cross_pattern_summary = `Entity "${entity_name}" appears in ${matches.length} tenders across ${departments.length} departments and ${states.length} state(s), representing ₹${totalValue.toLocaleString('en-IN')} total. This breadth of engagement warrants cross-department audit.`;
    } else if (matches.length >= 3) {
      severity = 'WORTH_NOTING';
      flag = true;
      cross_pattern_summary = `Entity "${entity_name}" appears in ${matches.length} tenders across ${departments.length} department(s). Repeated engagement may indicate legitimate market presence or preferential selection.`;
    } else if (matches.length > 0) {
      severity = 'CLEAN';
      cross_pattern_summary = `Entity "${entity_name}" appears in ${matches.length} tender(s). No systematic cross-tender pattern detected.`;
    } else {
      cross_pattern_summary = `Entity "${entity_name}" not found in any tender records.`;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          entity_name,
          entity_type,
          match_count: matches.length,
          total_value_involved: totalValue,
          departments_involved: departments,
          states_involved: states,
          matches,
          severity,
          flag,
          cross_pattern_summary
        }, null, 2)
      }]
    };
  }
);

// ──────────────────────────────────────────────────────────────────────────
// TOOL 6 (NEW): get_investigation_memory
// Allows the supervisor agent to check which tenders have already been
// investigated (from the output results file) to avoid re-investigating.
// ──────────────────────────────────────────────────────────────────────────
server.tool(
  'get_investigation_memory',
  'Retrieve the current state of investigations from the output results file. Returns which tenders have been investigated, their severity, and which remain pending.',
  {
    filter: z.enum(['all', 'pending', 'escalate', 'worth_noting', 'clean']).optional().describe('Filter results by status (default: all)')
  },
  async ({ filter = 'all' }) => {
    const resultsPath = join(OUTPUT_DIR, 'investigation_results.json');

    if (!existsSync(resultsPath)) {
      const pending = tenderDataset.map(t => ({ tender_id: t.tender_id, title: t.title, status: 'pending' }));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            has_prior_results: false,
            message: 'No investigation results file found. All tenders are pending.',
            pending_count: tenderDataset.length,
            investigated_count: 0,
            pending_tenders: pending
          }, null, 2)
        }]
      };
    }

    const data = JSON.parse(readFileSync(resultsPath, 'utf-8'));
    const results = data.results || [];
    const investigatedIds = new Set(results.map(r => r.tender_id));
    const pendingTenders = tenderDataset.filter(t => !investigatedIds.has(t.tender_id));

    const allItems = [
      ...results.map(r => ({ tender_id: r.tender_id, title: r.tender?.title, status: r.severity, investigated_at: data.run_metadata?.run_at })),
      ...pendingTenders.map(t => ({ tender_id: t.tender_id, title: t.title, status: 'pending' }))
    ];

    const filtered = filter === 'all' ? allItems : allItems.filter(i => i.status === filter);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          has_prior_results: true,
          run_at: data.run_metadata?.run_at,
          total_tenders: tenderDataset.length,
          investigated_count: results.length,
          pending_count: pendingTenders.length,
          summary: data.run_metadata?.summary,
          filter_applied: filter,
          items: filtered
        }, null, 2)
      }]
    };
  }
);

// ──────────────────────────────────────────────────────────────────────────
// TOOL 7 (NEW): verify_employee_login
// ──────────────────────────────────────────────────────────────────────────
server.tool(
  'verify_employee_login',
  'Verify employee credentials. Returns success/failure and the profile of the logged-in employee.',
  {
    employee_id: z.string().describe('The Employee ID (e.g. EMP-001)'),
    password: z.string().describe('The plain-text password')
  },
  async ({ employee_id, password }) => {
    const emp = employeeRegistry.employees.find(e => e.id.toUpperCase() === employee_id.trim().toUpperCase() && e.password_hash === password);
    if (emp) {
      const { password_hash, ...profile } = emp;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, profile }, null, 2)
        }]
      };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: false, message: 'Invalid ID or Password' }, null, 2)
      }]
    };
  }
);

// ──────────────────────────────────────────────────────────────────────────
// TOOL 8 (NEW): get_employee_profiles
// ──────────────────────────────────────────────────────────────────────────
server.tool(
  'get_employee_profiles',
  'Retrieve all employee profiles (with password hashes removed for safety).',
  {},
  async () => {
    const profiles = employeeRegistry.employees.map(({ password_hash, ...profile }) => profile);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: true, profiles }, null, 2)
      }]
    };
  }
);

// ─── Resources ─────────────────────────────────────────────────────────────
server.resource('market_rate_table', 'tenderwatch://data/market_rate_table', async () => ({
  contents: [{ uri: 'tenderwatch://data/market_rate_table', mimeType: 'application/json', text: JSON.stringify(marketRateTable, null, 2) }]
}));

server.resource('vendor_award_history', 'tenderwatch://data/vendor_award_history', async () => ({
  contents: [{ uri: 'tenderwatch://data/vendor_award_history', mimeType: 'application/json', text: JSON.stringify(vendorAwardHistory, null, 2) }]
}));

server.resource('bidder_registry', 'tenderwatch://data/bidder_registry', async () => ({
  contents: [{ uri: 'tenderwatch://data/bidder_registry', mimeType: 'application/json', text: JSON.stringify(bidderRegistry, null, 2) }]
}));

server.resource('tender_dataset', 'tenderwatch://data/tender_dataset', async () => ({
  contents: [{ uri: 'tenderwatch://data/tender_dataset', mimeType: 'application/json', text: JSON.stringify(tenderDataset, null, 2) }]
}));

server.resource('employee_registry', 'tenderwatch://data/employee_registry', async () => ({
  contents: [{ uri: 'tenderwatch://data/employee_registry', mimeType: 'application/json', text: JSON.stringify(employeeRegistry, null, 2) }]
}));

// ─── Start server ──────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[TenderWatch MCP Server v2] Running on stdio transport — 8 tools active');
