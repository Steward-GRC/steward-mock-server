#!/usr/bin/env bash
# Copyright 2026 The Steward Authors
# SPDX-License-Identifier: Apache-2.0
# Fetch the shared ordered-model vectors from go-authz at the commit named in
# src/product/testdata/ordered.SOURCE, write them to src/product/testdata/ordered.json and record
# their SHA-256 in ordered.SOURCE. The fetch is the only network step; ordered.test.ts checks the
# copy offline. To refresh: set `commit:` in ordered.SOURCE to a full commit sha, run
# `task vectors:refresh` (or this script), and commit both files together.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

dir="src/product/testdata"
source_file="${dir}/ordered.SOURCE"
repo="$(sed -n 's/^repo: //p' "${source_file}")"
commit="$(sed -n 's/^commit: //p' "${source_file}")"
path="$(sed -n 's/^path: //p' "${source_file}")"

if [[ ! "${commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "vectors-copy: commit in ${source_file} must be a full 40-character sha." >&2
  exit 1
fi

echo "vectors-copy: fetching ${repo} ${path} at ${commit}."
tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT
gh api -H "Accept: application/vnd.github.raw" "repos/${repo}/contents/${path}?ref=${commit}" >"${tmp}"
mv "${tmp}" "${dir}/ordered.json"
trap - EXIT

if command -v sha256sum >/dev/null 2>&1; then
  sum="$(sha256sum "${dir}/ordered.json" | cut -d' ' -f1)"
else
  sum="$(shasum -a 256 "${dir}/ordered.json" | cut -d' ' -f1)"
fi
out="$(mktemp)"
sed -E "s/^sha256: .*/sha256: ${sum}/" "${source_file}" >"${out}"
mv "${out}" "${source_file}"
echo "vectors-copy: wrote ${dir}/ordered.json (sha256 ${sum})."
