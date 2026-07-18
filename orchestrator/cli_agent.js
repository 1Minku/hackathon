import readline from 'readline';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { investigateTender } from './agent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '..', 'data');

async function connectMCP() {
  const mcpServerPath = join(__dirname, '..', 'mcp-server', 'server.js');
  const transport = new StdioClientTransport({ command: 'node', args: [mcpServerPath] });
  const client = new Client({ name: 'tenderwatch-cli-agent', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));
  return { client, anthropicTools };
}

async function startCli() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║             TenderWatch — Interactive CLI Agent              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('Connecting to MCP server... Please wait.');

  let mcp;
  try {
    mcp = await connectMCP();
    console.log('✅ Connected to MCP Server.');
    console.log('Available Commands: help, list, check <id>, rti <id>, exit\n');
  } catch (err) {
    console.error('❌ Failed to connect to MCP Server:', err.message);
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'tenderwatch-agent> '
  });

  const tenders = JSON.parse(readFileSync(join(DATA_DIR, 'tender_dataset.json'), 'utf-8'));

  rl.prompt();

  rl.on('line', async (line) => {
    const args = line.trim().split(/\s+/);
    const command = args[0].toLowerCase();

    switch (command) {
      case 'exit':
      case 'quit':
        console.log('Closing agent session. Goodbye!');
        await mcp.client.close();
        process.exit(0);
        break;

      case 'help':
        console.log('\nAvailable Commands:');
        console.log('  list                     - List all available tenders');
        console.log('  check <tender_id>        - Run the orchestrator agent on a specific tender');
        console.log('  rti <tender_id>          - Print the drafted RTI request for an escalated tender');
        console.log('  exit / quit              - Close the session\n');
        break;

      case 'list':
        console.log('\nTenders in Dataset:');
        tenders.forEach(t => {
          console.log(`  [${t.tender_id}] ${t.title.substring(0, 50)}... (${t.vendor} | ₹${t.tender_value.toLocaleString('en-IN')})`);
        });
        console.log();
        break;

      case 'check': {
        const id = args[1]?.toUpperCase();
        const tender = tenders.find(t => t.tender_id === id);
        if (!tender) {
          console.log(`❌ Error: Tender "${args[1] || ''}" not found. Type "list" to see available IDs.`);
          break;
        }

        console.log(`\nStarting investigation for ${id}...`);
        try {
          const result = await investigateTender(tender, {
            verbose: true,
            mcpClient: mcp.client,
            anthropicTools: mcp.anthropicTools
          });

          console.log('\n--- Investigation Verdict ---');
          console.log(`Severity : ${result.severity.toUpperCase()}`);
          console.log(`Tools    : ${result.tools_called.join(' → ')}`);
          console.log(`Reasoning: ${result.reasoning}`);
          if (result.severity === 'escalate') {
            console.log('🚨 Flagged for escalation. Type "rti ' + id + '" to print the drafted RTI.');
          }
          console.log('-----------------------------\n');
        } catch (err) {
          console.error('❌ Investigation error:', err.message);
        }
        break;
      }

      case 'rti': {
        const id = args[1]?.toUpperCase();
        const tender = tenders.find(t => t.tender_id === id);
        if (!tender) {
          console.log(`❌ Error: Tender "${args[1] || ''}" not found.`);
          break;
        }

        console.log(`Generating RTI draft for ${id}...`);
        try {
          // Force a local run to synthesize the RTI template
          const result = await investigateTender(tender, {
            verbose: false,
            mcpClient: mcp.client,
            anthropicTools: mcp.anthropicTools
          });

          if (result.severity !== 'escalate') {
            console.log(`⚠️  Notice: Tender ${id} is clean or low-severity. No RTI was drafted.`);
          } else if (result.rti_query) {
            console.log('\n================================================================');
            console.log(result.rti_query.body);
            console.log('================================================================\n');
          }
        } catch (err) {
          console.error('❌ Error generating RTI draft:', err.message);
        }
        break;
      }

      default:
        if (line.trim() !== '') {
          console.log(`Unknown command: "${command}". Type "help" for a list of commands.`);
        }
        break;
    }
    rl.prompt();
  });
}

startCli().catch(err => {
  console.error('Fatal CLI Agent error:', err);
  process.exit(1);
});
