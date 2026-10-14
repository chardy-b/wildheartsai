"""One-time asset acquisition. Run before processing any document, with no patient input."""
from pathlib import Path
from huggingface_hub import HfApi, snapshot_download

model = "OpenMed/OpenMed-PII-SuperClinical-Small-44M-v1"
target = Path(__file__).parent / "models" / "pii"
revision = HfApi().model_info(model).sha
snapshot_download(model, revision=revision, local_dir=target, allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model", "*.vocab"])
(target / "REVISION").write_text(model + "@" + revision)
