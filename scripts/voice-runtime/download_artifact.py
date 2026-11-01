"""Resumable bounded downloads for pinned public runtime artifacts."""
import argparse
import concurrent.futures
import hashlib
from pathlib import Path
import re
import time
import urllib.parse

import requests

from runtime_common import sha256


def download(url, target, size, digest, workers=8):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if target.stat().st_size == size and sha256(target) == digest:
            return
        raise ValueError("Existing artifact failed integrity check")
    parts = target.with_name(target.name + ".parts")
    parts.mkdir(exist_ok=True)
    chunk = 1024 * 1024
    ranges = [(start, min(start + chunk, size) - 1) for start in range(0, size, chunk)]

    def fetch(bounds):
        start, end = bounds
        path = parts / str(start)
        if path.exists() and path.stat().st_size == end - start + 1:
            return path
        last_error = None
        for attempt in range(3):
            try:
                offset = path.stat().st_size if path.exists() else 0
                if offset == end - start + 1:
                    return path
                if offset > end - start + 1:
                    raise ValueError("Oversized partial artifact")
                begin = start + offset
                separator = "&" if urllib.parse.urlsplit(url).query else "?"
                request_url = url + separator + "shadow_range=" + str(begin)
                with requests.get(request_url, headers={"Range": "bytes=%d-%d" % (begin, end)},
                                  stream=True, timeout=(15, 25)) as response:
                    response.raise_for_status()
                    expected = "bytes %d-%d/%d" % (begin, end, size)
                    if response.status_code != 206 or response.headers.get("Content-Range") != expected:
                        raise ValueError("Unexpected range response: " + str(response.headers.get("Content-Range")))
                    with path.open("ab") as output:
                        for block in response.iter_content(64 * 1024):
                            if output.tell() + len(block) > end - start + 1:
                                raise ValueError("Range exceeds declared size")
                            output.write(block)
                if path.stat().st_size != end - start + 1:
                    raise ValueError("Incomplete range")
                return path
            except (requests.RequestException, ValueError) as error:
                last_error = error
                time.sleep(attempt + 1)
        raise RuntimeError("Range %d failed: %s" % (start, last_error))

    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(fetch, bounds) for bounds in ranges]
        for count, future in enumerate(concurrent.futures.as_completed(futures), 1):
            future.result()
            print("%s: %d/%d ranges, %.1fs" % (target.name, count, len(ranges), time.monotonic() - started), flush=True)
    temporary = target.with_name(target.name + ".verified-partial")
    checksum = hashlib.sha256()
    with temporary.open("wb") as output:
        for start, _ in ranges:
            data = (parts / str(start)).read_bytes()
            checksum.update(data)
            output.write(data)
    if temporary.stat().st_size != size or checksum.hexdigest() != digest:
        raise ValueError("Assembled artifact failed integrity check")
    temporary.replace(target)
    print("Verified SHA256 " + digest, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("target")
    parser.add_argument("size", type=int)
    parser.add_argument("sha256")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    if args.size <= 0 or not re.fullmatch("[0-9a-f]{64}", args.sha256) or not 1 <= args.workers <= 8:
        parser.error("Invalid artifact size, digest or concurrency")
    download(args.url, args.target, args.size, args.sha256, args.workers)
