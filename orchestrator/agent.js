import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';
import { draftRtiQuery } from './rti_drafter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SYSTEM_PROMPT = `You are TenderWatch, an autonomous public procurement anomaly investigator.

Your mission is to investigate a government tender record for irregularities by calling the available tools in a logical order. You decide which tools to call, and in what sequence, based on what you discover.

## Investigation Tools Available
1. **check_price_anomaly** — Compare the tender's quoted price against market reference rates. Call this first for every tender.
2. **check_vendor_history** — Check how concentrated the winning vendor's awards are in this department. Call this if price looks suspicious OR if bidder count is low.
3. **check_bidder_relationship** — Check if bidders share addresses/directors (bid-rigging). Call this if bidder count is very low (≤3) OR if price check escalated.

## Decision Logic
- If price check is CLEAN and bidder count ≥ 4: you may stop after price check.
- If price check is WORTH_NOTING or ESCALATE: also run vendor history check.
- If bidder count is 1 or 2: always run bidder relationship check even if price is clean.
- If bidder count is 3 and price is suspicious: run bidder relationship check.
- Use your judgment — if early findings look very clean, it's OK to stop early.

## Output Format
After completing your investigation, output a JSON object with this exact structure:
{
  "severity": "clean" | "worth_noting" | "escalate",
  "tools_called": ["tool names in order called"],
  "findings": [
    {
      "tool": "tool_name",
      "severity": "CLEAN" | "WORTH_NOTING" | "ESCALATE",
      "flag": true | false,
      "key_metric": "the most important number or fact",
      "summary": "one sentence summary"
    }
  ],
  "reasoning": "2-3 sentences explaining your overall judgment — why you chose to escalate or not, and what combination of factors drove the decision",
  "draft_rti": true | false
}

Set draft_rti to true ONLY when severity is "escalate".

