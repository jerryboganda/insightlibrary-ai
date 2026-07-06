"""inference-svc — CPU inference plane (Phase 5).

Dense embeddings (BGE via fastembed/ONNX), sparse embeddings, reranking
(bge-reranker ONNX), and STT (faster-whisper). Models are downloaded once
into the `modelcache` volume mounted at /models.
"""

from fastapi import FastAPI, status
from fastapi.responses import JSONResponse

app = FastAPI(title="inference-svc", version="0.1.0")


def _not_implemented(feature: str) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        content={"error": f"{feature} is implemented in Phase 5"},
    )


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok", "service": "inference-svc"}


@app.post("/embed/dense")
def embed_dense_stub() -> JSONResponse:
    return _not_implemented("dense embedding")


@app.post("/embed/sparse")
def embed_sparse_stub() -> JSONResponse:
    return _not_implemented("sparse embedding")


@app.post("/rerank")
def rerank_stub() -> JSONResponse:
    return _not_implemented("rerank")


@app.post("/transcribe")
def transcribe_stub() -> JSONResponse:
    return _not_implemented("transcription")
