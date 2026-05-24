import json
import sys
from pathlib import Path

try:
    import joblib
    import numpy as np
    from sklearn.ensemble import GradientBoostingClassifier
    from sklearn.metrics import accuracy_score, precision_recall_fscore_support
    from sklearn.model_selection import train_test_split
except Exception as exc:
    print(f"dependency_error: {exc}")
    sys.exit(1)


def load_fixes(root: Path):
    items = []
    for file in root.rglob("*.json"):
        if "visits" in file.parts:
            continue
        try:
            items.append(json.loads(file.read_text(encoding="utf8")))
        except Exception:
            continue
    return items


def hash_font(name: str) -> float:
    return float(sum(ord(ch) for ch in name) % 1000)


def features(block: dict) -> list[float]:
    styles = block.get("styles") or {}
    text = block.get("text") or ""
    return [
        float(block.get("fontSize", 12)),
        1.0 if block.get("fontWeight") == "bold" else 0.0,
        hash_font(block.get("fontName", "")),
        float(block.get("x", 0)),
        float(block.get("y", 0)),
        float(block.get("w", 0)),
        float(block.get("h", 0)),
        float(len(text)),
        float(len(text.split())),
        1.0 if block.get("isFirstLineIndented") else 0.0,
        float(styles.get("textIndent", 0)),
        float(styles.get("paddingLeft", 0)),
    ]


def build_datasets(fixes):
    tag_x, tag_y, merge_x, merge_y = [], [], [], []
    for fix in fixes:
        before = fix.get("before") or {}
        after = fix.get("after") or {}
        fix_type = fix.get("type")
        if fix_type == "tag-change":
            tag_x.append(features({**before, **after}))
            tag_y.append(after.get("tag", before.get("tag", "p")))
        elif fix_type == "delete":
            tag_x.append(features(before))
            tag_y.append("artifact")
        elif fix_type == "style-change" and (after.get("styles") or {}).get("textIndent", 0) > 0:
            tag_x.append(features({**before, **after, "tag": "p", "isFirstLineIndented": True}))
            tag_y.append("p")
        elif fix_type in {"merge", "split"}:
            merge_x.append(features({**before, **after}))
            merge_y.append(fix_type)
    return (tag_x, tag_y), (merge_x, merge_y)


def train_classifier(xs, ys, output_path: Path, label: str):
    if len(xs) < 20:
        print(f"skip_{label}: insufficient samples ({len(xs)})")
        return None
    X = np.array(xs, dtype=float)
    y = np.array(ys)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    model = GradientBoostingClassifier(random_state=42)
    model.fit(X_train, y_train)
    predictions = model.predict(X_test)
    accuracy = accuracy_score(y_test, predictions)
    precision, recall, _, _ = precision_recall_fscore_support(y_test, predictions, average=None, labels=np.unique(y_test), zero_division=0)
    print(f"{label}_accuracy={accuracy:.4f}")
    for index, class_name in enumerate(np.unique(y_test)):
        print(f"{label}_{class_name}_precision={precision[index]:.4f} recall={recall[index]:.4f}")
    joblib.dump(model, output_path)
    return model


def main():
    if len(sys.argv) != 3:
        print("usage: train_classifiers.py <fixes_root> <models_root>")
        sys.exit(1)
    fixes_root = Path(sys.argv[1])
    models_root = Path(sys.argv[2])
    models_root.mkdir(parents=True, exist_ok=True)
    fixes = load_fixes(fixes_root)
    (tag_x, tag_y), (merge_x, merge_y) = build_datasets(fixes)
    model_a = train_classifier(tag_x, tag_y, models_root / "classifier-a.pkl", "classifier_a")
    model_b = train_classifier(merge_x, merge_y, models_root / "classifier-b.pkl", "classifier_b")
    importance = {
        "classifier_a": getattr(model_a, "feature_importances_", []).tolist() if model_a is not None else [],
        "classifier_b": getattr(model_b, "feature_importances_", []).tolist() if model_b is not None else [],
    }
    (models_root / "importance.json").write_text(json.dumps(importance, indent=2), encoding="utf8")
    print("training_complete")


if __name__ == "__main__":
    main()