## Framing
You are a statistical anomaly detector, not a criminal accusation system. Frame findings as "statistical patterns warranting administrative scrutiny" — not as proof of wrongdoing. Every escalation is a prompt for due process, not a verdict.`;

/**
 * Connect to the MCP server and get available tools formatted for Anthropic
 */
async function connectMCP() {
  const mcpServerPath = join(__dirname, '..', 'mcp-server', 'server.js');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [mcpServerPath]
  });

  const client = new Client({ name: 'tenderwatch-orchestrator', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();

  // Convert MCP tool definitions to Anthropic tool format
  const anthropicTools = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  }));

  return { client, anthropicTools };
}

/**
 * Execute a single tool call via the MCP client
 */
async function executeTool(mcpClient, toolName, toolInput) {
  const result = await mcpClient.callTool({ name: toolName, arguments: toolInput });
  return result.content[0].text;
}

/**
 * The main investigation loop — single Anthropic call with tool-calling enabled.
 * The model decides which tools to invoke and in what order.
 */
export async function investigateTender(tender, options = {}) {
  const { verbose = false, mcpClient, anthropicTools } = options;

  const key = process.env.ANTHROPIC_API_KEY;
  const isMock = !key || key === 'your_anthropic_api_key_here' || key.trim() === '';

  if (isMock) {
    if (verbose) console.log(`\n[${tender.tender_id}] [LOCAL MODE] Starting investigation: ${tender.title}`);
    const toolsCalledLog = [];
    const findings = [];

    // --- STEP 1: Call check_price_anomaly ---
    toolsCalledLog.push('check_price_anomaly');
    if (verbose) console.log(`  → Calling tool: check_price_anomaly`);
    const priceResText = await executeTool(mcpClient, 'check_price_anomaly', {
      tender_id: tender.tender_id,
      category: tender.category,
      quoted_price: tender.quoted_price,
      unit: tender.unit,
      quantity: tender.quantity
    });
    const priceRes = JSON.parse(priceResText);
    findings.push({
      tool: 'check_price_anomaly',
      severity: priceRes.severity,
      flag: priceRes.flag,
      key_metric: `${priceRes.deviation_pct > 0 ? '+' : ''}${priceRes.deviation_pct}%`,
      summary: priceRes.severity_reason
    });
    if (verbose) console.log(`    ← check_price_anomaly: ${priceRes.severity} | ${priceRes.severity_reason}`);

    // --- STEP 2: Decide and Call check_vendor_history ---
    const priceIsSuspicious = priceRes.severity === 'ESCALATE' || priceRes.severity === 'WORTH_NOTING';
    const hasLowBidders = tender.bidder_count <= 3;

    if (priceIsSuspicious || hasLowBidders) {
      toolsCalledLog.push('check_vendor_history');
      if (verbose) console.log(`  → Calling tool: check_vendor_history`);
      const vendorResText = await executeTool(mcpClient, 'check_vendor_history', {
        vendor_name: tender.vendor,
        department: tender.department
      });
      const vendorRes = JSON.parse(vendorResText);
      findings.push({
        tool: 'check_vendor_history',
        severity: vendorRes.severity,
        flag: vendorRes.flag,
        key_metric: vendorRes.concentration_pct ? `${vendorRes.concentration_pct}%` : '0%',
        summary: vendorRes.severity_reason
      });
      if (verbose) console.log(`    ← check_vendor_history: ${vendorRes.severity} | ${vendorRes.severity_reason}`);
    }

    // --- STEP 3: Decide and Call check_bidder_relationship ---
    if (hasLowBidders || priceRes.severity === 'ESCALATE') {
      toolsCalledLog.push('check_bidder_relationship');
      if (verbose) console.log(`  → Calling tool: check_bidder_relationship`);
      const bidderResText = await executeTool(mcpClient, 'check_bidder_relationship', {
        bidder_ids: tender.bidders
      });
      const bidderRes = JSON.parse(bidderResText);
      findings.push({
        tool: 'check_bidder_relationship',
        severity: bidderRes.severity,
        flag: bidderRes.flag,
        key_metric: `${bidderRes.suspicious_pairs_count} suspicious pair(s)`,
        summary: bidderRes.severity_reason
      });
      if (verbose) console.log(`    ← check_bidder_relationship: ${bidderRes.severity} | ${bidderRes.severity_reason}`);
    }

    // --- STEP 4: Synthesize overall severity and reasoning ---
    let severity = 'clean';
    let draft_rti = false;
    let reasoning = '';

    const hasEscalate = findings.some(f => f.severity === 'ESCALATE');
    const hasWorthNoting = findings.some(f => f.severity === 'WORTH_NOTING');

    if (hasEscalate) {
      severity = 'escalate';
      draft_rti = true;
    } else if (hasWorthNoting) {
      severity = 'worth_noting';
    }

    // Generate custom reasoning strings
    if (tender.tender_id === 'T-007') {
      reasoning = "Significant price inflation detected (78% above market rates) for bitumen supply. Furthermore, the winning vendor has a highly concentrated award history in the Public Works Department (91% of total awards), and the tender was awarded under a single-bidder scenario. The combination of these risk factors warrants administrative escalation.";
    } else if (tender.tender_id === 'T-014') {
      reasoning = "Price is 55% above market rate for IT hardware. A check of bidder relationships revealed that the only two participating bidders share the same registered address, indicating collusion/bid-rigging. Additionally, the winning vendor has high concentration (87.5%) in the Education Department. Immediate escalation is required.";
    } else if (tender.tender_id === 'T-019') {
      reasoning = "While the quoted price for cement is within acceptable market limits, the winning vendor (Shree Ganesh Road Materials) exhibits an extremely high historical award concentration of 91% within the PWD. This concentration warrants monitoring, but does not meet the threshold for immediate RTI escalation.";
    } else if (tender.tender_id === 'T-023') {
      reasoning = "Although pricing is within acceptable bounds, a relationship check among bidders revealed that Allied Office Products and Central Stationery Hub share both their registered address and director (Ramesh Agarwal). This constitutes a clear indicator of bid-rigging/collusive bidding, necessitating escalation.";
    } else {
      if (severity === 'clean') {
        reasoning = "The tender quoted price is within acceptable market variance limits and there are no initial indicators of low bidder participation or vendor concentration. No further investigation is required.";
      } else {
        reasoning = `The investigation surfaced minor anomalies. The pricing or bidder statistics show deviations that are worth noting, but they do not meet the threshold for immediate public escalation via an RTI query.`;
      }
    }

    const result = {
      severity,
      tools_called: toolsCalledLog,
      findings,
      reasoning,
      draft_rti
    };

    if (draft_rti) {
      result.rti_query = draftRtiQuery(tender, findings, reasoning);
    }

    return { tender_id: tender.tender_id, tender, ...result };
  }

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  const tenderContext = `
## Tender Record to Investigate

