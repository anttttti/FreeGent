# MCP servers

MCP (Model Context Protocol) servers give the agent extra tools, such as up-to-date library documentation or a company wiki. FreeGent is an MCP client over Streamable HTTP. Add a server under **Settings → MCP**, or pick one from the standard library (DeepWiki, Microsoft Learn, Hugging Face). Library documentation from Context7 is a separate built-in tool, `context7_docs`, which is off by default. Each server's tools start disabled; enable the ones the agent should see. Enabled tools appear to the model as `mcp__<server>__<tool>`, and a server's instructions are added to the prompt only when a role can call one of its tools.

## Connection and privacy

The browser connects to the server directly, so the server must allow cross-origin requests from the page. With the local dev server, a request that fails at the network level is retried through the server's proxy. On the hosted site there is no such fallback, because the hosted Worker only reaches its fixed provider hosts. Server credentials are saved in your browser and are not included in profiles. Every tool call sends its arguments to that server, so enable only servers you trust with what the agent is working on.

For the CLI, `--mcp-config` takes a JSON file of per-run servers.
