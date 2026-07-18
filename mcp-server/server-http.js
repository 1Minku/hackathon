/**
 * TenderWatch MCP Server — Dual Transport Entry Point
 *
 * Supports BOTH:
 *   1. Stdio transport  → used by Claude Desktop (standard MCP)
 *   2. HTTP/SSE transport → used by NitroStudio and HTTP-based MCP clients
 *
 * Usage:
 *   node server-http.js           → starts HTTP on port 3002
 *   node server-http.js --stdio   → starts Stdio mode (for Claude Desktop)
 *   node server-http.js --both    → starts BOTH simultaneously
 *
 * NitroStudio connection URL:  http://localhost:3002/sse
 */

import { McpServer }          from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport }  from '@modelcontextprotocol/sdk/server/sse.js';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { z } from 'zod';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const DATA_DIR   = join(__dirname, '..', 'data');
const OUTPUT_DIR = join(__dirname, '..', 'output');

// ─── Load data files ───────────────────────────────────────────────────────
const marketRateTable    = JSON.parse(readFileSync(join(DATA_DIR, 'market_rate_table.json'), 'utf-8'));
const vendorAwardHistory = JSON.parse(readFileSync(join(DATA_DIR, 'vendor_award_history.json'), 'utf-8'));
const bidderRegistry     = JSON.parse(readFileSync(join(DATA_DIR, 'bidder_registry.json'), 'utf-8'));
const tenderDataset      = JSON.parse(readFileSync(join(DATA_DIR, 'tender_dataset.json'), 'utf-8'));
const employeeRegistry   = JSON.parse(readFileSync(join(DATA_DIR, 'employee_registry.json'), 'utf-8'));

