/**
 * TenderWatch Supervisor Agent
 * ────────────────────────────────────────────────────────────────────────────
 * A high-level autonomous orchestrator that:
 *  1. Checks investigation memory to avoid re-work
 *  2. Calls prioritize_tenders to rank the dataset by risk score
 *  3. Uses cross_tender_correlation to surface entity-level patterns
 *  4. Delegates individual tender investigations to the sub-agent (agent.js)
 *  5. Writes a structured executive intelligence brief when done
 *
 * When an ANTHROPIC_API_KEY is available, it uses Claude in an agentic loop
 * to make strategic decisions. Without a key it runs a deterministic
 * supervisor that mirrors the same logic locally.
 * ────────────────────────────────────────────────────────────────────────────
 */

import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';
import { investigateTender } from './agent.js';
import { draftRtiQuery } from './rti_drafter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');
const OUTPUT_DIR = join(__dirname, '..', 'output');

// ─── Supervisor System Prompt ────────────────────────────────────────────────
const SUPERVISOR_PROMPT = `You are the TenderWatch Supervisor — an autonomous procurement oversight strategist.

You oversee a dataset of government tenders and must decide HOW to investigate them intelligently.

## Your Strategic Responsibilities
1. **Check memory first**: Call get_investigation_memory to see which tenders have already been investigated. Never repeat work.
2. **Prioritize intelligently**: Call prioritize_tenders with strategy "risk_first" to get a ranked queue. Focus high-risk tenders.
3. **Look for patterns**: Before individual investigations, call cross_tender_correlation on any vendors or entities appearing in 3+ high-priority tenders.
4. **Delegate investigations**: For each tender you decide to investigate, report it as a decision in your final output.
5. **Synthesize findings**: After reviewing priorities and correlations, produce a strategic intelligence brief.

## Output Format (JSON)
After your analysis, output:
{
  "supervisor_decision": {
    "tenders_already_investigated": ["T-001", ...],
    "tenders_to_investigate": ["T-007", "T-014", ...],
    "tenders_deprioritized": ["T-003", ...],
    "deprioritization_reason": "string",
    "high_risk_entities": [{ "name": "Vendor X", "risk": "ESCALATE", "appears_in": [...] }],
    "strategic_note": "2-3 sentence strategic framing of the investigation"
  }
}`;

// ─── Shared MCP connection logic ─────────────────────────────────────────────
async function connectMCP() {
  const mcpServerPath = join(__dirname, '..', 'mcp-server', 'server.js');
  const transport = new StdioClientTransport({ command: 'node', args: [mcpServerPath] });
  const client = new Client({ name: 'tenderwatch-supervisor', version: '2.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));
  return { client, anthropicTools };
}

async function callTool(mcpClient, toolName, input) {
  const result = await mcpClient.callTool({ name: toolName, arguments: input });
  return JSON.parse(result.content[0].text);
}

// ─── Local deterministic supervisor (no API key) ─────────────────────────────
async function localSupervisor(mcpClient, anthropicTools, tenders, onProgress) {
  onProgress('Checking investigation memory...');
  const memory = await callTool(mcpClient, 'get_investigation_memory', { filter: 'all' });

  const alreadyInvestigated = memory.items
    ?.filter(i => i.status !== 'pending')
    .map(i => i.tender_id) || [];

  onProgress(`Memory: ${alreadyInvestigated.length} already investigated, ${memory.pending_count} pending.`);

  onProgress('Prioritizing tenders by risk score...');
  const priority = await callTool(mcpClient, 'prioritize_tenders', { strategy: 'risk_first' });
  const queue = priority.priority_queue;

  // Allow incremental mode: skip previously investigated tenders only with env flag
  const skipExisting = process.env.SUPERVISOR_INCREMENTAL === 'true';
  const todo = skipExisting
    ? queue.filter(t => !alreadyInvestigated.includes(t.tender_id))
    : queue; // default: re-investigate everything (fresh run)

  onProgress(`Queued ${todo.length} tenders for investigation (incremental=${skipExisting}).`);

  // Cross-correlate top vendors appearing in HIGH-priority tenders
  const highRiskVendors = queue
    .filter(t => t.priority === 'HIGH')
    .map(t => t.vendor);
  const uniqueHighRiskVendors = [...new Set(highRiskVendors)];

  const entityInsights = [];
  for (const vendor of uniqueHighRiskVendors.slice(0, 3)) {
    onProgress(`Cross-correlating entity: "${vendor}"...`);
    const corr = await callTool(mcpClient, 'cross_tender_correlation', {
      entity_name: vendor,
      entity_type: 'vendor'
    });
    if (corr.flag) {
      entityInsights.push({
        name: corr.entity_name,
        risk: corr.severity,
        match_count: corr.match_count,
        departments: corr.departments_involved,
        total_value: corr.total_value_involved,
        summary: corr.cross_pattern_summary
      });
    }
  }

  return {
    tenders_already_investigated: alreadyInvestigated,
    tenders_to_investigate: todo.map(t => t.tender_id),
    tenders_deprioritized: [],
    deprioritization_reason: 'All pending tenders included based on risk-first ordering.',
    high_risk_entities: entityInsights,
    priority_queue: queue,
    strategic_note: `Supervisor identified ${priority.summary.high_priority} high-risk tenders requiring immediate investigation. ${entityInsights.length > 0 ? `Cross-tender entity analysis flagged ${entityInsights.length} vendor(s) with suspicious cross-department presence.` : 'No cross-tender vendor patterns detected.'} Investigations will proceed in risk-descending order.`
  };
}

// ─── LLM-based supervisor (with API key) ─────────────────────────────────────
async function llmSupervisor(mcpClient, anthropicTools, onProgress) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const messages = [{
    role: 'user',
    content: 'Begin the TenderWatch supervisor analysis. Check memory, prioritize the tender queue, run cross-entity correlations on high-risk vendors, and produce your strategic decision JSON.'
  }];

  const toolsCalledLog = [];
  onProgress('LLM Supervisor initializing...');

  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: SUPERVISOR_PROMPT,
      tools: anthropicTools,
      messages
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const text = response.content.find(b => b.type === 'text')?.text || '';
      const match = text.match(/\{[\s\S]*\}/);
      const parsed = match ? JSON.parse(match[0]) : { supervisor_decision: {} };
      return parsed.supervisor_decision || parsed;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        toolsCalledLog.push(block.name);
        onProgress(`Supervisor calling: ${block.name}()`);

        let resultText;
        try {
          const r = await mcpClient.callTool({ name: block.name, arguments: block.input });
          resultText = r.content[0].text;
        } catch (err) {
          resultText = JSON.stringify({ error: err.message });
        }

        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultText });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  }
}

