FROM python:3.12-slim

WORKDIR /app

# Bake the fastembed model cache into a NON-volume path. The compose service
# mounts `modelcache:/models`; baking under /models would be shadowed at run
# time by that (initially empty) volume, forcing a runtime download on the
# RAM/disk-tight box — the exact trap parser-svc documented for docling. So we
# point HF_HOME + FASTEMBED_CACHE_PATH at /opt/models (disjoint from the /models
# mount) and bake there. Thread caps keep onnxruntime from spinning a thread per
# core on the shared VPS.
ENV HF_HOME=/opt/models/hf \
    FASTEMBED_CACHE_PATH=/opt/models/fastembed \
    OMP_NUM_THREADS=2 \
    ORT_NUM_THREADS=2 \
    INFER_ONNX_THREADS=2

# Install with uv (fast, deterministic resolver) — matches parser-svc's proven
# pattern. fastembed pulls onnxruntime (CPU) + numpy + tokenizers; no torch.
RUN pip install --no-cache-dir uv
COPY requirements.txt .
RUN uv pip install --system --no-cache -r requirements.txt

# Bake the three ONNX models into the image at BUILD time so the first request
# is fast and the box never downloads a model at runtime. Instantiating each
# fastembed class downloads its ONNX artifacts into FASTEMBED_CACHE_PATH
# (/opt/models/fastembed), which is NOT under the mounted volume. The runtime
# app re-instantiates the same classes and reuses these baked files.
# Keep this model set in lockstep with app/main.py's INFER_*_MODEL defaults.
RUN python -c "\
from fastembed import TextEmbedding, SparseTextEmbedding; \
from fastembed.rerank.cross_encoder import TextCrossEncoder; \
TextEmbedding(model_name='BAAI/bge-base-en-v1.5'); \
SparseTextEmbedding(model_name='prithivida/Splade_PP_en_v1'); \
TextCrossEncoder(model_name='Xenova/ms-marco-MiniLM-L-6-v2'); \
print('baked fastembed models')"

COPY app ./app

EXPOSE 8000
# Healthcheck hits /healthz, which does NOT load models (cheap + fast).
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
