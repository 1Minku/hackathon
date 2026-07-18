import express from 'express';
import cors from 'cors';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

const ROOT_DIR = join(__dirname, '..');
const DATA_DIR = join(ROOT_DIR, 'data');
const OUTPUT_DIR = join(ROOT_DIR, 'output');
const UI_DIR = join(ROOT_DIR, 'ui');

app.use(cors());
app.use(express.json());

// Serve the UI as static files
app.use(express.static(UI_DIR));

// ─── GET /api/tenders ─────────────────────────────────────────────────────
// Returns the full tender dataset
app.get('/api/tenders', (req, res) => {
  try {
    const tenders = JSON.parse(readFileSync(join(DATA_DIR, 'tender_dataset.json'), 'utf-8'));
    res.json({ success: true, tenders, count: tenders.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/bidders ─────────────────────────────────────────────────────
// Returns the bidder registry dataset
app.get('/api/bidders', (req, res) => {
  try {
    const registry = JSON.parse(readFileSync(join(DATA_DIR, 'bidder_registry.json'), 'utf-8'));
    res.json({ success: true, bidders: registry.bidders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/market-rates ────────────────────────────────────────────────
// Returns the market reference rates
app.get('/api/market-rates', (req, res) => {
  try {
    const rates = JSON.parse(readFileSync(join(DATA_DIR, 'market_rate_table.json'), 'utf-8'));
    res.json({ success: true, categories: rates.categories });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/results ─────────────────────────────────────────────────────
// Returns cached investigation results if they exist
app.get('/api/results', (req, res) => {
  const resultsPath = join(OUTPUT_DIR, 'investigation_results.json');
  if (!existsSync(resultsPath)) {
    return res.json({ success: false, message: 'No results yet. Run a batch investigation first.' });
  }
  const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
  res.json({ success: true, ...results });
});

// ─── POST /api/investigate/:tender_id ─────────────────────────────────────
// Runs the agent on a single tender, streams SSE progress updates
app.get('/api/investigate/:tender_id', async (req, res) => {
  const { tender_id } = req.params;

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Anthropic API key warning (will fall back to local mode in agent)
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your_anthropic_api_key_here') {
    sendEvent('status', { message: 'Notice: ANTHROPIC_API_KEY not configured. Running in Local Mode using MCP tools.', phase: 'local_mode_notice' });
  }

  sendEvent('status', { message: `Starting investigation for ${tender_id}...`, phase: 'init' });

  try {
    // Dynamically import to avoid circular issues
    const { investigateTender } = await import('../orchestrator/agent.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const tenders = JSON.parse(readFileSync(join(DATA_DIR, 'tender_dataset.json'), 'utf-8'));
    const tender = tenders.find(t => t.tender_id === tender_id);

    if (!tender) {
      sendEvent('error', { message: `Tender ${tender_id} not found.` });
      res.end();
      return;
    }

    sendEvent('tender', { tender });
    sendEvent('status', { message: 'Connecting to MCP server...', phase: 'mcp_connect' });

    const mcpServerPath = join(ROOT_DIR, 'mcp-server', 'server.js');
    const transport = new StdioClientTransport({ command: 'node', args: [mcpServerPath] });
    const mcpClient = new Client({ name: 'tenderwatch-api', version: '1.0.0' });
    await mcpClient.connect(transport);

    const { tools } = await mcpClient.listTools();
    const anthropicTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    }));

    sendEvent('status', { message: 'Investigating with TenderWatch Agent...', phase: 'investigating' });

    const result = await investigateTender(tender, {
      verbose: false,
      mcpClient,
      anthropicTools
    });

    await mcpClient.close();

    sendEvent('result', result);
    sendEvent('done', { tender_id });

  } catch (err) {
    sendEvent('error', { message: err.message });
  }

  res.end();
});

// ─── POST /api/run-batch ───────────────────────────────────────────────────
// Triggers a full batch run as a background child process
app.post('/api/run-batch', (req, res) => {
  const batchScript = join(ROOT_DIR, 'orchestrator', 'batch_runner.js');

  const child = spawn('node', [batchScript], {
    env: { ...process.env },
    detached: false,
    stdio: 'pipe'
  });

  let output = '';
  child.stdout.on('data', d => output += d.toString());
  child.stderr.on('data', d => output += d.toString());

  child.on('close', code => {
    console.log(`Batch runner exited with code ${code}`);
  });

  res.json({ success: true, message: 'Batch investigation started in background. Poll /api/results for progress.' });
});

// ─── POST /api/run-supervisor ──────────────────────────────────────────────
// Triggers the Supervisor Agent (Phase 1: Planning, Phase 2: Investigation,
// Phase 3: Executive Brief). Runs as a background child process.
app.post('/api/run-supervisor', (req, res) => {
  const supervisorScript = join(ROOT_DIR, 'orchestrator', 'supervisor.js');

  const child = spawn('node', [supervisorScript], {
    env: { ...process.env },
    detached: false,
    stdio: 'pipe'
  });

  let output = '';
  child.stdout.on('data', d => { output += d.toString(); process.stdout.write(d); });
  child.stderr.on('data', d => output += d.toString());
  child.on('close', code => {
    console.log(`Supervisor exited with code ${code}`);
  });

  res.json({ success: true, message: 'Supervisor agent started. Poll /api/brief and /api/results for progress.' });
});

// ─── GET /api/brief ───────────────────────────────────────────────────────
// Returns the executive intelligence brief from the supervisor run
app.get('/api/brief', (req, res) => {
  const briefPath = join(OUTPUT_DIR, 'executive_brief.json');
  if (!existsSync(briefPath)) {
    return res.json({ success: false, message: 'No executive brief yet. Run the Supervisor Agent first via POST /api/run-supervisor.' });
  }
  const brief = JSON.parse(readFileSync(briefPath, 'utf-8'));
  res.json({ success: true, brief });
});

// ─── GET /api/prioritize ──────────────────────────────────────────────────
// Returns risk-scored priority queue via the MCP prioritize_tenders tool
app.get('/api/prioritize', async (req, res) => {
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const mcpServerPath = join(ROOT_DIR, 'mcp-server', 'server.js');
    const transport = new StdioClientTransport({ command: 'node', args: [mcpServerPath] });
    const mcpClient = new Client({ name: 'tenderwatch-api-prioritize', version: '2.0.0' });
    await mcpClient.connect(transport);

    const strategy = req.query.strategy || 'risk_first';
    const result = await mcpClient.callTool({
      name: 'prioritize_tenders',
      arguments: { strategy }
    });
    await mcpClient.close();

    res.json({ success: true, ...JSON.parse(result.content[0].text) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/employees ───────────────────────────────────────────────────
// Returns all employee profiles (password-scrubbed) via the MCP tool
app.get('/api/employees', async (req, res) => {
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const mcpServerPath = join(ROOT_DIR, 'mcp-server', 'server.js');
    const transport = new StdioClientTransport({ command: 'node', args: [mcpServerPath] });
    const mcpClient = new Client({ name: 'tenderwatch-api-employees', version: '2.0.0' });
    await mcpClient.connect(transport);

    const result = await mcpClient.callTool({ name: 'get_employee_profiles', arguments: {} });
    await mcpClient.close();

    res.json(JSON.parse(result.content[0].text));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/login ──────────────────────────────────────────────────────
// Verifies employee credentials via the MCP verify_employee_login tool
app.post('/api/login', async (req, res) => {
  const { employee_id, password } = req.body || {};
  if (!employee_id || !password) {
    return res.status(400).json({ success: false, message: 'employee_id and password are required.' });
  }

  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const mcpServerPath = join(ROOT_DIR, 'mcp-server', 'server.js');
    const transport = new StdioClientTransport({ command: 'node', args: [mcpServerPath] });
    const mcpClient = new Client({ name: 'tenderwatch-api-login', version: '2.0.0' });
    await mcpClient.connect(transport);

    const result = await mcpClient.callTool({
      name: 'verify_employee_login',
      arguments: { employee_id, password }
    });
    await mcpClient.close();

    res.json(JSON.parse(result.content[0].text));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Catch-all: serve UI ───────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(join(UI_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`TenderWatch API server running at http://localhost:${PORT}`);
  console.log(`UI accessible at http://localhost:${PORT}`);
});
