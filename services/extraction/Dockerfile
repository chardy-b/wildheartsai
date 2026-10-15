FROM python:3.12-slim AS gateway
WORKDIR /app
RUN pip install --no-cache-dir httpx==0.28.1
COPY services/extraction/gateway.py ./
USER 1000:1000
CMD ["python", "-B", "gateway.py"]

FROM python:3.12-slim AS worker
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=1 HOME=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils && rm -rf /var/lib/apt/lists/*
COPY services/extraction/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu && pip install --no-cache-dir -r /app/requirements.txt
WORKDIR /app
# Model assets are acquired separately before image build. No patient input goes into layers.
COPY services/extraction/models/pii /models/pii
COPY services/extraction/*.py ./
USER 1000:1000
CMD ["python", "-B", "worker.py"]

# Optional offline neural OCR layer, reusing the pinned base worker dependencies.
FROM worker AS worker-neural
USER root
COPY services/extraction/requirements-ocr.txt /app/requirements-ocr.txt
RUN pip install --no-cache-dir -r /app/requirements-ocr.txt
USER 1000:1000
