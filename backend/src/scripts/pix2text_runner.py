import json
import sys
import traceback
from pathlib import Path


def write(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def extract_text(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("latex", "text", "formula", "result", "rec_text", "content"):
            text = extract_text(value.get(key))
            if text:
                return text
        return " ".join(filter(None, (extract_text(item) for item in value.values()))).strip()
    if isinstance(value, (list, tuple)):
        return " ".join(filter(None, (extract_text(item) for item in value))).strip()
    return str(value).strip()


def main():
    if len(sys.argv) != 2:
        write({
            "ok": False,
            "status": "failed",
            "engine": "pix2text",
            "error": "Expected one image path argument."
        })
        return 2

    image_path = Path(sys.argv[1])
    if not image_path.is_file():
        write({
            "ok": False,
            "status": "failed",
            "engine": "pix2text",
            "error": f"Image does not exist: {image_path}"
        })
        return 2

    try:
        from pix2text import Pix2Text
    except Exception as exc:
        write({
            "ok": False,
            "status": "unavailable",
            "engine": "pix2text",
            "error": f"Pix2Text is not installed or cannot be imported: {exc}"
        })
        return 0

    try:
        if hasattr(Pix2Text, "from_config"):
            recognizer = Pix2Text.from_config()

            if hasattr(recognizer, "recognize_formula"):
                result = recognizer.recognize_formula(str(image_path), return_text=True)
            elif hasattr(recognizer, "recognize_text_formula"):
                result = recognizer.recognize_text_formula(str(image_path), return_text=True)
            else:
                result = recognizer.recognize(str(image_path), return_text=True)
        else:
            recognizer = Pix2Text()

            if hasattr(recognizer, "recognize_formula"):
                result = recognizer.recognize_formula(str(image_path))
            elif hasattr(recognizer, "recognize"):
                result = recognizer.recognize(str(image_path), return_text=True)
            else:
                result = recognizer(str(image_path))

        latex = extract_text(result)
        write({
            "ok": bool(latex),
            "status": "ok" if latex else "failed",
            "engine": "pix2text",
            "latex": latex,
            "error": None if latex else "Pix2Text returned empty output."
        })
        return 0
    except TypeError:
        try:
            recognizer = Pix2Text()
            result = recognizer.recognize_formula(str(image_path))
            latex = extract_text(result)
            write({
                "ok": bool(latex),
                "status": "ok" if latex else "failed",
                "engine": "pix2text",
                "latex": latex,
                "error": None if latex else "Pix2Text returned empty output."
            })
            return 0
        except Exception:
            write({
                "ok": False,
                "status": "failed",
                "engine": "pix2text",
                "error": traceback.format_exc(limit=8)
            })
            return 1
    except Exception:
        write({
            "ok": False,
            "status": "failed",
            "engine": "pix2text",
            "error": traceback.format_exc(limit=8)
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
