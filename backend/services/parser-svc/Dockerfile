FROM python:3.12-slim

# Docling/torch need a couple of native libs for image handling (pillow +
# docling's rendering path). Keep this list minimal: libglib2.0-0 + libgl1
# cover the opencv/pillow runtime deps docling pulls in. curl is only for a
# lightweight healthcheck fallback.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libglib2.0-0 libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Lean CPU-only runtime config. Docling model artifacts cache under HF_HOME
# (/models, a mounted volume) so they survive restarts and download only once.
# Do NOT set DOCLING_ARTIFACTS_PATH: pointing it at the (initially empty)
# volume forces docling into OFFLINE artifacts mode and it errors with
# "Missing safe tensors file" instead of auto-downloading. With only HF_HOME
# set, docling downloads to the HF cache on first use and reuses it thereafter
# (we pre-warm the volume once at deploy so the first real parse is fast).
ENV OMP_NUM_THREADS=2 \
    HF_HOME=/models \
    PARSE_MAX_PAGES=40

# Install with uv, not pip: pip's resolver backtracks exponentially through
# docling's transitive tree (docling-core / docling-ibm-models) and dies with
# ResolutionTooDeep. uv resolves the same tree in seconds. `--torch-backend=cpu`
# routes torch/torchvision to the CPU-only wheels automatically, so the multi-GB
# CUDA wheels are never fetched (critical on the ~6GB shared VPS).
# Verify in the image: python -c "import torch; print(torch.__version__)"  # +cpu
RUN pip install --no-cache-dir uv
COPY requirements.txt .
RUN uv pip install --system --no-cache --torch-backend=cpu -r requirements.txt

# Bake docling's layout + TableFormer models into the image (docling's default
# cache ~/.cache/docling/models, which is NOT a mounted volume so it survives
# container recreates). This makes the first real parse fast and removes any
# runtime model-download / network dependency on the shared box.
RUN python -c "from docling.utils.model_downloader import download_models; download_models()"

COPY app ./app

EXPOSE 8000
# Healthcheck hits /healthz, which does NOT load models (cheap + fast).
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
