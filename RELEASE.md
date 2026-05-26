# Release Guide

How to ship a new version of the Hermes Browser Extension.

Distribution model: **GitHub Releases sideload** (users download the zip
from the [download page](https://iheytang.github.io/hermes-my-browser-extension/)
and load it unpacked via Chrome's developer mode). No Chrome Web Store
submission — that path is deferred until / if we ever want it.

CI workflow at [`.github/workflows/release.yml`](./.github/workflows/release.yml)
handles the build + upload. The release is fully automated on tag push;
the only manual step is bumping the version + tagging.

## Cutting a release

```bash
# 1. bump version in package.json
$EDITOR package.json               # change "version": "X.Y.Z"

# 2. commit + tag
git commit -am "chore: bump version to vX.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z

# 3. wait ~2-3 min — GitHub Actions builds and creates the release
```

When the workflow finishes, the release is at
`https://github.com/iHeyTang/hermes-my-browser-extension/releases/tag/vX.Y.Z`
with `hermes-extension-vX.Y.Z.zip` attached. The download page
auto-picks it up on next page-load (it queries the GitHub Releases API).

## Smoke test the release zip before announcing

```bash
# Download the asset the CI uploaded
gh release download vX.Y.Z -p '*.zip'
unzip hermes-extension-vX.Y.Z.zip -d /tmp/hermes-ext-test

# Load in Chrome
# - chrome://extensions/
# - Developer mode ON
# - Load unpacked → /tmp/hermes-ext-test
# - Side panel opens, Status tab shows backplane (if running)
```

If smoke test fails, the right move is **delete the GitHub release**,
fix, bump to the next patch version, and re-tag — Chrome users who
already downloaded won't auto-update without manual action anyway, so a
yanked zip just stops new installs.

## Manual build (when you need a local zip without tagging)

```bash
pnpm install --frozen-lockfile
pnpm build
cd build/chrome-mv3-prod && zip -r ../../hermes-extension-dev.zip .
```

Output: `hermes-extension-dev.zip` (about 7 MB).

## Future: swap to a self-hosted artifact registry

The download page reads its release source from a single config block at
the top of [`docs/index.html`](./docs/index.html). To point users at
your own host instead of GitHub Releases:

1. Set up your registry to serve a `latest.json` manifest like:
   ```json
   {
     "version": "0.4.0",
     "released_at": "2026-08-01T12:00:00Z",
     "zip_url": "https://your-host.example.com/hermes-extension-v0.4.0.zip",
     "size_bytes": 7340032,
     "sha256": "..."
   }
   ```
2. In `docs/index.html`, change the `RELEASE_SOURCE` block from
   `type: 'github'` to `type: 'custom'` with `manifestUrl` pointing at
   your `latest.json`.
3. (Optional) Tweak the CI workflow to also push to your registry on
   tag push.

The download page UI doesn't care about the source as long as
`getLatestRelease()` resolves to `{ version, zipUrl, releasedAt, sizeBytes? }`.

## Common gotchas

- **Forgot to bump version in `package.json`** → CI builds but the zip
  inside has the wrong version. Manifest version mismatch surfaces in
  `chrome://extensions/` for sideload users (they'll see the old number
  even after "reload").
- **Bundle size > 10 MB** → Chrome refuses to load. Run
  `du -sh build/chrome-mv3-prod/` before tagging. Usually
  means unbundled fonts or images.
- **Service worker takes too long to register** → Manifest v3 caps SW
  startup at 30s. If hit, lazy-load heavy modules.
- **GitHub Pages 404 on the download page** → After enabling Pages
  (settings → Pages → source = `main` branch, folder = `/docs`), give
  it a minute to publish; check the deploy status in the repo's
  "Environments" tab.
