# TenderWatch — Public Procurement Anomaly Agent

TenderWatch is an autonomous procurement investigation agent designed to analyze government tenders for irregularities and instantly generate ready-to-file Right to Information (RTI) query templates for suspicious cases. 

## Key Architecture

```
                    ┌─────────────────────────┐
                    │   Batch of Tender Records │
                    │       (25-record dataset)       │
                    └────────────┬──────────────┘
                                 │
                    ┌────────────▼──────────────┐
                    │   Orchestrator Agent       │
                    │   (LLM w/ tool-calling    │
                    │    or local fallback)     │
                    └────────────┬──────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
   ┌────▼─────────┐      ┌───────▼──────────┐    ┌────────▼─────────┐
   │ TOOL:         │      │ TOOL:             │    │ TOOL:             │
   │ check_price_  │      │ check_vendor_     │    │ check_bidder_     │
   │ anomaly()     │      │ history()         │    │ relationship()    │
   └────┬─────────┘      └───────┬──────────┘    └────────┬─────────┘
        │                        │                        │
        │  RESOURCE:              │  RESOURCE:               │  RESOURCE:
        │  market_rates.json     │  vendor_history.json   │  bidder_registry.json
        └────────────────────────┴────────────────────────┘
```

The Orchestrator operates as a single model call with tool-calling enabled. It autonomously reasons over its findings to decide what checks to perform next, whether to stop early, and whether the combination of findings warrants escalation. This is what makes it an **agentic loop** rather than a fixed if/else pipeline.

- **check_price_anomaly**: Checks price deviation against market reference tables.
- **check_vendor_history**: Computes vendor award concentration in the awarding department to surface potential bias.
- **check_bidder_relationship**: Cross-references registration and corporate filings to find competing bidders sharing addresses or directors (bid-rigging).

---

## Directory Structure

- `/data` — Contains the mock data layers (tender database, market rates, vendor history, bidder registry).
- `/mcp-server` — Node.js MCP server exposing the 3 tools and 3 resources.
- `/orchestrator` — The LLM agent wrapper (Claude Sonnet 3.5 tool-use client + RTI generation engine + batch runner).
- `/api` — Express API server exposing endpoints to fetch results and stream live investigations via SSE.
- `/ui` — Single-page dashboard rendered with glassmorphism styling and live tool-use animations.

---

## Getting Started

### 1. Requirements
- Node.js (v18+)
- NPM

### 2. Environment Setup
Create a `.env` file in the root directory:
```env
ANTHROPIC_API_KEY=your_anthropic_api_key_here
PORT=3001
```
*Note: If no Anthropic API key is provided, the orchestrator automatically falls back to a high-fidelity local deterministic mock agent that calls the real MCP server tools, allowing offline testing and presentation.*

### 3. Run the App
To start the API server and UI dashboard, run:
```bash
npm start
```
Open [http://localhost:3001](http://localhost:3001) in your browser.

To run the interactive CLI agent in your terminal (which connects to the local MCP tools and lets you audit tenders interactively):
```bash
npm run cli
```
*CLI Commands: `help`, `list`, `check <tender_id>`, `rti <tender_id>`, `exit`*

---

## Demo Walkthrough Points
1. **Agentic vs. Pipeline Flow**: Show how on clean tenders (like T-001) the agent stops after calling `check_price_anomaly`, saving LLM costs. On suspicious tenders (like T-007), it dynamically decides to invoke all 3 tools.
2. **The "Bitumen Road" Anomaly (T-007)**: Show how a single-bidder road tender with 78% inflated pricing and extreme vendor department concentration (91%) triggers a multi-tool escalation.
3. **RTI Generation**: Show the drafted RTI Act 2005 queries. Citing specific departments and framing questions as request for administrative clarification (not legal verdicts).