// ─── Build the shared MCP server ──────────────────────────────────────────
function buildServer() {
  const server = new McpServer({
    name:        'tenderwatch',
    version:     '2.1.0',
    description: 'TenderWatch MCP Server — procurement anomaly investigation tools'
  });

  // ── TOOL 1: check_price_anomaly ──────────────────────────────────────────
  server.tool(
    'check_price_anomaly',
    'Compare a tender\'s quoted price against the market reference rate. Returns deviation percentage and severity flag.',
    {
      tender_id:    z.string().describe('Unique tender ID (e.g. T-007)'),
      category:     z.string().describe('Procurement category (e.g. bitumen, cement, IT hardware)'),
      quoted_price: z.number().describe('Price quoted per unit in the tender'),
      unit:         z.string().describe('Unit of measurement'),
      quantity:     z.number().describe('Total quantity ordered'),
    },
    async ({ tender_id, category, quoted_price, unit, quantity }) => {
      const categoryLower = category.toLowerCase();
      const entry = marketRateTable.categories.find(
        c => c.category.toLowerCase() === categoryLower ||
             categoryLower.includes(c.category.toLowerCase()) ||
             c.category.toLowerCase().includes(categoryLower)
      );
      if (!entry) return { content: [{ type: 'text', text: JSON.stringify({ tender_id, status: 'CATEGORY_NOT_FOUND', flag: false }, null, 2) }] };

      const deviation_pct   = ((quoted_price - entry.market_rate_per_unit) / entry.market_rate_per_unit) * 100;
      const abs_dev         = Math.abs(deviation_pct);
      const threshold       = entry.acceptable_variance_pct;
      const total_value     = quoted_price * quantity;
      const market_value    = entry.market_rate_per_unit * quantity;
      const overpayment     = total_value - market_value;

      let severity = 'CLEAN', flag = false, severity_reason = '';
      if (deviation_pct > 0) {
        if      (abs_dev <= threshold)     { severity = 'CLEAN';        severity_reason = `${deviation_pct.toFixed(1)}% above market — within acceptable ${threshold}% band.`; }
        else if (abs_dev <= threshold * 2) { severity = 'WORTH_NOTING'; flag = true; severity_reason = `${deviation_pct.toFixed(1)}% above market — exceeds ${threshold}% band. Warrants review.`; }
        else                               { severity = 'ESCALATE';     flag = true; severity_reason = `${deviation_pct.toFixed(1)}% above market — more than double the ${threshold}% variance. Implied overpayment ₹${overpayment.toLocaleString('en-IN')}.`; }
      } else {
        severity_reason = `${Math.abs(deviation_pct).toFixed(1)}% below market rate. Not an overpayment concern.`;
      }

      return { content: [{ type: 'text', text: JSON.stringify({ tender_id, category: entry.category, quoted_price_per_unit: quoted_price, market_rate_per_unit: entry.market_rate_per_unit, unit: entry.unit, acceptable_variance_pct: threshold, deviation_pct: parseFloat(deviation_pct.toFixed(2)), quantity, total_tender_value: total_value, total_market_value: market_value, implied_overpayment: Math.round(overpayment), severity, flag, severity_reason, market_source: entry.source, market_notes: entry.notes }, null, 2) }] };
    }
  );

  // ── TOOL 2: check_vendor_history ─────────────────────────────────────────
  server.tool(
    'check_vendor_history',
    'Check a vendor\'s historical award concentration in a specific department. High concentration ratios may indicate favouritism.',
    { vendor_name: z.string(), department: z.string() },
    async ({ vendor_name, department }) => {
      const v = vendorAwardHistory.vendors.find(x => x.vendor_name.toLowerCase().includes(vendor_name.toLowerCase()) || vendor_name.toLowerCase().includes(x.vendor_name.toLowerCase()));
      if (!v) return { content: [{ type: 'text', text: JSON.stringify({ vendor_name, department, status: 'VENDOR_NOT_FOUND', flag: false, severity: 'CLEAN' }, null, 2) }] };

      const deptRec          = v.awards_by_department.find(d => d.department.toLowerCase().includes(department.toLowerCase()) || department.toLowerCase().includes(d.department.toLowerCase()));
      const concentration    = deptRec ? deptRec.concentration_ratio : 0;
      const dept_awards      = deptRec ? deptRec.awards : 0;
      const dept_value       = deptRec ? deptRec.total_value : 0;

      let severity = 'CLEAN', flag = false, severity_reason = '';
      if      (concentration >= 0.85) { severity = 'ESCALATE';     flag = true; severity_reason = `${(concentration*100).toFixed(0)}% concentration in ${department} (${dept_awards}/${v.total_awards} awards). Extreme non-competitive relationship.`; }
      else if (concentration >= 0.65) { severity = 'WORTH_NOTING'; flag = true; severity_reason = `${(concentration*100).toFixed(0)}% concentration in ${department}. Warrants scrutiny.`; }
      else                            { severity_reason = `${(concentration*100).toFixed(0)}% concentration — within acceptable range.`; }

      return { content: [{ type: 'text', text: JSON.stringify({ vendor_name: v.vendor_name, department, total_awards_all_depts: v.total_awards, total_value_all_depts: v.total_value, awards_to_this_dept: dept_awards, value_to_this_dept: dept_value, concentration_ratio: parseFloat(concentration.toFixed(3)), concentration_pct: parseFloat((concentration * 100).toFixed(1)), all_dept_breakdown: v.awards_by_department, existing_flags: v.flags, severity, flag, severity_reason }, null, 2) }] };
    }
  );

  // ── TOOL 3: check_bidder_relationship ────────────────────────────────────
  server.tool(
    'check_bidder_relationship',
    'Check whether competing bidders share addresses, directors, or GST numbers — indicators of bid-rigging.',
    { bidder_ids: z.array(z.string()) },
    async ({ bidder_ids }) => {
      const found   = bidderRegistry.bidders.filter(b => bidder_ids.includes(b.bidder_id));
      const missing = bidder_ids.filter(id => !found.find(b => b.bidder_id === id));
      const pairs   = [];

      for (let i = 0; i < found.length; i++) {
        for (let j = i + 1; j < found.length; j++) {
          const a = found[i], b = found[j];
          const overlaps = [];
          if (a.address      === b.address)                          overlaps.push({ type: 'SHARED_ADDRESS',  value: a.address });
          if (a.pincode      === b.pincode && a.address !== b.address) overlaps.push({ type: 'SHARED_PINCODE',  value: a.pincode });
          if (a.director_name === b.director_name)                   overlaps.push({ type: 'SHARED_DIRECTOR', value: a.director_name });
          if (a.gst_number   === b.gst_number)                       overlaps.push({ type: 'SHARED_GST',      value: a.gst_number });
          if (overlaps.length > 0) pairs.push({ bidder_a: { id: a.bidder_id, name: a.name }, bidder_b: { id: b.bidder_id, name: b.name }, overlaps });
        }
      }

      const hasAddr = pairs.some(p => p.overlaps.some(o => o.type === 'SHARED_ADDRESS'));
      const hasDir  = pairs.some(p => p.overlaps.some(o => o.type === 'SHARED_DIRECTOR'));
      let severity = 'CLEAN', flag = false, severity_reason = '';
      if      (pairs.length > 0 && hasAddr && hasDir) { severity = 'ESCALATE';     flag = true; severity_reason = `${pairs.length} pair(s) share both address AND director — almost certainly controlled by same party.`; }
      else if (pairs.length > 0 && hasAddr)            { severity = 'ESCALATE';     flag = true; severity_reason = `${pairs.length} pair(s) share registered address — strong indicator of bid-rigging.`; }
      else if (pairs.length > 0 && hasDir)             { severity = 'ESCALATE';     flag = true; severity_reason = `${pairs.length} pair(s) share director name — related-party bids detected.`; }
      else if (pairs.length > 0)                       { severity = 'WORTH_NOTING'; flag = true; severity_reason = `${pairs.length} pair(s) share PIN code only — warrants cross-referencing.`; }
      else                                             { severity_reason = `No overlaps among ${found.length} bidders. All appear independent.`; }

      return { content: [{ type: 'text', text: JSON.stringify({ bidder_ids_queried: bidder_ids, bidders_found: found.map(b => b.bidder_id), bidders_missing: missing, suspicious_pairs_count: pairs.length, suspicious_pairs: pairs, severity, flag, severity_reason }, null, 2) }] };
    }
  );

  // ── TOOL 4: prioritize_tenders ────────────────────────────────────────────
  server.tool(
    'prioritize_tenders',
    'Rank all tenders by estimated risk score. Returns a priority queue for the supervisor agent.',
    {
      limit:    z.number().optional(),
      min_value: z.number().optional(),
      strategy: z.enum(['risk_first', 'value_first', 'bidder_count_first']).optional()
    },
    async ({ limit, min_value, strategy = 'risk_first' }) => {
      let scored = tenderDataset.map(t => {
        let risk_score = 0; const signals = [];
        if (t.bidder_count === 1) { risk_score += 40; signals.push('single_bidder'); }
        else if (t.bidder_count === 2) { risk_score += 25; signals.push('very_low_bidders'); }
        else if (t.bidder_count === 3) { risk_score += 10; signals.push('low_bidders'); }
        if (t.tender_value >= 10000000) { risk_score += 30; signals.push('high_value'); }
        else if (t.tender_value >= 3000000) { risk_score += 15; signals.push('medium_value'); }
        const vr = vendorAwardHistory.vendors.find(v => t.vendor.toLowerCase().includes(v.vendor_name.toLowerCase()) || v.vendor_name.toLowerCase().includes(t.vendor.toLowerCase()));
        if (vr?.flags?.length > 0) { risk_score += 30; signals.push(`vendor_flagged`); }
        return { tender_id: t.tender_id, title: t.title, department: t.department, vendor: t.vendor, tender_value: t.tender_value, bidder_count: t.bidder_count, risk_score, risk_signals: signals, priority: risk_score >= 60 ? 'HIGH' : risk_score >= 30 ? 'MEDIUM' : 'LOW' };
      });
      if (min_value) scored = scored.filter(t => t.tender_value >= min_value);
      if (strategy === 'value_first') scored.sort((a, b) => b.tender_value - a.tender_value);
      else if (strategy === 'bidder_count_first') scored.sort((a, b) => a.bidder_count - b.bidder_count);
      else scored.sort((a, b) => b.risk_score - a.risk_score);
      const result = limit ? scored.slice(0, limit) : scored;
      return { content: [{ type: 'text', text: JSON.stringify({ total: tenderDataset.length, returned: result.length, strategy, priority_queue: result, summary: { high: result.filter(t => t.priority === 'HIGH').length, medium: result.filter(t => t.priority === 'MEDIUM').length, low: result.filter(t => t.priority === 'LOW').length } }, null, 2) }] };
    }
  );

  // ── TOOL 5: cross_tender_correlation ──────────────────────────────────────
  server.tool(
    'cross_tender_correlation',
    'Find if a vendor or bidder appears across multiple tenders — indicator of systematic corruption or cartel behavior.',
    { entity_name: z.string(), entity_type: z.enum(['vendor', 'bidder']) },
    async ({ entity_name, entity_type }) => {
      const nl = entity_name.toLowerCase();
      const matches = [];
      for (const t of tenderDataset) {
        if (entity_type === 'vendor' && (t.vendor.toLowerCase().includes(nl) || nl.includes(t.vendor.toLowerCase().split(' ')[0]))) {
          matches.push({ tender_id: t.tender_id, role: 'winning_vendor', title: t.title, department: t.department, state: t.state, tender_value: t.tender_value, bidder_count: t.bidder_count });
        } else if (entity_type === 'bidder') {
          const recs = bidderRegistry.bidders.filter(b => b.name.toLowerCase().includes(nl) && t.bidders.includes(b.bidder_id));
          if (recs.length > 0) matches.push({ tender_id: t.tender_id, role: 'bidder_participant', bidder_records: recs.map(b => ({ id: b.bidder_id, name: b.name })), title: t.title, department: t.department, state: t.state, tender_value: t.tender_value });
        }
      }
      const departments = [...new Set(matches.map(m => m.department))];
      const states = [...new Set(matches.map(m => m.state))];
      const totalValue = matches.reduce((s, m) => s + m.tender_value, 0);
      let severity = 'CLEAN', flag = false, summary = '';
      if (matches.length >= 5 && departments.length >= 3) { severity = 'ESCALATE'; flag = true; summary = `${entity_name} in ${matches.length} tenders across ${departments.length} depts — ₹${totalValue.toLocaleString('en-IN')} total.`; }
      else if (matches.length >= 3) { severity = 'WORTH_NOTING'; flag = true; summary = `${entity_name} in ${matches.length} tenders. Repeated engagement.`; }
      else { summary = `${entity_name} in ${matches.length} tender(s). No systematic pattern.`; }
      return { content: [{ type: 'text', text: JSON.stringify({ entity_name, entity_type, match_count: matches.length, total_value_involved: totalValue, departments_involved: departments, states_involved: states, matches, severity, flag, cross_pattern_summary: summary }, null, 2) }] };
    }
  );

  // ── TOOL 6: get_investigation_memory ─────────────────────────────────────
  server.tool(
    'get_investigation_memory',
    'Retrieve investigation state from output results file. Returns which tenders are done and which are pending.',
    { filter: z.enum(['all', 'pending', 'escalate', 'worth_noting', 'clean']).optional() },
    async ({ filter = 'all' }) => {
      const resultsPath = join(OUTPUT_DIR, 'investigation_results.json');
      if (!existsSync(resultsPath)) {
        return { content: [{ type: 'text', text: JSON.stringify({ has_prior_results: false, pending_count: tenderDataset.length, investigated_count: 0 }, null, 2) }] };
      }
      const data = JSON.parse(readFileSync(resultsPath, 'utf-8'));
      const results = data.results || [];
      const investigated = new Set(results.map(r => r.tender_id));
      const pending = tenderDataset.filter(t => !investigated.has(t.tender_id));
      const all = [
        ...results.map(r => ({ tender_id: r.tender_id, status: r.severity, title: r.tender?.title })),
        ...pending.map(t => ({ tender_id: t.tender_id, status: 'pending', title: t.title }))
      ];
      return { content: [{ type: 'text', text: JSON.stringify({ has_prior_results: true, total: tenderDataset.length, investigated_count: results.length, pending_count: pending.length, summary: data.run_metadata?.summary, items: filter === 'all' ? all : all.filter(i => i.status === filter) }, null, 2) }] };
    }
  );

  // ── TOOL 7: verify_employee_login ───────────────────────────────────────
  server.tool(
    'verify_employee_login',
    'Verify employee credentials. Returns success/failure and the profile of the logged-in employee.',
    {
      employee_id: z.string().describe('The Employee ID (e.g. EMP-001)'),
      password:    z.string().describe('The plain-text password')
    },
    async ({ employee_id, password }) => {
      const emp = employeeRegistry.employees.find(
        e => e.id.toUpperCase() === employee_id.trim().toUpperCase() && e.password_hash === password
      );
      if (emp) {
        const { password_hash, ...profile } = emp;
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, profile }, null, 2) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Invalid ID or Password' }, null, 2) }] };
    }
  );

  // ── TOOL 8: get_employee_profiles ────────────────────────────────────────
  server.tool(
    'get_employee_profiles',
    'Retrieve all employee profiles (password hashes removed for safety).',
    {},
    async () => {
      const profiles = employeeRegistry.employees.map(({ password_hash, ...profile }) => profile);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, profiles }, null, 2) }] };
    }
  );

  // ── Resources ─────────────────────────────────────────────────────────────
  server.resource('market_rate_table',    'tenderwatch://data/market_rate_table',    async () => ({ contents: [{ uri: 'tenderwatch://data/market_rate_table',    mimeType: 'application/json', text: JSON.stringify(marketRateTable, null, 2) }] }));
  server.resource('vendor_award_history', 'tenderwatch://data/vendor_award_history', async () => ({ contents: [{ uri: 'tenderwatch://data/vendor_award_history', mimeType: 'application/json', text: JSON.stringify(vendorAwardHistory, null, 2) }] }));
  server.resource('bidder_registry',      'tenderwatch://data/bidder_registry',      async () => ({ contents: [{ uri: 'tenderwatch://data/bidder_registry',      mimeType: 'application/json', text: JSON.stringify(bidderRegistry, null, 2) }] }));
  server.resource('tender_dataset',       'tenderwatch://data/tender_dataset',       async () => ({ contents: [{ uri: 'tenderwatch://data/tender_dataset',       mimeType: 'application/json', text: JSON.stringify(tenderDataset, null, 2) }] }));
  server.resource('employee_registry',    'tenderwatch://data/employee_registry',    async () => ({ contents: [{ uri: 'tenderwatch://data/employee_registry',    mimeType: 'application/json', text: JSON.stringify(employeeRegistry, null, 2) }] }));

  return server;
}