// ─── Write executive intelligence brief ──────────────────────────────────────
function writeExecutiveBrief(supervisorDecision, investigationResults, elapsedSec) {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const escalated = investigationResults.filter(r => r.severity === 'escalate');
  const worth_noting = investigationResults.filter(r => r.severity === 'worth_noting');
  const clean = investigationResults.filter(r => r.severity === 'clean');
  const totalValue = investigationResults.reduce((s, r) => s + (r.tender?.tender_value || 0), 0);
  const escalatedValue = escalated.reduce((s, r) => s + (r.tender?.tender_value || 0), 0);

  const brief = {
    report_type: 'TenderWatch Executive Intelligence Brief',
    generated_at: new Date().toISOString(),
    elapsed_seconds: elapsedSec,
    supervisor_strategy: supervisorDecision,
    summary: {
      total_investigated: investigationResults.length,
      clean: clean.length,
      worth_noting: worth_noting.length,
      escalate: escalated.length,
      total_value_under_review: totalValue,
      total_value_in_escalated: escalatedValue,
      risk_rate_pct: parseFloat(((escalated.length / investigationResults.length) * 100).toFixed(1))
    },
    escalated_tenders: escalated.map(r => ({
      tender_id: r.tender_id,
      title: r.tender?.title,
      department: r.tender?.department,
      vendor: r.tender?.vendor,
      value: r.tender?.tender_value,
      tools_called: r.tools_called,
      reasoning: r.reasoning,
      rti_generated: !!r.rti_query
    })),
    worth_noting_tenders: worth_noting.map(r => ({
      tender_id: r.tender_id,
      title: r.tender?.title,
      reasoning: r.reasoning
    })),
    entity_intelligence: supervisorDecision.high_risk_entities || [],
    full_results: investigationResults
  };

  const briefPath = join(OUTPUT_DIR, 'executive_brief.json');
  writeFileSync(briefPath, JSON.stringify(brief, null, 2));

  // Also write the standard batch results for UI compatibility
  const batchPath = join(OUTPUT_DIR, 'investigation_results.json');
  writeFileSync(batchPath, JSON.stringify({
    run_metadata: {
      run_at: brief.generated_at,
      total_tenders: investigationResults.length,
      elapsed_seconds: elapsedSec,
      summary: {
        total: investigationResults.length,
        clean: clean.length,
        worth_noting: worth_noting.length,
        escalate: escalated.length,
        errors: 0
      }
    },
    results: investigationResults
  }, null, 2));

  return brief;
}

