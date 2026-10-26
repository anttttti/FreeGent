# Chats

A chat is one conversation with the agent, with its own history, model and workspace snapshot. This section covers talking to the agent and managing saved chats; [Modes](modes.md) covers the Chat and Cowork tool sets.

## Talking to the agent

- **Enter** sends, **Shift+Enter** adds a newline, **Esc** stops generation. Stop also prevents the rest of a tool batch from starting.
- Responses stream. The view follows the output until you scroll up, and a jump-to-latest button brings it back.
- Code blocks are syntax-highlighted with a copy button and, where it makes sense, **Run** and **Preview** buttons. Math renders with KaTeX (`$$…$$`, `\[…\]`, `\(…\)`).
- A message you send while the agent is working waits in a queue above the input. Click its **⏎ Queue** badge to turn it into **⚡ Steer**, which interrupts the current turn as soon as the message reaches the front. Queued messages can be reordered or removed.
- Unsent text survives a reload and switching chats.
- **Ctrl/Cmd+K** focuses chat search. **Ctrl/Cmd+Shift+F** searches the text of all your chats.

## The toolbar

The toolbar shows the active model and how much of its context window the chat uses, for example `4.2k / 128k` (yellow at 70%, red at 90%). Click the model to open model settings; hover it to see which models are on a rate-limit cooldown. FreeGent compacts long histories on its own ([Context and compaction](../../harness/context.md)). The mode selector switches between [Chat and Cowork](modes.md).

## Attachments

Attach files from the paperclip, drag and drop them onto the chat, or paste. On a phone the attachment sheet offers camera, photos, audio and video.

| Attachment | What the model gets |
|---|---|
| Images, audio | Sent to a model that accepts them. **Settings → Models → Media Model Routing** chooses the models; "Auto" uses the first capable model in your priority list. |
| PDF, Word, Excel | Text extracted in the browser |
| Text and code files | The file content |

Attachments are saved with the chat. If a model refuses images, FreeGent remembers that for ten minutes and then tries again.

## Voice

Speech input and spoken replies work where the browser supports them. **Settings → Voice** sets the speech models, language, voice, speed and pitch, and whether replies are spoken automatically.

## Saved chats

The **Chats** tab lists every chat with its turn count, model and a snapshot of the workspace as it was. Open one to continue it.

- Chats are stored in your browser only.
- Every chat keeps the project files as they were when it started and after its last turn, Autopilot's task chats included. **Reset workspace to start** and **Reset workspace to end** on a chat's card in the Chats tab put the project files back to either state (it asks first, and removes files created since). The chat's messages are left alone. Each chat stores its own copy of the files, so a large project with many chats takes more browser storage.
- Each chat has buttons to download it as JSON (messages, tool calls and results) or as readable Markdown. **Import** restores a JSON file.
- **📤** sends the chat's log to the FreeGent developer to help fix a problem. It asks first, removes your saved API keys from the log, and the log is deleted after 14 days. Nothing is sent otherwise.
- Several browser tabs can use FreeGent at once. A tab that sees a newer copy of a chat reloads it instead of overwriting it. Only one tab runs a turn in a given chat at a time: sending from a second tab while the first is still answering shows a note and keeps your message in the box. If the chat was deleted in another tab, your message goes to a new chat instead.
