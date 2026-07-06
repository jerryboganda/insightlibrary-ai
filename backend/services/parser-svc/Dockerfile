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

# Lean CPU-only runtime config. Model artifacts cache to /models (mount a
# volume there in compose) so they survive restarts and never re-download.
ENV OMP_NUM_THREADS=2 \
    HF_HOME=/models \
    DOCLING_ARTIFACTS_PATH=/models \
    PARSE_MAX_PAGES=40

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

EXPOSE 8000
# Healthcheck hits /healthz, which does NOT load models (cheap + fast).
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
