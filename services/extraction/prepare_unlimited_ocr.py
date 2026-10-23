"""Acquire and audit a pinned public model before serving any private requests."""
import argparse
import hashlib
import json
from pathlib import Path
import re

MODEL = "baidu/Unlimited-OCR"
REVISION = "8249d20b2822a7d8a4c22c8d8c9069b5ac36bda3"
POLICY = "unlimited-ocr/page-gundam-v1"

def digest(path):
    with path.open("rb") as source: return hashlib.file_digest(source, "sha256").hexdigest()

def prepare(target):
    from huggingface_hub import hf_hub_download, snapshot_download
    target = target.resolve()
    if (target / "PREPARED.json").exists():
        verified(target)
        return
    snapshot_download(MODEL, revision=REVISION, local_dir=target,
                      allow_patterns=["*.py", "*.json", "*.safetensors", "LICENSE*", "README.md"])
    # Refresh just this source: a prior interrupted preparation may have patched
    # the local copy without reaching the manifest write. Never patch twice.
    hf_hub_download(MODEL, "modeling_unlimitedocr.py", revision=REVISION, local_dir=target, force_download=True)
    source = target / "modeling_unlimitedocr.py"
    original = source.read_text(encoding="utf-8")
    # Keep page pixels in RAM: the official helper otherwise expects file paths.
    anchor = "def load_image(image_path):"
    if original.count(anchor) != 1 or '"images": [f\'{image_file}\']' not in original:
        raise ValueError("unexpected_model_source")
    patched = original.replace(anchor, anchor + "\n    if isinstance(image_path, Image.Image):\n        return image_path.copy()")
    patched = patched.replace('"images": [f\'{image_file}\']', '"images": [image_file]')
    # Predicted coordinates and plots must never be evaluated as Python code.
    patched = "import ast\n" + re.sub(r"(?<!\.)\beval\(", "ast.literal_eval(", patched)
    source.write_text(patched, encoding="utf-8")
    files = {p.name: digest(p) for p in target.iterdir()
             if p.is_file() and p.suffix in {".py", ".json", ".safetensors"} and p.name != "PREPARED.json"}
    record = {"model": MODEL, "revision": REVISION, "policy": POLICY,
              "original_model_source_sha256": hashlib.sha256(original.encode()).hexdigest(), "files": files}
    (target / "PREPARED.json").write_text(json.dumps(record, sort_keys=True, indent=2), encoding="utf-8")

def verified(target):
    record = json.loads((target / "PREPARED.json").read_text(encoding="utf-8"))
    if (record["model"], record["revision"], record["policy"]) != (MODEL, REVISION, POLICY):
        raise ValueError("unexpected_model_identity")
    required = {"config.json", "tokenizer.json", "modeling_unlimitedocr.py", "modeling_deepseekv2.py",
                "configuration_deepseek_v2.py", "conversation.py", "deepencoder.py", "model.safetensors.index.json"}
    if not required.issubset(record["files"]): raise ValueError("incomplete_model_manifest")
    index = json.loads((target / "model.safetensors.index.json").read_text(encoding="utf-8"))
    if not set(index["weight_map"].values()).issubset(record["files"]): raise ValueError("incomplete_model_weights")
    for name, expected in record["files"].items():
        if Path(name).name != name or digest(target / name) != expected: raise ValueError("model_hash_mismatch")
    return record

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model_dir", type=Path)
    prepare(parser.parse_args().model_dir)
