# WebUI

The WebUI is the browser app, the same on [freegent.ai](https://freegent.ai) and on a local server. The left rail has **New Chat**, **Project**, **Tasks**, **Chats**, a dark-mode toggle and **Settings**.

| Page | What it is for |
|---|---|
| [Project](project/index.md) | The agent's workspace: file tree, editor, import and export, previews of images, PDFs, Office files and HTML |
| [Tasks](tasks.md) | The task board and Autopilot |
| [Chats](chats/index.md) | The conversation, saved chats, attachments, voice, and the Chat and Cowork modes |
| [Settings](settings.md) | Every Settings tab, profiles, and where your data lives |

## First chat

1. Open **Settings → Models → API Credentials** and paste a key for one provider (see [Default providers](../models/providers.md)).
2. Type a request and press **Enter**. **Shift+Enter** adds a newline and **Esc** stops generation.
3. The agent may call tools: read and write project files, run code, search the web. Each call appears as a step in the chat. Files it creates land in [Project](project/index.md).

The toolbar shows the active model and how much of its context window is used (`4.2k / 128k`, yellow at 70%, red at 90%). FreeGent compacts old history automatically; see [Context and compaction](../harness/context.md).

## Where things run

The page itself is static. Provider calls go through a proxy ([How requests reach providers](../models/proxy.md)) and code runs in browser sandboxes ([Code execution](../code-execution/index.md)). On freegent.ai the agent cannot run bash or Python on your machine, use `run_git` or reach models on `localhost`; the [local server](../local/webui.md) adds those.
