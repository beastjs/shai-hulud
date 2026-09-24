# Shai Hulud

A local GitHub repository crawler built with Beast, Octane, Rspack, and Bun.
Paste a public GitHub repository or folder URL, inspect its `.tsx` and `.ts`
files, and convert TSX to BTSX, TSRX, or both using the live Beast converter.

## Run

```sh
bun install
bun run dev
```

Open http://127.0.0.1:3000. The command starts the UI and a local API on port
8788. The converter is already configured to use
`https://playground.beastjs.workers.dev/api/converter`.

1. Paste a repository or `/tree/<ref>/<folder>` link, or use the ReUI example.
2. Select **Inspect repository** to scan the folder and all its subfolders.
3. Check the files you want to process. **Select all files** selects or clears
   the whole folder, including files hidden by the search filter. Files start
   selected; an empty selection disables conversion.
4. Choose BTSX, TSRX, or both. Leave **Include TypeScript files** checked to
   copy selected `.ts` files unchanged into each selected output tree.
5. Select **Convert selected & save**. Progress, failures, and converter warnings
   appear per output. Select a saved file to preview, copy, or download it.
   Converted rows show source → output line, character, and token counts and
   the converter's explicit Octane compilation result. Compilation failures
   show their error text; missing results are marked as not reported. Copied
   `.ts` files are not compiled. Metrics are taken from the converter response.
   After a run, use **Change file selection** to adjust the current scan's
   selection. After refreshing the page, inspect the repository again to select
   files for a new run.

The app sends public TSX source to the configured converter. It never executes
repository code. Only `.tsx` files are converted; `.ts` files are copied as-is,
and other assets are excluded. Import specifiers and dependencies are not
rewritten or installed by the crawler. Converter output may require further
migration work; compilation warnings are shown without discarding returned code.

## Output

Each run writes to a fresh directory, so earlier results are preserved:

```text
output/<run-id>/
  manifest.json
  responses/
    nested/component.tsx.json
  btsx/
    nested/component.btsx
    types.ts
  tsrx/
    nested/component.tsrx
    types.ts
```

`responses/` contains each JSON API response (and a status/body record for non-JSON errors), including metrics,
diagnostics, and compilation results. `manifest.json` records the source URL,
resolved commit, selected outputs, per-file status, warnings, and failures.
New manifests also retain per-output metrics and Beast/Octane compilation
results. Older runs load metadata from saved responses when the returned code
matches the saved file, so rerunning a conversion is not required.
Paths are relative to the selected GitHub folder. `output/` is gitignored.
Retrying keeps previous responses in a sibling `<filename>.tsx.history/` folder;
`<filename>.tsx.json` is the latest response. A Cloudflare resource-limit error
is reported explicitly and may require changes to the converter's Worker.

Runs process files sequentially, making one converter call per TSX file with
all selected formats. A failed file does not stop subsequent files. Temporary HTTP 429/502/503/504 responses are retried up to three total attempts
with backoff. **Retry unfinished files** reruns failed or cancelled outputs while
keeping successful files. Cancel
aborts the current request and preserves files already saved. Reloading the UI
restores the last run. If the local server restarts during a run, that run is
reported as interrupted; inspect the folder and use **Retry unfinished files** to resume at the pinned commit.

## Configuration

Copy `.env.example` to `.env` to override defaults. Bun loads `.env` automatically.
Restart `bun run dev` after changing settings.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONVERTER_URL` | Live Beast `/api/converter` URL | Complete converter endpoint URL |
| `GITHUB_TOKEN` | Unset | Optional server-only token for a higher GitHub API limit |
| `OUTPUT_DIR` | `output` | Local output root; relative paths resolve from the project |
| `PORT` | `8788` | Local API port; UI proxy uses the same value |

Only public repositories on `github.com` are supported, even if a token is
configured. Repository links use the default branch; folder links resolve
branches, tags, or commits, including refs containing slashes. The crawler
pins a commit before fetching source files. Symlinks and submodules are skipped.
The crawler uses [GitHub's Git Trees API](https://docs.github.com/en/rest/git/trees)
and falls back to subtree traversal if a recursive response is truncated.
Unauthenticated GitHub requests have a low rate limit; the app reports rate-limit
errors and suggests configuring a token. Source files are limited to 2 MB.

The converter contract is:

```sh
curl -X POST https://playground.beastjs.workers.dev/api/converter \
  -H 'Content-Type: application/json' \
  -d '{"code":"export default function A() { return <p>hi</p> }","outputs":["btsx","tsrx"]}'
```

```json
{
  "ok": true,
  "outputs": {
    "btsx": { "code": "p hi", "diagnostics": [] },
    "tsrx": { "code": "export default function Component() @{ <p>hi</p> }" }
  },
  "compilation": { "beast": { "ok": true }, "octane": { "ok": true } }
}
```

## Build and verify

```sh
bun run check  # Type checking, regression tests, production build
bun run start  # Serve dist and the API at http://127.0.0.1:8788
```

The API binds to loopback and is intended for a local workspace. Public hosting,
authentication and scheduled crawls are outside this version.
The server validates output paths and only exposes files recorded as saved in a
run's manifest.

## Code

- `src/App.btsx`: application UI.
- `src/lib/use-crawler.ts`: client state, polling, and output preview.
- `server/github.ts`: URL parsing, ref resolution, recursive discovery, and source reads.
- `server/converter.ts`: live converter request and response handling.
- `server/jobs.ts`: sequential batch processing, cancellation, and local persistence.
- `server/index.ts`: local HTTP API and production asset serving.
- `server/crawler.test.ts`: regression tests using isolated temporary output directories.
