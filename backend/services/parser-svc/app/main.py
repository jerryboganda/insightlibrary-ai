"""parser-svc — stateless file -> canonical JSON parser (Docling, Phase 4).

Canonical output (Phase 4): pages / blocks / tables / figures with reading
order, coordinates, confidence, and per-page thumbnails. AGPL components
(MinerU) are isolated in this container and never linked into insight-core.

Memory discipline (shared CPU-only VPS, ~6GB RAM):
  * The DocumentConverter is lazy-loaded on the FIRST /parse call and cached in
    a module global, so /healthz never triggers a model load and the compose
    healthcheck stays cheap.
  * A module-level lock serializes parses: one document is converted at a time,
    bounding peak RAM regardless of concurrent requests.
  * Docling is configured lean — enrichment / formula / code models OFF, table
    structure ON but in FAST mode, OCR OFF by default, page cap enforced.
"""

from __future__ import annotations

import base64
import io
import logging
import os
import threading
from typing import Any, Optional

from fastapi import FastAPI, File, Form, UploadFile, status
from fastapi.responses import JSONResponse

logger = logging.getLogger("parser-svc")

app = FastAPI(title="parser-svc", version="0.1.0")

# ---------------------------------------------------------------------------
# Lean runtime knobs (env-overridable). Read once at import; cheap.
# ---------------------------------------------------------------------------
# Hard page cap so a pathological 900-page scan can't OOM the box.
PARSE_MAX_PAGES = int(os.environ.get("PARSE_MAX_PAGES", "40"))
# Thumbnail render DPI (low) and longest-side clamp (px).
THUMB_DPI = int(os.environ.get("PARSE_THUMB_DPI", "96"))
THUMB_MAX_SIDE = int(os.environ.get("PARSE_THUMB_MAX_SIDE", "1024"))
# Reject uploads larger than this BEFORE parsing (the page cap does not bound
# pre-parse input size — a huge PDF is otherwise fully buffered twice). 0 = off.
PARSE_MAX_FILE_MB = int(os.environ.get("PARSE_MAX_FILE_MB", "128"))
# Below this page-level confidence a block is flagged low-confidence downstream.
LOW_CONF_THRESHOLD = float(os.environ.get("LOW_CONF_THRESHOLD", "0.4"))
# Bound OpenMP threads so torch/docling don't spin up a thread per core and
# blow the memory/CPU budget on the shared box.
os.environ.setdefault("OMP_NUM_THREADS", "2")
# Cache docling model artifacts alongside the HF cache volume (/models).
os.environ.setdefault("HF_HOME", "/models")
os.environ.setdefault("DOCLING_ARTIFACTS_PATH", os.environ.get("HF_HOME", "/models"))

# Lazily-initialized converter + the lock that serializes parses.
_converter: Any = None
_converter_lock = threading.Lock()
_parse_lock = threading.Lock()


def _build_converter() -> Any:
    """Construct a lean, CPU-only DocumentConverter.

    Table structure stays ON (we want table extraction) but in FAST mode so
    the expensive cell-matching pass doesn't explode RAM. Enrichment models
    (formula, code, picture classify/describe) are all left OFF. OCR is OFF by
    default and toggled per-request via `do_ocr`.
    """
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions

    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = False
    pipeline_options.do_table_structure = True
    # FAST mode: skip the costly cell-matching pass that balloons memory.
    try:
        pipeline_options.table_structure_options.do_cell_matching = False
        from docling.datamodel.pipeline_options import TableFormerMode

        pipeline_options.table_structure_options.mode = TableFormerMode.FAST
    except Exception:  # pragma: no cover - defensive across docling versions
        logger.warning("could not set FAST table mode; using docling defaults")
    # Disable enrichment / formula / code models (best-effort across versions).
    for attr in (
        "do_formula_enrichment",
        "do_code_enrichment",
        "do_picture_classification",
        "do_picture_description",
    ):
        if hasattr(pipeline_options, attr):
            setattr(pipeline_options, attr, False)
    # We DO want page images (for thumbnails). Ask docling to keep them.
    # NOTE: this renders + retains a full PIL image per page (up to the page
    # cap) regardless of the per-request want_thumbnails flag, so keep the
    # render scale as low as thumbnails allow to bound resident RGB bitmaps on
    # the 6GB box. Thumbnails do not need >1x; clamp scale to 1.0.
    pipeline_options.generate_page_images = True
    pipeline_options.generate_picture_images = True
    try:
        pipeline_options.images_scale = 1.0
    except Exception:  # pragma: no cover
        pass

    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)
        }
    )


