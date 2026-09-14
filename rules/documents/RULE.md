---
name: documents
description: Working with PDFs, Office documents, and forms. Covers text extraction, form field reading, and table/figure extraction. Auto-injected when PDF or document files are involved.
trigger: pdf, PDF, .pdf, read pdf, extract text, form field, radio button, checkbox, xlsx, docx, pptx, odt, survey form, quiz, exam, spreadsheet
trigger_on_filetype: .pdf, .xlsx, .xls, .docx, .pptx, .odt, .ods
roles: coder, researcher, director, agent
---

## PDFs — never use read_file directly

`read_file` on a `.pdf` returns binary garbage. Always extract text first via `execute_code`.

### Extract all text (fastest)

```python
import fitz  # pymupdf — pre-installed
doc = fitz.open("file.pdf")
text = "\n".join(page.get_text() for page in doc)
print(text[:3000])
```

### Extract text page by page

```python
import fitz
doc = fitz.open("file.pdf")
for i, page in enumerate(doc):
    print(f"--- Page {i+1} ---")
    print(page.get_text())
```

### Read PDF form fields (radio buttons, checkboxes, text inputs)

```python
import fitz
doc = fitz.open("file.pdf")
for page in doc:
    for widget in page.widgets():
        print(widget.field_name, widget.field_type_string, widget.field_value)
```

Or with pypdf:

```python
from pypdf import PdfReader
reader = PdfReader("file.pdf")
fields = reader.get_fields()
for name, field in (fields or {}).items():
    print(name, field.get('/V'))  # /V is the current value
```

### Extract tables from PDF

```python
import pdfminer.high_level
text = pdfminer.high_level.extract_text("file.pdf")
```

---

## Excel / spreadsheets

```python
import openpyxl  # pre-installed
wb = openpyxl.load_workbook("file.xlsx")
ws = wb.active
for row in ws.iter_rows(values_only=True):
    print(row)
```

For reading only (faster, handles .xls too):

```python
import pandas as pd
df = pd.read_excel("file.xlsx", sheet_name=0)
print(df.head())
```

## Word / PowerPoint / ODF

```python
from docx import Document          # python-docx, pre-installed
doc = Document("file.docx")
for para in doc.paragraphs:
    print(para.text)

from pptx import Presentation      # python-pptx, pre-installed
prs = Presentation("file.pptx")
for slide in prs.slides:
    for shape in slide.shapes:
        if shape.has_text_frame:
            print(shape.text_frame.text)

import odf.opendocument, odf.text  # odfpy, pre-installed
doc = odf.opendocument.load("file.odt")
for el in doc.getElementsByType(odf.text.P):
    print(str(el))
```

## Rules

- **Never `read_file` a binary document** — use `execute_code` with the appropriate library.
- **For PDFs with form fields** (quizzes, surveys): use `fitz page.widgets()` or `pypdf reader.get_fields()` — do not try to infer selections from text layout or OCR.
- **Check the field value, not the label**: radio buttons store their selected option in `field_value` / `/V`, not in surrounding text.
- **For scanned PDFs** (no text layer): use `fitz page.get_pixmap()` then pass the image to the vision model, or use `pytesseract` if installed.
