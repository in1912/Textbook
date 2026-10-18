#!/usr/bin/env python3
"""Generate first-page JPG thumbnails next to every PDF.

The textbook system shows folder-level cover grids; it reads <same-name>.jpg
next to each PDF, so this script is a one-off preparation step (idempotent).

Usage:
  python scripts/make-thumbs.py [--root BOOK_DIR] [--width 480] [--jobs 4]

Skips the "学数学最重要的刷习题在这里" folder by default (user request).
Existing JPGs are never overwritten unless --force is given.
"""
import argparse
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

SKIP_TOPS = {"学数学最重要的刷习题在这里"}


def list_pdfs(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        top = rel.split(os.sep)[0]
        if top in SKIP_TOPS:
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if d not in SKIP_TOPS]
        for fn in filenames:
            if fn.lower().endswith(".pdf"):
                out.append(os.path.join(dirpath, fn))
    return out


def render_one(args):
    pdf_path, width, quality, force = args
    jpg_path = os.path.splitext(pdf_path)[0] + ".jpg"
    if not force and os.path.exists(jpg_path) and os.path.getsize(jpg_path) > 0:
        return ("skip", pdf_path, 0)
    try:
        import pymupdf  # noqa: F401
    except ImportError:  # older installs
        import fitz as pymupdf
    try:
        doc = pymupdf.open(pdf_path)
        if doc.page_count == 0:
            return ("empty", pdf_path, 0)
        page = doc.load_page(0)
        zoom = width / max(1.0, page.rect.width)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        # PyMuPDF infers the codec from the filename and takes the quality as
        # jpg_quality; the temp file must still end in .jpg for that to work.
        tmp = jpg_path + ".tmp.jpg"
        pix.save(tmp, jpg_quality=quality)
        os.replace(tmp, jpg_path)
        n = os.path.getsize(jpg_path)
        doc.close()
        return ("ok", pdf_path, n)
    except Exception as e:  # keep going; report at the end
        return ("fail", pdf_path, str(e))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.join(os.path.dirname(__file__), "..", "book"))
    ap.add_argument("--width", type=int, default=480)
    ap.add_argument("--quality", type=int, default=72)
    ap.add_argument("--jobs", type=int, default=max(1, min(4, (os.cpu_count() or 2) // 2)))
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    if not os.path.isdir(root):
        sys.exit("book root not found: " + root)
    pdfs = list_pdfs(root)
    print(f"{len(pdfs)} PDFs under {root} (skipping {', '.join(SKIP_TOPS)})", flush=True)
    t0 = time.time()
    done = skip = fail = total_bytes = 0
    failures = []
    with ProcessPoolExecutor(max_workers=a.jobs) as ex:
        futs = [ex.submit(render_one, (p, a.width, a.quality, a.force)) for p in pdfs]
        for i, f in enumerate(as_completed(futs), 1):
            kind, path, info = f.result()
            if kind == "ok":
                done += 1
                total_bytes += info
            elif kind == "skip":
                skip += 1
            else:
                fail += 1
                failures.append((path, info))
            if i % 50 == 0 or i == len(pdfs):
                print(f"[{i}/{len(pdfs)}] new={done} skip={skip} fail={fail} "
                      f"{time.time() - t0:.0f}s", flush=True)
    print(f"done: new={done} skip={skip} fail={fail} "
          f"new_bytes={total_bytes / 1048576:.1f}MB elapsed={time.time() - t0:.0f}s", flush=True)
    for p, e in failures[:50]:
        print("FAIL", p, e, flush=True)
    if failures:
        with open(os.path.join(os.path.dirname(__file__), "make-thumbs-failures.txt"), "w", encoding="utf-8") as f:
            for p, e in failures:
                f.write(f"{p}\t{e}\n")


if __name__ == "__main__":
    main()
