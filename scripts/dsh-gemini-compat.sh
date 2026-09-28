#!/bin/bash
# Re-apply the Gemini thought_signature compat patch to the vendored pi-ai
# inside the global @deepseek-ai/dsh install. Needed because npm reinstall /
# upgrade of dsh wipes node_modules.
#
# What it does in dist/api/openai-completions.js:
#   1. Capture toolCall.extra_content (Gemini thought_signature) onto the
#      toolCall content block while streaming.
#   2. Emit it back on serialized assistant tool_calls; for provider "gemini"
#      fall back to {"google":{"thought_signature":"skip_thought_signature_validator"}}.
set -euo pipefail
P=${DSH_PI_AI_PATH:-$HOME/.local/lib/node_modules}/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js
[ -f "$P" ] || { echo "pi-ai not found at $P — check dsh install"; exit 1; }
if grep -q 'geminiThoughtSignature' "$P"; then echo "already patched"; exit 0; fi
python3 - "$P" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
a = """                            const block = ensureToolCallBlock(toolCall);
                            if (!block.id && toolCall.id) {"""
b = """                            const block = ensureToolCallBlock(toolCall);
                            if (toolCall.extra_content !== undefined) {
                                block.extraContent = toolCall.extra_content;
                            }
                            if (!block.id && toolCall.id) {"""
assert s.count(a) == 1, "anchor A not found"
s = s.replace(a, b)
c = """                    return {
                        id: tc.id,
                        type: "function",
                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.arguments),
                        },
                    };"""
d = """                    const geminiThoughtSignature = model?.provider === "gemini"
                        ? (tc.extraContent ?? { google: { thought_signature: "skip_thought_signature_validator" } })
                        : tc.extraContent;
                    return {
                        id: tc.id,
                        type: "function",
                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.arguments),
                        },
                        ...(geminiThoughtSignature !== undefined ? { extra_content: geminiThoughtSignature } : {}),
                    };"""
assert s.count(c) == 1, "anchor B not found"
s = s.replace(c, d)
open(p, "w").write(s)
print("patched", p)
PY
