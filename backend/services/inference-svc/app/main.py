"""inference-svc — CPU inference plane (Phase 5).

CPU/ONNX-only inference for the hybrid retrieval pipeline, powered by
`fastembed` (onnxruntime under the hood — NO torch). Endpoints:

  * POST /embed/dense   -> 768-dim BGE dense embeddings (BAAI/bge-base-en-v1.5)
  * POST /embed/sparse  -> SPLADE sparse lexical vectors (prithivida/Splade_PP_en_v1)
  * POST /rerank        -> cross-encoder rerank (Xenova/ms-marco-MiniLM-L-6-v2)
  * POST /transcribe    -> 501 stub (faster-whisper deferred to a later phase to
                           keep this image lean)

Memory discipline (shared CPU-only VPS, ~6GB RAM, other prod projects on it):
  * Every model is lazy-loaded on FIRST use and cached in a module global, each
    guarded by its own lock. `/healthz` NEVER loads a model, so the compose
    healthcheck stays cheap.
  * A single global inference lock serializes ALL heavy calls (dense/sparse/
    rerank). This bounds CONCURRENT COMPUTE — no matter how many requests
    arrive in parallel, at most one ONNX graph is executing at a time, so the
    transient activation/arena memory of inference is one model's worth, not N.
    It does NOT bound RESIDENT memory: each model, once loaded, stays cached in
    its global for the process lifetime (no eviction). The hybrid pipeline uses
    all three (dense + sparse on ingest, dense + rerank on search), so in steady
    state all three ONNX models are co-resident and peak RSS is the SUM of their
    loaded weights (+ onnxruntime arenas), not one-at-a-time. Eviction is
    deliberately NOT done: dense + rerank run on every search, so reloading
    between calls would thrash far worse than keeping ~1GB of weights resident.
  * The three baked models are small enough to co-reside on this box: BGE-base
    dense (~0.44GB fp32 ONNX), SPLADE++ sparse (~0.5GB), MiniLM-L6 rerank
    (~0.09GB) — roughly ~1GB of weights plus onnxruntime working set. That fits
    the ~6GB budget alongside parser-svc's docling. Size the box for all three
    co-resident, NOT for one model at a time. Verify actual RSS (all three
    loaded, parser-svc up) before trusting the budget on a smaller box.
  * Batch sizes are capped (INFER_MAX_BATCH, default 32) so a single request's
    transient activation memory can't balloon under the lock.
  * OMP / ONNX intra-op threads are pinned low (see env below) so onnxruntime
    doesn't spin a thread per core and blow the CPU/RAM budget.

Model cache: models are BAKED into the image at build time (see Dockerfile)
under FASTEMBED_CACHE_PATH. That path (default /opt/models/fastembed) is
deliberately OUTSIDE the compose `modelcache:/models` volume — a mounted
volume would shadow the baked files with an empty dir and force a runtime
download on the RAM-tight box (the exact trap parser-svc documented for
docling). Keep the baked path and the mount path disjoint.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any, List, Optional

from fastapi import FastAPI, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("inference-svc")

# ---------------------------------------------------------------------------
# Lean runtime knobs (env-overridable). Read once at import; cheap.
# ---------------------------------------------------------------------------
# Pin thread counts BEFORE onnxruntime is imported (via fastembed) so it picks
# them up. Low counts keep CPU/RAM bounded on the shared box.
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("ORT_NUM_THREADS", "2")

# Model ids. Overridable via env so the baked set and the runtime set stay in
# lockstep (the Dockerfile bakes exactly these).
DENSE_MODEL = os.environ.get("INFER_DENSE_MODEL", "BAAI/bge-base-en-v1.5")
SPARSE_MODEL = os.environ.get("INFER_SPARSE_MODEL", "prithivida/Splade_PP_en_v1")
RERANK_MODEL = os.environ.get("INFER_RERANK_MODEL", "Xenova/ms-marco-MiniLM-L-6-v2")

# Dense embedding dimension MUST match chunks.vector(768) and the existing
# gemini-768 frontend. BGE-base-en-v1.5 is 768-dim; asserted at load time.
DENSE_DIM = int(os.environ.get("INFER_DENSE_DIM", "768"))

# Cap batch size so a pathological request can't balloon resident memory.
MAX_BATCH = int(os.environ.get("INFER_MAX_BATCH", "32"))
# ONNX intra-op thread count passed to fastembed (also bounded above via env).
ONNX_THREADS = int(os.environ.get("INFER_ONNX_THREADS", "2"))

app = FastAPI(title="inference-svc", version="0.1.0")

# Lazily-initialized models + per-model construction locks. Each loaded model
# stays cached in its global for the process lifetime (no eviction), so in
# steady state all three are co-resident (see the module docstring's memory
# note). A SINGLE inference lock then serializes all heavy calls so only one
# ONNX graph EXECUTES at a time — it bounds concurrent compute, NOT resident
# memory.
_dense: Any = None
_sparse: Any = None
_reranker: Any = None
_dense_lock = threading.Lock()
_sparse_lock = threading.Lock()
_reranker_lock = threading.Lock()
_inference_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Lazy model loaders (each cached in a module global).
# ---------------------------------------------------------------------------
def _get_dense() -> Any:
    global _dense
    if _dense is None:
        with _dense_lock:
            if _dense is None:
                logger.info("loading dense model %s (first use)", DENSE_MODEL)
                from fastembed import TextEmbedding

                _dense = TextEmbedding(model_name=DENSE_MODEL, threads=ONNX_THREADS)
    return _dense


def _get_sparse() -> Any:
    global _sparse
    if _sparse is None:
        with _sparse_lock:
            if _sparse is None:
                logger.info("loading sparse model %s (first use)", SPARSE_MODEL)
                from fastembed import SparseTextEmbedding

                _sparse = SparseTextEmbedding(
                    model_name=SPARSE_MODEL, threads=ONNX_THREADS
                )
    return _sparse


def _get_reranker() -> Any:
    global _reranker
    if _reranker is None:
        with _reranker_lock:
            if _reranker is None:
                logger.info("loading reranker %s (first use)", RERANK_MODEL)
                from fastembed.rerank.cross_encoder import TextCrossEncoder

                _reranker = TextCrossEncoder(
                    model_name=RERANK_MODEL, threads=ONNX_THREADS
                )
    return _reranker


# ---------------------------------------------------------------------------
# Request models.
# ---------------------------------------------------------------------------
class DenseRequest(BaseModel):
    texts: List[str]
    # bge does not need a query/passage prefix, but expose the flag for future
    # models that do (and so callers can be explicit about intent).
    is_query: bool = False


class SparseRequest(BaseModel):
    texts: List[str]


class RerankRequest(BaseModel):
    query: str
    documents: List[str]
    top_k: Optional[int] = None


def _err(msg: str, code: int = status.HTTP_400_BAD_REQUEST) -> JSONResponse:
    return JSONResponse(status_code=code, content={"error": msg})


def _cap_batch(texts: List[str]) -> Optional[JSONResponse]:
    """Reject empty / over-large batches up front (bounds peak RAM)."""
    if not texts:
        return _err("texts must be a non-empty list")
    if len(texts) > MAX_BATCH:
        return _err(f"batch size {len(texts)} exceeds INFER_MAX_BATCH={MAX_BATCH}")
    return None


# ---------------------------------------------------------------------------
# Endpoints.
# ---------------------------------------------------------------------------
@app.get("/healthz")
def healthz() -> dict:
    """Cheap liveness — never loads a model."""
    return {"status": "ok", "service": "inference-svc"}


@app.post("/embed/dense")
def embed_dense(req: DenseRequest) -> Any:
    capped = _cap_batch(req.texts)
    if capped is not None:
        return capped
    try:
        model = _get_dense()
        with _inference_lock:
            # fastembed yields numpy arrays; force materialization inside the
            # lock so heavy compute is serialized.
            vectors = [vec.tolist() for vec in model.embed(req.texts)]
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("dense embedding failed")
        return _err(
            f"dense embedding failed: {exc}", status.HTTP_500_INTERNAL_SERVER_ERROR
        )

    if vectors and len(vectors[0]) != DENSE_DIM:
        return _err(
            f"dense model produced {len(vectors[0])}-dim vectors, expected {DENSE_DIM}",
            status.HTTP_500_INTERNAL_SERVER_ERROR,
        )
    return {"vectors": vectors, "dim": DENSE_DIM, "model": DENSE_MODEL}


@app.post("/embed/sparse")
def embed_sparse(req: SparseRequest) -> Any:
    capped = _cap_batch(req.texts)
    if capped is not None:
        return capped
    try:
        model = _get_sparse()
        with _inference_lock:
            out = []
            for sv in model.embed(req.texts):
                # SparseEmbedding carries parallel `indices` / `values` arrays
                # (term-index -> weight). Serialize to plain python lists.
                out.append(
                    {
                        "indices": [int(i) for i in sv.indices.tolist()],
                        "values": [float(v) for v in sv.values.tolist()],
                    }
                )
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("sparse embedding failed")
        return _err(
            f"sparse embedding failed: {exc}", status.HTTP_500_INTERNAL_SERVER_ERROR
        )
    return {"sparse": out, "model": SPARSE_MODEL}


@app.post("/rerank")
def rerank(req: RerankRequest) -> Any:
    if not req.documents:
        return {"results": [], "model": RERANK_MODEL}
    if len(req.documents) > MAX_BATCH:
        return _err(
            f"documents length {len(req.documents)} exceeds INFER_MAX_BATCH={MAX_BATCH}"
        )
    try:
        model = _get_reranker()
        with _inference_lock:
            # rerank returns one relevance score per document, aligned to the
            # input order.
            scores = list(model.rerank(req.query, req.documents))
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("rerank failed")
        return _err(f"rerank failed: {exc}", status.HTTP_500_INTERNAL_SERVER_ERROR)

    ranked = sorted(
        ({"index": i, "score": float(s)} for i, s in enumerate(scores)),
        key=lambda r: r["score"],
        reverse=True,
    )
    if req.top_k is not None and req.top_k >= 0:
        ranked = ranked[: req.top_k]
    return {"results": ranked, "model": RERANK_MODEL}


@app.post("/transcribe")
def transcribe() -> JSONResponse:
    # STT (faster-whisper) is deliberately deferred: the whisper models + their
    # runtime are heavy, and pulling them would bloat this otherwise-lean image.
    # Wired as a 501 stub so the contract exists; a later phase installs
    # faster-whisper and implements it.
    return JSONResponse(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        content={"error": "transcription is deferred to a later phase"},
    )