// ─── Main supervisor run ──────────────────────────────────────────────────────
export async function runSupervisor(options = {}) {
  const {
    verbose = true,
    onProgress = (msg) => verbose && console.log(`  [Supervisor] ${msg}`),
    onTenderStart = (id) => verbose && process.stdout.write(`  → Investigating ${id}... `),
    onTenderDone = (id, sev) => verbose && console.log(sev === 'escalate' ? '🔴 ESCALATE' : sev === 'worth_noting' ? '🟡 NOTE' : '🟢 CLEAN')
  } = options;

  const tenders = JSON.parse(readFileSync(join(DATA_DIR, 'tender_dataset.json'), 'utf-8'));
  const startTime = Date.now();

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║         TenderWatch Autonomous Supervisor Agent v2           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const { client: mcpClient, anthropicTools } = await connectMCP();
  onProgress('MCP Server connected. Tools: ' + anthropicTools.map(t => t.name).join(', '));

  const key = process.env.ANTHROPIC_API_KEY;
  const hasKey = key && key !== 'your_anthropic_api_key_here' && key.trim() !== '';

  // ── PHASE 1: Supervisor strategic planning ────────────────────────────────
  console.log('\n── PHASE 1: Strategic Planning ─────────────────────────────────\n');
  let supervisorDecision;
  if (hasKey) {
    supervisorDecision = await llmSupervisor(mcpClient, anthropicTools, onProgress);
  } else {
    onProgress('No API key — running local deterministic supervisor.');
    supervisorDecision = await localSupervisor(mcpClient, anthropicTools, tenders, onProgress);
  }

  console.log(`\n  Strategic note: ${supervisorDecision.strategic_note}`);
  if (supervisorDecision.high_risk_entities?.length > 0) {
    console.log(`\n  ⚠️  High-risk entities identified:`);
    supervisorDecision.high_risk_entities.forEach(e => {
      console.log(`     • ${e.name} — ${e.risk} (${e.match_count} tender appearances)`);
    });
  }

  // ── PHASE 2: Delegated sub-agent investigations ───────────────────────────
  console.log('\n── PHASE 2: Sub-Agent Investigations ───────────────────────────\n');

  const orderedIds = supervisorDecision.tenders_to_investigate || tenders.map(t => t.tender_id);
  const investigationResults = [];

  for (const tenderId of orderedIds) {
    const tender = tenders.find(t => t.tender_id === tenderId);
    if (!tender) continue;

    onTenderStart(tenderId);
    try {
      const result = await investigateTender(tender, {
        verbose: false,
        mcpClient,
        anthropicTools
      });
      investigationResults.push(result);
      onTenderDone(tenderId, result.severity);
    } catch (err) {
      console.log(`  ❌ ERROR on ${tenderId}: ${err.message}`);
      investigationResults.push({
        tender_id: tenderId,
        tender,
        severity: 'error',
        error: err.message,
        tools_called: [],
        findings: []
      });
    }

    await new Promise(r => setTimeout(r, 200));
  }

  // ── PHASE 3: Executive brief ──────────────────────────────────────────────
  console.log('\n── PHASE 3: Executive Intelligence Brief ───────────────────────\n');
  const elapsed = parseFloat(((Date.now() - startTime) / 1000).toFixed(1));
  const brief = writeExecutiveBrief(supervisorDecision, investigationResults, elapsed);

  const escalated = investigationResults.filter(r => r.severity === 'escalate');
  const riskPct = investigationResults.length > 0
    ? ((escalated.length / investigationResults.length) * 100).toFixed(1)
    : '0.0';

  console.log('════════════════════════════════════════════════════════════════');
  console.log('SUPERVISOR COMPLETE — EXECUTIVE SUMMARY');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`Total investigated      : ${investigationResults.length}`);
  console.log(`🟢 Clean                : ${brief.summary.clean}`);
  console.log(`🟡 Worth Noting         : ${brief.summary.worth_noting}`);
  console.log(`🔴 Escalate             : ${brief.summary.escalate}`);
  console.log(`Risk rate               : ${riskPct}% of tenders flagged`);
  console.log(`Total value reviewed    : ₹${brief.summary.total_value_under_review.toLocaleString('en-IN')}`);
  console.log(`Value in escalated      : ₹${brief.summary.total_value_in_escalated.toLocaleString('en-IN')}`);
  console.log(`Elapsed                 : ${elapsed}s`);
  console.log('════════════════════════════════════════════════════════════════');

  if (escalated.length > 0) {
    console.log('\n🚨 TENDERS REQUIRING IMMEDIATE ATTENTION:');
    escalated.forEach(r => {
      console.log(`\n  → ${r.tender_id}: ${r.tender?.title}`);
      console.log(`     Tools: ${r.tools_called?.join(' → ')}`);
      console.log(`     ${r.reasoning?.substring(0, 130)}...`);
    });
  }

  console.log(`\nExecutive brief saved to: ${join(OUTPUT_DIR, 'executive_brief.json')}`);
  console.log(`Results saved to:         ${join(OUTPUT_DIR, 'investigation_results.json')}\n`);

  await mcpClient.close();
  return brief;
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────
runSupervisor({ verbose: true }).catch(err => {
  console.error('\nFatal Supervisor Error:', err.message);
  process.exit(1);
});
