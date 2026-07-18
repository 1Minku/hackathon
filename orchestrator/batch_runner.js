import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Anthropic from '@anthropic-ai/sdk';
import { investigateTender } from './agent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '..', 'data');
const OUTPUT_DIR = join(__dirname, '..', 'output');

async function runBatch() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║            TenderWatch — Batch Investigation Runner           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === 'your_anthropic_api_key_here') {
    console.log('⚠️  Notice: ANTHROPIC_API_KEY is not configured. Running in Local Mode using MCP tools.\n');
  }

  const tenders = JSON.parse(readFileSync(join(DATA_DIR, 'tender_dataset.json'), 'utf-8'));
  console.log(`Loaded ${tenders.length} tenders from dataset.\n`);

  // Connect to MCP server once, reuse for all tenders
  const mcpServerPath = join(__dirname, '..', 'mcp-server', 'server.js');
  const transport = new StdioClientTransport({ command: 'node', args: [mcpServerPath] });
  const mcpClient = new Client({ name: 'tenderwatch-batch', version: '1.0.0' });
  await mcpClient.connect(transport);

  const { tools } = await mcpClient.listTools();
  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));

  console.log(`MCP Server connected. Tools available: ${tools.map(t => t.name).join(', ')}\n`);
  console.log('─'.repeat(64));

  const results = [];
  const summary = { total: tenders.length, clean: 0, worth_noting: 0, escalate: 0, errors: 0 };
  const startTime = Date.now();

  for (let i = 0; i < tenders.length; i++) {
    const tender = tenders[i];
    process.stdout.write(`[${String(i + 1).padStart(2, '0')}/${tenders.length}] ${tender.tender_id} — ${tender.title.substring(0, 45)}...`);

    try {
      const result = await investigateTender(tender, {
        verbose: false,
        mcpClient,
        anthropicTools
      });

      results.push(result);
      summary[result.severity]++;

      const badge = result.severity === 'escalate' ? '🔴 ESCALATE' :
                    result.severity === 'worth_noting' ? '🟡 NOTE' : '🟢 CLEAN';
      console.log(` ${badge} (tools: ${result.tools_called?.join(', ') || 'none'})`);

    } catch (err) {
      console.log(` ❌ ERROR: ${err.message}`);
      results.push({ tender_id: tender.tender_id, tender, severity: 'error', error: err.message });
      summary.errors++;
    }

    // Small delay to avoid rate limiting
    if (i < tenders.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  await mcpClient.close();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n' + '═'.repeat(64));
  console.log('BATCH COMPLETE');
  console.log('═'.repeat(64));
  console.log(`Total tenders investigated : ${summary.total}`);
  console.log(`🟢 Clean                   : ${summary.clean}`);
  console.log(`🟡 Worth Noting            : ${summary.worth_noting}`);
  console.log(`🔴 Escalate (RTI drafted)  : ${summary.escalate}`);
  if (summary.errors > 0) console.log(`❌ Errors                  : ${summary.errors}`);
  console.log(`Time elapsed               : ${elapsed}s`);
  console.log('═'.repeat(64));

  // Write results
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = join(OUTPUT_DIR, 'investigation_results.json');
  const output = {
    run_metadata: {
      run_at: new Date().toISOString(),
      total_tenders: summary.total,
      elapsed_seconds: parseFloat(elapsed),
      summary
    },
    results
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);

  // Print escalation summary
  const escalated = results.filter(r => r.severity === 'escalate');
  if (escalated.length > 0) {
    console.log('\n🚨 TENDERS FLAGGED FOR ESCALATION:');
    escalated.forEach(r => {
      console.log(`  → ${r.tender_id}: ${r.tender.title}`);
      console.log(`     ${r.reasoning?.substring(0, 120)}...`);
    });
  }
}

runBatch().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
