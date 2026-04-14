# wikicli

LLM-callable wiki compiler CLI. Turns unstructured documents into a structured, interlinked wiki.

## Install

```bash
npm install
npm run build
```

## Usage

```bash
# Initialize a project
wikic init

# Add source documents
wikic add path/to/doc.md

# Compile sources into wiki
wikic compile

# Search wiki (no LLM, returns JSON)
wikic search "keyword"

# Query wiki (uses LLM for answer)
wikic query "what is X?"

# Lint wiki for issues
wikic lint

# Detect contradictions between articles
wikic lint --contradictions

# Auto-fix issues with LLM
wikic heal

# Export concept graph (with typed edges: implements, extends, contradicts, cites)
wikic graph --format json|dot|html
wikic graph --relations contradicts  # filter to contradiction edges only

# Show project status
wikic status

# Remove a source
wikic remove sources/doc.md
```

## Commands

| Command | LLM? | Description |
|---------|-------|-------------|
| `init` | No | Initialize project |
| `add` | No | Add source files |
| `compile` | Yes | Summarize → Extract → Write pipeline |
| `lint` | No | Static checks (broken links, orphans) |
| `lint --contradictions` | Yes | Detect contradictions between articles |
| `heal` | Yes | LLM-powered fixes |
| `search` | No | Keyword search, JSON output |
| `query` | Yes | Answer questions from wiki |
| `graph` | No | Export concept graph with typed edges |
| `status` | No | Project stats as JSON |
| `remove` | No | Remove source + cascade |

## LLM Provider

Default: `claude -p` (Claude CLI). Configure in `config.yaml`:

```yaml
llm:
  provider: claude-cli
  model: sonnet  # optional
```
