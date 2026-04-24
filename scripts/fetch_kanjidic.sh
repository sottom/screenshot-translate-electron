#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${ROOT_DIR}/data"
mkdir -p "${DATA_DIR}"

TMP_GZ="${DATA_DIR}/kanjidic2.xml.gz"
OUT_XML="${DATA_DIR}/kanjidic2.xml"

echo "Downloading kanjidic2.xml.gz ..."
URLS=(
  "https://www.edrdg.org/kanjidic/kanjidic2.xml.gz"
  "http://ftp.edrdg.org/pub/Nihongo/kanjidic2.xml.gz"
)
DOWNLOAD_OK=0
for URL in "${URLS[@]}"; do
  if curl -L --fail \
    -H "User-Agent: screenshot-translate-electron/0.1" \
    -o "${TMP_GZ}" "${URL}"; then
    DOWNLOAD_OK=1
    break
  fi
done
if [[ "${DOWNLOAD_OK}" -ne 1 ]]; then
  echo "Failed to download kanjidic2.xml.gz from known URLs." >&2
  exit 1
fi

echo "Extracting to ${OUT_XML} ..."
gunzip -c "${TMP_GZ}" > "${OUT_XML}"
rm -f "${TMP_GZ}"

echo "Done: ${OUT_XML}"
