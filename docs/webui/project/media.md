# Media and previews

The Project tab opens each file type in the way that suits it.

| File | What you see |
|---|---|
| Code, text, JSON, CSV | CodeMirror editor with **Save** and **Download** |
| Markdown | Rendered preview, with an **Edit** toggle |
| HTML, SVG | **Preview** opens the page in a sandboxed pane |
| PNG, JPEG, GIF, WebP, APNG, BMP, ICO, AVIF (HEIC and TIFF where the browser decodes them) | Image preview, with **Download** |
| MP3, WAV, OGG/Opus, M4A, FLAC, AAC, AIFF | Audio player, with **Download** |
| MP4, M4V, WebM, OGV, MOV, MKV, MPEG | Video player, with **Download**. A format the browser cannot play says so and offers the download. |
| PDF | Embedded PDF viewer, with **Download**. A `.pdf` file that contains text instead of a real PDF is shown as text. |
| Excel, OpenDocument sheet (`xlsx`, `xls`, `ods`) | One table per sheet |
| Word (`docx`) | Rendered document |
| PowerPoint (`pptx`), OpenDocument (`odt`, `odp`) | Text of the slides or document; layout and images need the download |
| Old `doc` and `ppt` | Not previewable; **Download** |

Binary files cannot be edited and have no Save button.

Text uploads are stored as UTF-8 text. UTF-16 files with a byte-order mark (Windows "Unicode" exports) and legacy 8-bit text such as Windows-1252 CSVs are converted on upload; a file with NUL bytes that is not UTF-16 is kept as binary, byte for byte. Word and PowerPoint text keeps line breaks, and a PowerPoint's slides are read in the order the presentation shows them.

## HTML previews

Preview runs the page in a sandboxed frame with an opaque origin: it cannot read your keys, chats or the app's DOM. Workspace files that the page references by relative path (images, audio, video, scripts, styles) are inlined so they load. If the page asks for an audio file that is not in the project, a short silent clip is substituted so a missing sound does not break the page.

The agent can load the same page in a hidden sandbox with `check_page`, which reports errors, failed resources and console output without opening a pane.

## Playing audio and video

Open the file for the built-in player, or ask the agent for a page with an `<audio>` or `<video>` element pointing at it and use **Preview**. What plays depends on your browser's codecs.

## Attaching media to a chat

Images go to the model as pixels; PNG, JPEG, GIF and WebP are sent as they are, and other formats (BMP, AVIF, ICO, HEIC, TIFF) are converted to PNG first. A format the browser cannot decode is attached as a file with its project path. Audio and video are sent natively to models that accept them and otherwise noted with their project path. PDF, Word, Excel, PowerPoint and OpenDocument files are read as text. Every attachment is also kept in the project under `attachments/`.

## Images the agent creates

`generate_image` uses Pollinations.ai without a key and falls back to Hugging Face when a key is saved. The result is stored in the project and previewed like any other image.