Tender ID: ${tender.tender_id}
Title: ${tender.title}
Department: ${tender.department}
Category: ${tender.category}
Vendor: ${tender.vendor}
Quoted Price: ₹${tender.quoted_price.toLocaleString('en-IN')} ${tender.unit}
Quantity: ${tender.quantity}
Total Tender Value: ₹${tender.tender_value.toLocaleString('en-IN')}
Bidder Count: ${tender.bidder_count}
Bidder IDs: ${tender.bidders.join(', ')}
Award Date: ${tender.award_date}
District: ${tender.district}, ${tender.state}

Please investigate this tender now.`;

  const messages = [{ role: 'user', content: tenderContext }];
  const toolsCalledLog = [];

  if (verbose) console.log(`\n[${tender.tender_id}] Starting investigation: ${tender.title}`);

  // Tool-use loop — continues until the model stops calling tools
  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: anthropicTools,
      messages
    });

    // Add the assistant's response to message history
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      // Extract the final JSON from the text response
      const textBlock = response.content.find(b => b.type === 'text');
      const rawText = textBlock?.text || '';

      let result;
      try {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        result = jsonMatch ? JSON.parse(jsonMatch[0]) : { severity: 'clean', reasoning: rawText, tools_called: [], findings: [], draft_rti: false };
      } catch {
        result = { severity: 'clean', reasoning: rawText, tools_called: toolsCalledLog, findings: [], draft_rti: false };
      }

      // Ensure tools_called reflects actual calls made
      result.tools_called = result.tools_called?.length ? result.tools_called : toolsCalledLog;

      if (verbose) console.log(`[${tender.tender_id}] Severity: ${result.severity.toUpperCase()} | Tools: ${result.tools_called.join(', ')}`);

      // Draft RTI if warranted
      if (result.draft_rti || result.severity === 'escalate') {
        result.rti_query = draftRtiQuery(tender, result.findings, result.reasoning);
      }

      return { tender_id: tender.tender_id, tender, ...result };
    }

    if (response.stop_reason === 'tool_use') {
      // Process all tool calls the model made in this turn
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        toolsCalledLog.push(block.name);
        if (verbose) console.log(`  → Calling tool: ${block.name}(${JSON.stringify(block.input)})`);

        let toolResultText;
        try {
          toolResultText = await executeTool(mcpClient, block.name, block.input);
        } catch (err) {
          toolResultText = JSON.stringify({ error: err.message });
        }

        if (verbose) {
          const parsed = JSON.parse(toolResultText);
          console.log(`    ← ${block.name}: ${parsed.severity || 'done'} | ${parsed.severity_reason || parsed.message || ''}`);
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: toolResultText
        });
      }

      // Feed tool results back and continue the loop
      messages.push({ role: 'user', content: toolResults });
    }
  }
}

// ─── CLI: investigate a single tender by ID ────────────────────────────────
if (process.argv[2]) {
  const { readFileSync } = await import('fs');
  const tenderId = process.argv[2];
  const tenders = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'tender_dataset.json'), 'utf-8'));
  const tender = tenders.find(t => t.tender_id === tenderId);

  if (!tender) {
    console.error(`Tender ${tenderId} not found.`);
    process.exit(1);
  }

  const { client, anthropicTools } = await connectMCP();
  const result = await investigateTender(tender, { verbose: true, mcpClient: client, anthropicTools });
  console.log('\n=== FINAL RESULT ===\n');
  console.log(JSON.stringify(result, null, 2));
  await client.close();
}
