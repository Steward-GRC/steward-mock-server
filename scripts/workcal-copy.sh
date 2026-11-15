#!/usr/bin/env bash
# Copyright 2026 The Steward Authors
# SPDX-License-Identifier: Apache-2.0
# Fetch the shared working-day cases from steward-workflow at the commit named in
# src/product/testdata/workcal.SOURCE, write them to src/product/testdata/workcal_cases.json and record
# their SHA-256 in workcal.SOURCE. The fetch is the only network step; workcal.test.ts checks the
# copy offline. To refresh: set `commit:` in workcal.SOURCE to a full commit sha, run
# `task workcal:refresh` (or this script), and commit both files together.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

dir="src/product/testdata"
source_file="${dir}/workcal.SOURCE"
repo="$(sed -n 's/^repo: //p' "${source_file}")"
commit="$(sed -n 's/^commit: //p' "${source_file}")"
path="$(sed -n 's/^path: //p' "${source_file}")"

if [[ ! "${commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "workcal-copy: commit in ${source_file} must be a full 40-character sha." >&2
  exit 1
fi

echo "workcal-copy: fetching ${repo} ${path} at ${commit}."
tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT
gh api -H "Accept: application/vnd.github.raw" "repos/${repo}/contents/${path}?ref=${commit}" >"${tmp}"
mv "${tmp}" "${dir}/workcal_cases.json"
trap - EXIT

if command -v sha256sum >/dev/null 2>&1; then
  sum="$(sha256sum "${dir}/workcal_cases.json" | cut -d' ' -f1)"
else
  sum="$(shasum -a 256 "${dir}/workcal_cases.json" | cut -d' ' -f1)"
fi
out="$(mktemp)"
sed -E "s/^sha256: .*/sha256: ${sum}/" "${source_file}" >"${out}"
mv "${out}" "${source_file}"
echo "workcal-copy: wrote ${dir}/workcal_cases.json (sha256 ${sum})."
