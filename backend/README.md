# PDF Review Workbench API

Standalone backend service for PDF extraction, rasterization, and per-page review data generation.

## Commands
- `npm run dev`
- `npm run build`
- `npm run start`

## Accessibility auto-detection
- Default engine order is Docling first, then the existing block heuristic fallback.
- Install Docling in the backend Python environment before using production-like tagging detection:
  - Windows: `python -m venv .venv && .\.venv\Scripts\python -m pip install --upgrade pip docling`
  - Linux/macOS: `python3 -m venv .venv && ./.venv/bin/python -m pip install --upgrade pip docling`
- Set `ACCESSIBILITY_AUTO_DETECTION_ENGINE=docling-only` to fail instead of falling back when Docling is unavailable.
- Set `ACCESSIBILITY_AUTO_DETECTION_ENGINE=heuristic` to bypass Docling during local debugging.