// ─── Transport logic ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const useStdio = args.includes('--stdio');
const useBoth  = args.includes('--both');
const HTTP_PORT = parseInt(process.env.PORT || process.env.MCP_HTTP_PORT || '3002');

async function startHttp() {
  const app = express();
  const transports = {};

  app.get('/health', (_, res) => res.json({
    status: 'ok',
    server: 'TenderWatch MCP',
    version: '2.1.0',
    tools: 8,
    resources: 5,
    tenders_loaded: tenderDataset.length,
    vendors_loaded: vendorAwardHistory.vendors.length,
    bidders_loaded: bidderRegistry.bidders.length,
    employees_loaded: employeeRegistry.employees.length,
  }));

  // SSE endpoint — NitroStudio connects here
  app.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;

    res.on('close', () => {
      delete transports[transport.sessionId];
      console.error(`[TenderWatch MCP] SSE client disconnected. Session: ${transport.sessionId}`);
    });

    const server = buildServer();
    await server.connect(transport);
    console.error(`[TenderWatch MCP] NitroStudio connected via SSE. Session: ${transport.sessionId}`);
  });

  // Message endpoint — NitroStudio posts messages here
  app.post('/messages', express.json(), async (req, res) => {
    const { sessionId } = req.query;
    const transport = transports[sessionId];
    if (!transport) return res.status(404).json({ error: 'Session not found' });
    await transport.handlePostMessage(req, res, req.body);
  });

  app.listen(HTTP_PORT, () => {
    console.error(`\n╔══════════════════════════════════════════════════════╗`);
    console.error(`║  TenderWatch MCP Server v2.1 — HTTP/SSE Mode         ║`);
    console.error(`╠══════════════════════════════════════════════════════╣`);
    console.error(`║  SSE endpoint:  http://localhost:${HTTP_PORT}/sse           ║`);
    console.error(`║  Health check:  http://localhost:${HTTP_PORT}/health         ║`);
    console.error(`║  Tools active:  8  │  Resources: 5                    ║`);
    console.error(`║  Dataset:       ${tenderDataset.length} tenders │ ${vendorAwardHistory.vendors.length} vendors          ║`);
    console.error(`╚══════════════════════════════════════════════════════╝\n`);
    console.error(`  NitroStudio → Connect to MCP Server → URL: http://localhost:${HTTP_PORT}/sse\n`);
  });
}

async function startStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[TenderWatch MCP v2.1] Running on STDIO transport — 8 tools, 5 resources');
}

if (useStdio) {
  await startStdio();
} else if (useBoth) {
  await startHttp();
  // Stdio can't run alongside HTTP in the same process cleanly;
  // use the separate server.js for Stdio and this file for HTTP.
  console.error('[TenderWatch MCP] HTTP started. For Stdio use: node server.js');
} else {
  // Default: HTTP mode (for NitroStudio)
  await startHttp();
}
