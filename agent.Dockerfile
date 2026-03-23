FROM node:20-slim

# ============================================================
# System tools — required by skill dependencies
# ============================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Python runtime (xlsx, pdf, pptx, docx, brand-guidelines, webapp-testing skills)
    python3 python3-pip python3-venv \
    # PDF utilities: pdftotext, pdfimages, pdftoppm (pdf, docx, pptx skills)
    poppler-utils \
    # PDF merge/split/encrypt (pdf skill)
    qpdf \
    # OCR on scanned PDFs (pdf skill)
    tesseract-ocr \
    # Document text extraction (docx skill)
    pandoc \
    # Jira API integration (project-estimation skill)
    curl jq \
    # Zip file handling
    unzip \
    # LibreOffice for formula recalculation and PDF conversion
    # (xlsx, docx, pptx skills — larger install but enables full functionality)
    libreoffice \
    && rm -rf /var/lib/apt/lists/*

# ============================================================
# Python packages — for xlsx, pdf, pptx, docx, webapp-testing skills
# ============================================================
RUN pip3 install --no-cache-dir --break-system-packages \
    # Excel (xlsx skill)
    pandas openpyxl \
    # PDF processing (pdf skill)
    pypdf pdfplumber reportlab pytesseract pdf2image \
    # PowerPoint (pptx skill)
    "markitdown[pptx]" Pillow python-pptx \
    # Word documents (docx skill, brand-guidelines skill)
    python-docx

# ============================================================
# Global npm packages — for xlsx, docx, pptx, pdf, canvas skills
# ============================================================
RUN npm install -g \
    # Core CLI
    @anthropic-ai/claude-code@latest \
    # Excel reading/writing in Node (xlsx skill — avoids trial-and-error install loop)
    xlsx \
    # Word document generation (docx skill)
    docx \
    # PowerPoint generation (pptx skill)
    pptxgenjs \
    # PDF manipulation (pdf skill)
    pdf-lib \
    # Image processing (canvas-design, slack-gif-creator skills)
    sharp

# Create a workspace directory and assign ownership to the 'node' user
WORKDIR /home/node/app
RUN chown node:node /home/node/app

# ============================================================
# Claude Code settings — Community Edition (single agent only)
# CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is NOT enabled.
# Multi-agent team execution is available in EzCoworker Enterprise.
# ============================================================
RUN mkdir -p /home/node/app/.claude && \
    echo '{}' \
    > /home/node/app/.claude/settings.json && \
    chown -R node:node /home/node/app/.claude

# Copy project-level CLAUDE.md so Claude Code loads it as persistent context
COPY --chown=node:node agent-CLAUDE.md /home/node/app/CLAUDE.md

# Switch to the non-root user 'node' (built-in to this image)
USER node

# Set the entrypoint
ENTRYPOINT ["claude"]
