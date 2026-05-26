import json
import sys
from pathlib import Path


def normalize_line(item):
    if not isinstance(item, (list, tuple)) or len(item) < 2:
        return None
    points = item[0]
    payload = item[1]
    if not isinstance(points, (list, tuple)) or not isinstance(payload, (list, tuple)) or len(payload) < 2:
        return None
    xs = [float(point[0]) for point in points if isinstance(point, (list, tuple)) and len(point) >= 2]
    ys = [float(point[1]) for point in points if isinstance(point, (list, tuple)) and len(point) >= 2]
    if not xs or not ys:
        return None
    text = str(payload[0]).strip()
    if not text:
        return None
    confidence = float(payload[1])
    x_min = min(xs)
    y_min = min(ys)
    x_max = max(xs)
    y_max = max(ys)
    return {
        "text": text,
        "x": round(x_min, 2),
        "y": round(y_min, 2),
        "w": round(x_max - x_min, 2),
        "h": round(y_max - y_min, 2),
        "confidence": round(confidence, 4),
        "words": [],
    }


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def main():
    if len(sys.argv) < 4:
        emit({
            "pageIndex": 0,
            "width": 0,
            "height": 0,
            "engine": "paddleocr",
            "status": "failed",
            "averageConfidence": 0,
            "lines": [],
            "message": "Usage: paddle_ocr_runner.py <image_path> <page_index> <width> <height>",
        })
        return

    image_path = Path(sys.argv[1])
    page_index = int(sys.argv[2])
    width = int(float(sys.argv[3]))
    height = int(float(sys.argv[4])) if len(sys.argv) > 4 else 0

    if not image_path.exists():
        emit({
            "pageIndex": page_index,
            "width": width,
            "height": height,
            "engine": "paddleocr",
            "status": "failed",
            "averageConfidence": 0,
            "lines": [],
            "message": f"Image not found: {image_path}",
        })
        return

    try:
        from paddleocr import PaddleOCR
    except Exception as exc:
        emit({
            "pageIndex": page_index,
            "width": width,
            "height": height,
            "engine": "paddleocr",
            "status": "unavailable",
            "averageConfidence": 0,
            "lines": [],
            "message": f"PaddleOCR unavailable: {exc}",
        })
        return

    try:
        ocr = PaddleOCR(
            lang="en",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False
        )
        result = ocr.ocr(str(image_path))
        raw_lines = result[0] if isinstance(result, list) and result else []
        lines = []
        total_confidence = 0.0
        for item in raw_lines:
            normalized = normalize_line(item)
            if normalized is None:
                continue
            total_confidence += normalized["confidence"]
            lines.append(normalized)

        average_confidence = round(total_confidence / len(lines), 4) if lines else 0.0
        emit({
            "pageIndex": page_index,
            "width": width,
            "height": height,
            "engine": "paddleocr",
            "status": "ok",
            "averageConfidence": average_confidence,
            "lines": lines,
        })
    except Exception as exc:
        emit({
            "pageIndex": page_index,
            "width": width,
            "height": height,
            "engine": "paddleocr",
            "status": "failed",
            "averageConfidence": 0,
            "lines": [],
            "message": f"PaddleOCR failed: {exc}",
        })


if __name__ == "__main__":
    main()
