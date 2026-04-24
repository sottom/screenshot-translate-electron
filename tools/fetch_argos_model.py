#!/usr/bin/env python3
import json
import sys
import urllib.request
from pathlib import Path

INDEX_URLS = [
    "https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json",
    "https://www.argosopentech.com/argospm/index.json",
]

DEFAULT_HEADERS = {
    "User-Agent": "screenshot-translate-electron/0.1 (+https://github.com/argosopentech/argos-translate)",
    "Accept": "*/*",
}
IPFS_GATEWAYS = [
    "https://ipfs.io/ipfs/{cid}",
    "https://cloudflare-ipfs.com/ipfs/{cid}",
    "https://dweb.link/ipfs/{cid}",
]


def fetch_json(url: str):
    req = urllib.request.Request(url, headers=DEFAULT_HEADERS)
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def parse_version(value):
    parts = []
    for p in str(value or "").replace("-", ".").split("."):
        if p.isdigit():
            parts.append(int(p))
        else:
            digits = "".join(ch for ch in p if ch.isdigit())
            parts.append(int(digits) if digits else 0)
    return tuple(parts or [0])


def candidate_download_urls(pkg):
    urls = []
    direct = pkg.get("url") or pkg.get("download_url")
    if direct:
        urls.append(str(direct))
    for link in pkg.get("links", []) or []:
        if isinstance(link, str):
            urls.append(link)
        elif isinstance(link, dict):
            u = link.get("url") or link.get("href")
            if u:
                urls.append(str(u))
    expanded = []
    for url in urls:
        if url.startswith("ipfs://"):
            cid = url.replace("ipfs://", "").strip("/")
            for gateway in IPFS_GATEWAYS:
                expanded.append(gateway.format(cid=cid))
        else:
            expanded.append(url)
    # Preserve order, drop duplicates.
    seen = set()
    deduped = []
    for url in expanded:
        if url in seen:
            continue
        seen.add(url)
        deduped.append(url)
    return deduped


def download_to_file(url: str, out_file: Path):
    headers = dict(DEFAULT_HEADERS)
    if "argos-net.com" in url:
        headers["Referer"] = "https://www.argosopentech.com/"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as response:
        with out_file.open("wb") as fh:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                fh.write(chunk)


def select_ja_en_package(index_payload):
    if not isinstance(index_payload, list):
        return None
    candidates = []
    for pkg in index_payload:
        if not isinstance(pkg, dict):
            continue
        if pkg.get("from_code") == "ja" and pkg.get("to_code") == "en":
            candidates.append(pkg)
    if not candidates:
        return None
    candidates.sort(
        key=lambda p: (
            parse_version(p.get("package_version")),
            parse_version(p.get("argos_version")),
        ),
        reverse=True,
    )
    return candidates[0]


def main():
    root = Path(__file__).resolve().parent.parent
    out_dir = root / "models"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "translate-ja_en.argosmodel"

    selected_pkg = None
    for index_url in INDEX_URLS:
        try:
            payload = fetch_json(index_url)
            selected_pkg = select_ja_en_package(payload)
            if selected_pkg:
                break
        except Exception as exc:
            print(f"Failed to fetch {index_url}: {exc}", file=sys.stderr)

    if not selected_pkg:
        print("Could not find ja->en Argos package in known indexes.", file=sys.stderr)
        sys.exit(2)

    urls = candidate_download_urls(selected_pkg)
    if not urls:
        print("Selected package had no downloadable URL.", file=sys.stderr)
        sys.exit(3)

    last_err = None
    for url in urls:
        try:
            print(f"Downloading Argos model from {url}")
            download_to_file(url, out_file)
            print(f"Saved model to {out_file}")
            return
        except Exception as exc:
            last_err = exc
            print(f"Failed to download from {url}: {exc}", file=sys.stderr)

    print(f"Unable to download Argos model: {last_err}", file=sys.stderr)
    sys.exit(4)


if __name__ == "__main__":
    main()