def _get_converter() -> Any:
    """Return the process-global converter, building it on first use."""
    global _converter
    if _converter is None:
        with _converter_lock:
            if _converter is None:
                logger.info("loading DocumentConverter (first /parse call)")
                _converter = _build_converter()
    return _converter


@app.get("/healthz")
def healthz() -> dict:
    # Intentionally does NOT touch _get_converter(): the healthcheck must not
    # load models. `converter_loaded` just reports whether a parse warmed it.
    return {
        "status": "ok",
        "service": "parser-svc",
        "converter_loaded": _converter is not None,
    }


# ---------------------------------------------------------------------------
# Docling document -> canonical ParsedDoc mapping.
# ---------------------------------------------------------------------------

# Docling DocItemLabel -> our BlockKind.
_HEADING_LABELS = {"section_header", "title", "page_header", "subtitle"}
_LIST_LABELS = {"list_item", "list"}
_CAPTION_LABELS = {"caption"}


def _kind_for_label(label: str) -> str:
    label = (label or "").lower()
    if label in _HEADING_LABELS:
        return "heading"
    if label in _LIST_LABELS:
        return "list"
    if label in _CAPTION_LABELS:
        return "caption"
    return "text"


def _page_dims(page: Any) -> tuple[Optional[float], Optional[float]]:
    """Best-effort (width, height) from a docling PageItem."""
    size = getattr(page, "size", None)
    if size is not None:
        w = getattr(size, "width", None)
        h = getattr(size, "height", None)
        if w is not None and h is not None:
            return float(w), float(h)
    return None, None


def _bbox_top_left(prov: Any, page_height: Optional[float]) -> Optional[list]:
    """Extract a top-left-origin [x1,y1,x2,y2] bbox from a provenance item.

    Docling bboxes carry a coordinate origin (BOTTOMLEFT for PDF native).
    Normalize to top-left so the FE renders overlays consistently.
    """
    bbox = getattr(prov, "bbox", None)
    if bbox is None:
        return None
    try:
        # Prefer docling's own conversion when we know the page height.
        if page_height is not None and hasattr(bbox, "to_top_left_origin"):
            tl = bbox.to_top_left_origin(page_height=page_height)
            return [float(tl.l), float(tl.t), float(tl.r), float(tl.b)]
        origin = getattr(bbox, "coord_origin", None)
        left = float(getattr(bbox, "l"))
        right = float(getattr(bbox, "r"))
        top = float(getattr(bbox, "t"))
        bottom = float(getattr(bbox, "b"))
        if (
            page_height is not None
            and origin is not None
            and str(origin).upper().endswith("BOTTOMLEFT")
        ):
            # Flip y about the page height.
            y1 = page_height - top
            y2 = page_height - bottom
            top, bottom = min(y1, y2), max(y1, y2)
        return [left, top, right, bottom]
    except Exception:  # pragma: no cover - never fail a parse on a bad bbox
        return None


def _pil_to_png_b64(image: Any, max_side: int) -> Optional[str]:
    """Downscale a PIL image to <= max_side longest edge and PNG-base64 it."""
    try:
        from PIL import Image  # noqa: F401  (ensures pillow present)

        img = image
        w, h = img.size
        longest = max(w, h)
        if longest > max_side:
            scale = max_side / float(longest)
            img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))))
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:  # pragma: no cover
        logger.warning("thumbnail render failed", exc_info=True)
        return None


