# Test Fixture: fresh-test (2-round conversation)

Created: 2026-03-22
Session: fresh-test

## Test Parameters
- LCM_LEAF_CHUNK_TOKENS=200
- contextThreshold=0.006
- freshTailCount=1
- tokenBudget=200000
- threshold=1200 (200000 * 0.006)

## Round 1
- Input: "Write 300 words about Python programming"
- Result: ~646 tokens stored, no compaction (646 < 1200)

## Round 2
- Input: "Now write 300 words about Rust programming"
- Result: ~1296 tokens > 1200 threshold, compaction triggered
- Leaf pass: compressed, token savings observed

## LCM Stages (17 events)
Round 1: assemble_skip -> afterTurn -> ingest x2 -> compaction_evaluate(False)
Round 2: bootstrap -> assemble_input -> context_assemble -> assemble_output
         -> afterTurn -> ingest x2 -> compaction_evaluate(True)
         -> leaf_pass_detail -> leaf_summary -> compact_result

## Files
- lcm-diagnostics.jsonl: LCM diagnostic events
- raw.jsonl: HTTP proxy capture data

## How to replay
```bash
# Copy fixture data to test environment
cp test-fixtures/lcm-diagnostics.jsonl ~/.openclaw-test/lcm-diagnostics.jsonl
cp test-fixtures/raw.jsonl ~/openclaw-test-deploy/ai_toolbox/data/context_capture_live/raw.jsonl

# Restart capture API
cd ~/openclaw-test-deploy/ai_toolbox
./openclaw_capture_toolkit.sh stop && ./openclaw_capture_toolkit.sh start

# Open Web UI
# http://127.0.0.1:9001/
```
