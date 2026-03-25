#!/usr/bin/env bash
# First two *.hkx (sorted paths) per top-level character folder; run hkx.py and report skeleton presence.
# Usage:
#   chmod +x scripts/scan-hkx-skeletons.sh
#   ./scripts/scan-hkx-skeletons.sh
#   HKX_ROOT="/path/to/All Characters-..." ./scripts/scan-hkx-skeletons.sh
#   HKX_ROOT="..." OUT_REPORT="/path/to/report.txt" ./scripts/scan-hkx-skeletons.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HKX_PY="${HKX_PY:-$REPO_ROOT/hkx.py}"
HKX_ROOT="${HKX_ROOT:-$REPO_ROOT/All Characters-3027-9-2-1714229500}"
OUT_JSON="${OUT_JSON:-$(mktemp -t hkx_scan_XXXXXX.json)}"
OUT_REPORT="${OUT_REPORT:-$REPO_ROOT/_hkx_skeleton_scan.txt}"

if [[ ! -f "$HKX_PY" ]]; then
	echo "hkx.py not found: $HKX_PY" >&2
	exit 1
fi
if [[ ! -d "$HKX_ROOT" ]]; then
	echo "HKX_ROOT not a directory: $HKX_ROOT" >&2
	exit 1
fi

cleanup() { rm -f "$OUT_JSON"; }
trap cleanup EXIT

{
	printf '%-45s %-12s %s\n' "CHARACTER" "SKELETON" "FILE"
	printf '%s\n' "--------------------------------------------------------------------------------"
	while IFS= read -r -d '' d; do
		char="$(basename "$d")"
		list="$(find "$d" -name '*.hkx' 2>/dev/null | LC_ALL=C sort | head -2)"
		if [[ -z "$list" ]]; then
			printf '%-45s %-12s %s\n' "$char" "N/A" "(no .hkx)"
			continue
		fi
		while IFS= read -r f; do
			[[ -z "$f" ]] && continue
			err="$(mktemp -t hkx_err_XXXXXX)"
			if python3 "$HKX_PY" "$f" "$OUT_JSON" >/dev/null 2>"$err"; then
				if grep -q "WARNING: No skeleton" "$err" 2>/dev/null; then
					skel="no"
				else
					skel="yes"
				fi
			else
				skel="ERROR"
			fi
			rm -f "$err"
			printf '%-45s %-12s %s\n' "$char" "$skel" "$(basename "$f")"
		done <<< "$list"
	done < <(find "$HKX_ROOT" -mindepth 1 -maxdepth 1 -type d -print0 | LC_ALL=C sort -z)
	printf '%s\n' "--------------------------------------------------------------------------------"
	echo "Report also saved to: $OUT_REPORT"
} | tee "$OUT_REPORT"
