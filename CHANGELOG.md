# Changelog

All notable changes to `shai-hulud` will be recorded here.

## [Unreleased]

- Add a Remote / Local converter switch with a live endpoint check, a
  per-browser local URL override (loopback only), `LOCAL_CONVERTER_URL`, and
  the endpoint recorded in each run's manifest.

- Redesign the workspace as a tray of cards: a progress ring and summary tiles,
  filter tabs, a status bar with legend chips, and a light code preview.

- Show source/output metrics and explicit Octane compilation results in each
  converted file row, persist metadata in manifests, and load older saved results.

- Add repository file checkboxes, select-all with a partial-selection state,
  selected counts, and server-validated conversion of only selected files.

- Replace the starter screen with a GitHub repository conversion workspace.
- Resolve public repository/folder URLs to a commit and recursively discover TSX/TS files.
- Integrate the live Beast converter with BTSX, TSRX, or both in one request per TSX file.
- Save converted code, unchanged TS files, raw JSON responses, and run manifests locally.
- Add progress, cancellation, per-file errors and warnings, search, previews, and downloads.
- Add the local API, development runner, production serving, configuration, and regression tests.
