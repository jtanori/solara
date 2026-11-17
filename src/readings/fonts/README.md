# PDF fonts

Noto Sans (Latin), from the immutable npm tarball `@fontsource/noto-sans@5.3.0`.
Copyright and SIL Open Font License 1.1 are included in `LICENSE`. These original,
unmodified WOFF assets contain English/Spanish Latin characters, accents,
ñ/ü, degrees, curly punctuation and dashes. They are loaded from local files,
subset/embedded into selectable PDF text, never fetched from a remote URL.
Unsupported scripts are outside the en/es document contract. No web/font cache
contains personal reading content.

SHA-256:

- 400 normal: `18e2e5b23a9bc5e8e636d6c7984b8ac6635aefc1c497ed1c5012f3c637761b91`
- 700 normal: `cac2e44ebc446d5c71a9a16fd5592bf80abf6f56dd564a7b90eb01c5f9d29793`
- 400 italic: `4612e626b2998e42750a4f49f48329a39ddff8a4305fcbdaba016c0dedd9bde7`

The PDF build script copies these and the license next to the isolated worker.
The generated bundle/assets live under ignored `.pdf/`, not in Git.
