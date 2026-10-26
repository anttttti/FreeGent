# Local models

Any server with an OpenAI-compatible `/v1/chat/completions` endpoint works: vLLM, Ollama, LM Studio, llama.cpp's `llama-server` and others. Use the WebUI from the [local dev server](../local/webui.md), the [TUI](../local/tui.md) or the [CLI](../local/cli.md). freegent.ai cannot reach `localhost` through its proxy, which only forwards to a fixed list of cloud providers. At the default Provider-only level, or at Local, the browser calls your server directly instead, if the server allows the page's origin (Ollama: `OLLAMA_ORIGINS=https://freegent.ai`).

- **WebUI:** add a custom model under **Settings → Models**, with the base URL, model ID, an optional key, the API format and **Context (K)**, the window size in thousands of tokens. The "Ollama" API format uses Ollama's OpenAI-compatible endpoint (`/v1`), so `http://localhost:11434` is enough.
- **TUI and CLI:** `--api-url http://localhost:8000/v1 --provider custom --model <id>`. In the CLI, `--context-window` sets the window size.

## Starting a server

vLLM:

```bash
vllm serve cyankiwi/Qwen3.6-27B-AWQ-INT4 \
  --port 8000 \
  --max-model-len 20000 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --reasoning-parser qwen3
# endpoint: http://localhost:8000/v1
```

Ollama:

```bash
OLLAMA_CONTEXT_LENGTH=32768 ollama serve
ollama pull qwen2.5-coder:7b
# endpoint: http://localhost:11434/v1
```

LM Studio: load a model and start the server from the Developer tab. The endpoint is `http://localhost:1234/v1`.

## Getting good results

- **Enable native tool calls.** FreeGent sends tools in the request and expects tool calls back. For vLLM that means `--enable-auto-tool-choice` and the right `--tool-call-parser` for the model family; a model whose template has no tool support will only chat.
- **Give the model enough context.** The agent's system prompt and tool definitions alone take several thousand tokens. Ollama's default context is small and silently cuts the start of the prompt, so raise it as above.
- **Set Context (K) to what the server really allows** (vLLM's `--max-model-len`, Ollama's context length). FreeGent caps `max_tokens` to the room left in that window and compacts the history before it fills. A value larger than the server's limit leads to overflow errors.
- **Sampling.** The overrides under Settings → Models (temperature, top-p, top-k, min-p, penalties) apply only to custom endpoints. Use the values the model's authors recommend.
- **Compaction is slow on a local model.** Summarising a long history can take a few minutes on consumer hardware; see [Context and compaction](../harness/context.md).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The page cannot connect | The endpoint is opened from freegent.ai, or the server listens on a different port. Use the local dev server. |
| The model answers in text but never calls a tool | The server has no tool-call parser, or the model's chat template lacks tools |
| Replies ignore the instructions or the task | The context is too small and the start of the prompt was cut |
| vLLM ends a short reply after one token with `finish_reason: "stop"` | vLLM's speculative decoding stopping early. FreeGent shows what the server returned; restart without speculative decoding to confirm. |
