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

# Auto-fix issues with LLM
wikic heal

# Export concept graph
wikic graph --format json|dot|html

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
| `heal` | Yes | LLM-powered fixes |
| `search` | No | Keyword search, JSON output |
| `query` | Yes | Answer questions from wiki |
| `graph` | No | Export concept graph |
| `status` | No | Project stats as JSON |
| `remove` | No | Remove source + cascade |

## LLM Provider

Default: `claude -p` (Claude CLI). Configure in `config.yaml`:

```yaml
llm:
  provider: claude-cli
  model: sonnet  # optional
```
