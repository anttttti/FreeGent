# Project

The Project tab is the agent's workspace. Everything the agent reads, writes or runs lives here.

## Files and storage

- A file tree and a CodeMirror editor, with tabs for open files.
- Files are stored in your browser (IndexedDB). They stay there until you clear site data.
- On browsers that support the File System Access API you can also attach a folder from your disk. It appears under `local/` and the agent reads and writes real files there. A bare path such as `notes.md` goes to the browser workspace; `local/notes.md` goes to the attached folder.
- The agent works on the project through its file tools (see [Tools](/harness/tools)): `list_files`, `read_file`, `search_workspace` and, when enabled for the [mode](/webui/chats/modes), `write_file`, `replace_in_file` and others.

## Buttons

| Button | What it does |
|---|---|
| **Save / Load** | Keep several named projects in the browser and switch between them |
| **Export / Import** | Download the project as a compressed archive, or restore one |
| **Clear** | Remove all files from the project |
| Drag and drop | Upload files from your computer |

Export before clearing site data or switching browsers: the project is not stored anywhere else.

## Editing together with the agent

If a file changed since you opened it (the agent or another browser tab wrote it) and you press **Save**, FreeGent asks whether to overwrite the newer file, so an edit never silently undoes the agent's work.

## Special files

Writing these paths has an effect:

| Path | Effect |
|---|---|
| `AGENTS.md` | Loaded as project instructions for the agent |
| `skills/<name>/SKILL.md` | Adds a [skill](/harness/skills); the list reloads when the file is written |
| `roles/*` | Adds or changes a [role](/harness/roles) |
| `fg-tasks/*.md` | Tasks shown on the [board](/webui/tasks) |

See [Media and previews](/webui/project/media) for how each file type opens.