def _table_markdown(item: Any, doc: Any) -> Optional[str]:
    """GitHub-flavored markdown for a table item (best-effort)."""
    try:
        if hasattr(item, "export_to_markdown"):
            try:
                return item.export_to_markdown(doc=doc)
            except TypeError:
                return item.export_to_markdown()
    except Exception:  # pragma: no cover
        logger.warning("table markdown export failed", exc_info=True)
    return None


def _page_confidences(result: Any) -> dict[int, float]:
    """Best-effort per-page confidence from the ConversionResult.

    Docling exposes confidence on the *result* (result.confidence /
    result.confidence.pages), NOT on individual DocItems. Map the per-page
    mean_grade (a 0..1 score) onto page numbers so blocks can inherit a real
    confidence instead of a hardcoded constant.
    """
    out: dict[int, float] = {}
    try:
        conf = getattr(result, "confidence", None)
        pages = getattr(conf, "pages", None) if conf is not None else None
        if isinstance(pages, dict):
            for page_no, report in pages.items():
                for attr in ("mean_grade", "mean_score", "score"):
                    val = getattr(report, attr, None)
                    if val is not None:
                        try:
                            out[int(page_no)] = float(val)
                            break
                        except (TypeError, ValueError):
                            continue
    except Exception:  # pragma: no cover - never fail a parse on confidence
        logger.warning("page confidence extraction failed", exc_info=True)
    return out


def _build_parsed_doc(
    result: Any, max_pages: int, want_thumbnails: bool
) -> dict:
    doc = result.document

    # --- pages -------------------------------------------------------------
    pages_out: list[dict] = []
    page_heights: dict[int, Optional[float]] = {}
    page_items = getattr(doc, "pages", {}) or {}
    # docling `pages` is a dict keyed by page_no (1-indexed).
    all_page_nos = sorted(int(k) for k in page_items.keys())
    total_pages = len(all_page_nos)
    page_nos = all_page_nos[:max_pages]
    for page_no in page_nos:
        page = page_items[page_no]
        w, h = _page_dims(page)
        page_heights[page_no] = h
        pages_out.append({"pageNo": page_no, "width": w, "height": h})
    allowed_pages = set(page_nos)
    page_conf = _page_confidences(result)

    # --- blocks ------------------------------------------------------------
    blocks_out: list[dict] = []
    reading_order = 0
    # iterate_items yields (item, level) in document reading order.
    for item, _level in doc.iterate_items():
        label = str(getattr(item, "label", "") or "")
        # Determine the page for this item from its first provenance entry.
        prov_list = getattr(item, "prov", None) or []
        prov = prov_list[0] if prov_list else None
        page_no = int(getattr(prov, "page_no", 0)) if prov is not None else 0
        if page_no not in allowed_pages:
            # Item on a page beyond the cap (or unpageable) — skip so counts
            # stay consistent with the pages we emit.
            if allowed_pages and page_no != 0:
                continue

        cls_name = type(item).__name__
        is_table = cls_name == "TableItem" or label.lower() == "table"
        is_picture = cls_name == "PictureItem" or label.lower() == "picture"

        content = ""
        table_markdown = None
        crop_b64 = None

        if is_table:
            kind = "table"
            table_markdown = _table_markdown(item, doc)
            content = table_markdown or (getattr(item, "text", "") or "")
        elif is_picture:
            kind = "figure"
            content = getattr(item, "caption_text", None) or ""
            if callable(content):
                content = ""
            if want_thumbnails:
                try:
                    img = item.get_image(doc)
                    if img is not None:
                        crop_b64 = _pil_to_png_b64(img, THUMB_MAX_SIDE)
                except Exception:  # pragma: no cover
                    crop_b64 = None
        else:
            kind = _kind_for_label(label)
            content = getattr(item, "text", "") or ""

        content = content.strip() if isinstance(content, str) else ""
        if not content and not is_picture and not is_table:
            continue

        # Confidence is page-level in Docling (not per-item); inherit the
        # page's grade, defaulting to 0.9 when the result carries no grade.
        confidence = page_conf.get(page_no, 0.9)

        block: dict[str, Any] = {
            "kind": kind,
            "page": page_no,
            "readingOrder": reading_order,
            "content": content,
            "bbox": _bbox_top_left(prov, page_heights.get(page_no))
            if prov is not None
            else None,
            "confidence": confidence,
        }
        if table_markdown:
            block["tableMarkdown"] = table_markdown
        if crop_b64:
            block["cropPngBase64"] = crop_b64
        blocks_out.append(block)
        reading_order += 1

    # --- per-page thumbnails ----------------------------------------------
    page_images_out: list[dict] = []
    if want_thumbnails:
        for page_no in page_nos:
            try:
                page = page_items[page_no]
                img = getattr(page, "image", None)
                pil = getattr(img, "pil_image", None) if img is not None else None
                if pil is None:
                    continue
                b64 = _pil_to_png_b64(pil, THUMB_MAX_SIDE)
                if b64:
                    page_images_out.append({"pageNo": page_no, "pngBase64": b64})
            except Exception:  # pragma: no cover - never fail a parse on thumbs
                logger.warning("page thumbnail failed p%s", page_no, exc_info=True)

    text = "\n\n".join(b["content"] for b in blocks_out if b.get("content"))

    return {
        "pages": pages_out,
        "blocks": blocks_out,
        "text": text,
        "pageImages": page_images_out,
        # True total page count BEFORE the cap, so the worker can flag a
        # truncated document (emitted pages < totalPages) rather than silently
        # marking it fully indexed.
        "totalPages": total_pages,
    }


