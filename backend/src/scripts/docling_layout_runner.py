#!/usr/bin/env python3
import json
import sys
import traceback
from typing import Any, Dict, Iterable, List, Optional, Tuple


def node_text(node: Dict[str, Any]) -> str:
    for key in ("text", "orig", "caption", "name"):
        value = node.get(key)
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())
    return ""


def node_label(node: Dict[str, Any]) -> str:
    value = node.get("label") or node.get("type") or node.get("name") or node.get("content_layer")
    if isinstance(value, dict):
        value = value.get("value") or value.get("name")
    if not isinstance(value, str):
        ref = node.get("self_ref")
        if isinstance(ref, str):
            value = ref.rsplit("/", 1)[-1]
    return str(value or "text").strip()


def walk(value: Any) -> Iterable[Dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def parse_number(value: Any) -> Optional[float]:
    try:
        parsed = float(value)
        if parsed == parsed:
            return parsed
    except Exception:
        return None
    return None


def bbox_values(value: Any) -> Optional[Tuple[float, float, float, float, str]]:
    origin = "top-left"
    if isinstance(value, dict):
        origin_value = value.get("coord_origin") or value.get("origin")
        if isinstance(origin_value, str):
            origin = origin_value.lower()
        candidates = [
            ("l", "t", "r", "b"),
            ("left", "top", "right", "bottom"),
            ("x0", "y0", "x1", "y1"),
            ("x", "y", "w", "h"),
        ]
        for keys in candidates:
            numbers = [parse_number(value.get(key)) for key in keys]
            if all(number is not None for number in numbers):
                x0, y0, third, fourth = numbers  # type: ignore[misc]
                if keys == ("x", "y", "w", "h"):
                    return x0, y0, x0 + third, y0 + fourth, origin
                return x0, y0, third, fourth, origin
    if isinstance(value, (list, tuple)) and len(value) >= 4:
        numbers = [parse_number(entry) for entry in value[:4]]
        if all(number is not None for number in numbers):
            x0, y0, x1, y1 = numbers  # type: ignore[misc]
            return x0, y0, x1, y1, origin
    return None


def extract_page_sizes(payload: Dict[str, Any]) -> Dict[int, Dict[str, float]]:
    pages: Dict[int, Dict[str, float]] = {}
    raw_pages = payload.get("pages")
    if isinstance(raw_pages, dict):
        iterator = raw_pages.items()
    elif isinstance(raw_pages, list):
        iterator = enumerate(raw_pages, start=1)
    else:
        iterator = []
    for key, page in iterator:
        if not isinstance(page, dict):
            continue
        try:
            page_no = int(page.get("page_no") or key)
        except Exception:
            continue
        size = page.get("size") if isinstance(page.get("size"), dict) else page
        width = parse_number(size.get("width")) if isinstance(size, dict) else None
        height = parse_number(size.get("height")) if isinstance(size, dict) else None
        if width and height:
            pages[page_no - 1] = {"width": width, "height": height}
    return pages


def normalize_bbox(raw_bbox: Any, page_size: Optional[Dict[str, float]]) -> Optional[Dict[str, float]]:
    parsed = bbox_values(raw_bbox)
    if not parsed:
        return None
    x0, y0, x1, y1, origin = parsed
    left = min(x0, x1)
    right = max(x0, x1)
    if "bottom" in origin and page_size and page_size.get("height"):
        top = page_size["height"] - max(y0, y1)
        bottom = page_size["height"] - min(y0, y1)
    else:
        top = min(y0, y1)
        bottom = max(y0, y1)
    width = right - left
    height = bottom - top
    if width <= 0 or height <= 0:
        return None
    return {"x": left, "y": top, "w": width, "h": height}


def normalize_items(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    page_sizes = extract_page_sizes(payload)
    seen = set()
    items: List[Dict[str, Any]] = []
    order = 1
    for node in walk(payload):
        prov = node.get("prov")
        if not isinstance(prov, list) or not prov:
            continue
        label = node_label(node)
        text = node_text(node)
        for provenance in prov:
            if not isinstance(provenance, dict):
                continue
            page_no = parse_number(provenance.get("page_no") or provenance.get("page"))
            if page_no is None:
                continue
            page_index = int(page_no) - 1
            raw_bbox = provenance.get("bbox") or node.get("bbox")
            bbox = normalize_bbox(raw_bbox, page_sizes.get(page_index))
            if not bbox:
                continue
            key = (
                page_index,
                label.lower(),
                round(bbox["x"], 2),
                round(bbox["y"], 2),
                round(bbox["w"], 2),
                round(bbox["h"], 2),
                text[:80],
            )
            if key in seen:
                continue
            seen.add(key)
            items.append({
                "pageIndex": page_index,
                "label": label,
                "text": text,
                "bbox": bbox,
                "pageSize": page_sizes.get(page_index),
                "confidence": parse_number(node.get("confidence")),
                "order": order,
            })
            order += 1
    return items


def convert_pdf(source_pdf: str) -> Dict[str, Any]:
    try:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption
    except Exception as error:
        return {
            "engine": "docling",
            "status": "unavailable",
            "message": f"Docling is not installed or cannot be imported: {error}",
            "items": [],
        }

    try:
        pipeline_options = PdfPipelineOptions()
        pipeline_options.do_ocr = False
        pipeline_options.force_backend_text = True
        converter = DocumentConverter(
            format_options={
                InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)
            }
        )
        result = converter.convert(source_pdf)
        document = result.document
        if hasattr(document, "export_to_dict"):
            payload = document.export_to_dict()
        elif hasattr(document, "export_to_json"):
            payload = json.loads(document.export_to_json())
        else:
            return {
                "engine": "docling",
                "status": "failed",
                "message": "Docling document has no export_to_dict/export_to_json method.",
                "items": [],
            }
        return {
            "engine": "docling",
            "status": "ok",
            "items": normalize_items(payload),
        }
    except Exception as error:
        return {
            "engine": "docling",
            "status": "failed",
            "message": str(error),
            "traceback": traceback.format_exc(),
            "items": [],
        }


def main() -> int:
    if len(sys.argv) < 2:
        sys.stdout.buffer.write(json.dumps({
            "engine": "docling",
            "status": "failed",
            "message": "Usage: docling_layout_runner.py <source.pdf>",
            "items": [],
        }, ensure_ascii=False).encode("utf-8"))
        return 2
    sys.stdout.buffer.write(json.dumps(convert_pdf(sys.argv[1]), ensure_ascii=False).encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
