#!/bin/sh
# Writes an apt keyring holding ONLY the pinned key from a downloaded key file.
# Usage: pin-apt-key.sh <downloaded key file> <pinned primary fingerprint> <output keyring>
# The download is imported into a throwaway keyring and only the pinned fingerprint is exported, so an extra key slipped
# into the file can never end up trusted by apt. It fails unless the result is exactly one key with that fingerprint.
set -eu
in="$1"; fpr="$2"; out="$3"
tmp="$(mktemp -d)"
trap 'gpgconf --homedir "$tmp" --kill all >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
gpg --homedir "$tmp" --batch --quiet --import "$in" >/dev/null 2>&1 || true
gpg --homedir "$tmp" --batch --export "$fpr" > "$tmp/pinned.gpg" 2>/dev/null || true
keys="$(gpg --homedir "$tmp" --batch --show-keys --with-colons "$tmp/pinned.gpg" 2>/dev/null || true)"
pubs="$(printf '%s\n' "$keys" | awk -F: '$1 == "pub" { n++ } END { print n + 0 }')"
primary="$(printf '%s\n' "$keys" | awk -F: '$1 == "pub" { want = 1; next } want && $1 == "fpr" { print $10; exit }')"
if [ "$pubs" != "1" ] || [ "$primary" != "$fpr" ]; then
  echo "The downloaded key file does not hold the pinned key $fpr; refusing to trust it." >&2
  exit 1
fi
install -m 0644 "$tmp/pinned.gpg" "$out"