@app.post("/parse")
async def parse(
    file: UploadFile = File(...),
    filename: Optional[str] = Form(None),
    max_pages: Optional[int] = Form(None),
    want_thumbnails: bool = Form(True),
) -> JSONResponse:
    # NOTE: OCR is a deploy-time setting only (the converter is a cached module
    # global built with do_ocr=False). A per-request OCR toggle would force a
    # model reload and break the RAM discipline, so it is intentionally absent.
    name = filename or file.filename or "upload.pdf"
    data = await file.read()
    if not data:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={"error": "empty file"},
        )
    if PARSE_MAX_FILE_MB > 0 and len(data) > PARSE_MAX_FILE_MB * 1024 * 1024:
        size_mb = len(data) / (1024 * 1024)
        del data
        return JSONResponse(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            content={
                "error": (
                    f"file too large: {size_mb:.1f} MB exceeds "
                    f"{PARSE_MAX_FILE_MB} MB limit"
                )
            },
        )

    cap = PARSE_MAX_PAGES
    if max_pages is not None and max_pages > 0:
        cap = min(max_pages, PARSE_MAX_PAGES)

    from docling.datamodel.base_models import DocumentStream

    # Serialize: one document converted at a time to bound peak RAM.
    with _parse_lock:
        try:
            converter = _get_converter()
            source = DocumentStream(name=name, stream=io.BytesIO(data))
            # page_range is 1-indexed inclusive in docling.
            result = converter.convert(
                source,
                max_num_pages=cap,
                page_range=(1, cap),
            )
            parsed = _build_parsed_doc(
                result, max_pages=cap, want_thumbnails=want_thumbnails
            )
        except Exception as exc:  # hard failure -> 422 with an error message
            logger.exception("parse failed for %s", name)
            return JSONResponse(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                content={"error": f"parse failed: {exc}"},
            )
        finally:
            # Release the reader's buffer promptly.
            del data

    return JSONResponse(status_code=status.HTTP_200_OK, content=parsed)
