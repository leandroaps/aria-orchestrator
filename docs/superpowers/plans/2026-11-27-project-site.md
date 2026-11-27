# Project Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a one-page project site at `https://aria-orchestrator.dev`, built with React, prerendered at build time and deployed to Cloudflare Workers. The page shows the brand signature, how to install, the project status and the releases.

**Architecture:** `site/` becomes its own npm package.
- Vite compiles a React page through an SSR build.
- A Node build script gathers the data (`docs/plan/status.json`, GitHub releases, brand tokens), renders the page to static HTML with no client JavaScript, and writes `site/dist/`.
- A Worker of a few lines serves `dist/` and redirects `www` to the apex.
- GitHub Actions deploys on pushes to `main` and on published releases.
- GitHub Pages is retired in a second pull request, after the first deploy works.

**Tech Stack:**
- Node 24, `node:test`.
- In `site/` only: `react` and `react-dom` 19.3.1, `vite` 8.4.0, `@vitejs/plugin-react` 6.3.0, `wrangler` 4.169.0.
- JSX in `.jsx` files, no TypeScript (my call: the repository is plain ESM).

**Spec:** `docs/superpowers/specs/2026-11-27-project-site-design.md`

## Global Constraints

- **Root package unchanged.** The root `package.json` keeps no `dependencies` or `devDependencies`, and the root `npm test` needs no install. Site dependencies live only in `site/package.json`, with their own `site/package-lock.json`, as `devDependencies` with exact versions.
- **Node 24 everywhere.** Every workflow uses `actions/setup-node@v5` with `node-version-file: .nvmrc`, and no new third-party action is added. `site/package.json` has `"engines": { "node": ">=24" }`.
- **No requests to other hosts.** The page makes no request to any host other than its own. Links (`<a href>`) may point to `github.com`, and no other external origin appears anywhere in the HTML.
- **One inline script only.** The HTML has exactly one inline `<script>`, in `<head>`, for the theme. It has no `src`, and contains no `fetch`, `XMLHttpRequest` or `http`.
- **Brand.**
  - Colours come from `assets/brand/brand-tokens.json`: Midnight `#0B1020`, Snow `#F8FAFC`, Violet `#7C3AED`.
  - Inter for text and JetBrains Mono for commands, each with system fallbacks; no font is downloaded.
  - The signature has the same copy, colours and sizes as the landing page today: name 28px, violet lines 19.2px at weight 600.
- **Three languages, each a page:**
  - `en-US` at `/`, with `<html lang="en-US">`;
  - `pt-BR` at `/pt-br/`;
  - `es-ES` at `/es/`.
  Strings come from `site/src/locales/<locale>.json`. The brand signature stays in English.
- **Exact copy:**
  - install commands: `/plugin marketplace add leandroaps/aria-orchestrator` and `/plugin install aria-orchestrator@aria`;
  - pre-release line: `Pre-alpha: not usable yet. v0.1.0 is tagged after real validation.`;
  - once a release exists, the line reads `Latest release: <tag>.`;
  - releases empty state: `No release yet. See the status above.`
  - footer: see the spec's Revision 1. The texts are fixed per locale, and the heart is the emoji `❤️`.
- **Domain.** `https://aria-orchestrator.dev/` is the canonical URL; `www.aria-orchestrator.dev` answers 301 to the apex, keeping the path and query.
- **Secrets.** The repository secrets are `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, set by the owner and never read or printed by a session.
- **Pull requests.** They are opened as farofino-bot, following the repository's usual flow.

## Review Focus

- **The GitHub API fails during a deploy** (rate limit, 5xx, network). The build must fail and nothing is deployed. A local build without a token warns and renders the empty state. → Task 3, `fetchReleases` tests.
- **Untidy release data from GitHub.** Drafts and null names occur, and releases arrive out of order or more than five at a time. The page must exclude drafts, fall back to the tag when the name is empty, sort by date (newest first) and keep five. → Task 3.
- **A theme saved in `localStorage` that conflicts with the system theme.** The saved choice wins and is applied before first paint. If `localStorage` throws (private mode), the system theme applies and the button still toggles for the session. → Task 4, a test on the script text plus a manual check.
- **HTML-like text in a release name** (`<script>`). It must appear escaped, never as markup. → Task 4.
- **A malformed `docs/plan/status.json`.** Two phases in progress, an unknown state, or a phase missing from the plan must fail the root tests. → Task 1.
- **A request to `www` with a path and query.** It gets a 301 to the same path and query on the apex, and other hosts are served normally. → Task 5.

---

### Task 1: Project status file

**Files:**
- Create: `docs/plan/status.json`
- Test: `test/status.test.mjs`

**Interfaces:**
- Produces the file shape `{ "plan": "docs/plan/0001-extraction.md", "phases": [{ "id": string, "title": string, "state": "done" | "in-progress" | "next" }] }`, which Task 3 reads.

- [ ] **Step 1: Write the failing test** `test/status.test.mjs`:
  - `"status lists the plan's phases in order"`:
    - the ids are `["P0", …, "P8"]`;
    - for each phase, the plan text contains `**${id} — ${title}.**` verbatim;
  - `"states are valid and at most one phase is in progress"`:
    - every state is in `["done", "in-progress", "next"]`;
    - at most one `in-progress`;
    - no `done` after an `in-progress` or a `next`;
  - `"current status"`: P0–P2 `done`, P3 `in-progress`, P4–P8 `next`.
- [ ] **Step 2:** `node --test test/status.test.mjs`. Expected: FAIL (ENOENT).
- [ ] **Step 3: Create `docs/plan/status.json`** with the titles exactly as in the plan's bold labels:
  - `Scaffold`
  - `Engine`
  - `Config`
  - `CLI`
  - `Hooks`
  - `Skills, agents, workflows`
  - `End-to-end test`
  - `Real validation`
  - `Bernardo migration (separate, later)`
- [ ] **Step 4:** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** "Add the project status file the site reads".

### Task 2: `site/` package and brand assets

**Files:**
- Create: `site/package.json`, `site/package-lock.json` (from `npm install`), `site/.gitignore` (`node_modules/`, `dist/`, `dist-ssr/`, `.wrangler/`)
- Move: `site/{apple-touch-icon.png,aria-mark.svg,favicon-32.png,favicon.svg,icon-192.png,icon-512.png,og-image.png,site.webmanifest}` → `site/public/`
- Delete: `site/index.html` (its content is rebuilt in Task 4)
- Modify: `test/brand.test.mjs`
  - asset paths become `site/public/…`;
  - remove the `landing page: …` test, whose assertions move to Task 4's site tests.
- Modify: `.github/workflows/pages.yml`
  - remove the `push` trigger and keep `workflow_dispatch`;
  - GitHub Pages keeps serving its last deploy until Task 6.

**Interfaces:**
- Produces the `site/package.json` scripts:
  - `"build": "vite build --ssr src/render.jsx --outDir dist-ssr && node scripts/build.mjs"`;
  - `"test": "node --test \"test/**/*.test.mjs\""`;
  - `"deploy": "wrangler deploy"`.
- Also `"type": "module"` and `"private": true`.

- [ ] **Step 1:** Edit `test/brand.test.mjs` to the new paths. Run `npm test`; expected FAIL, because the files are not moved yet.
- [ ] **Step 2:** `git mv` the eight files, delete `site/index.html`, and create `site/package.json` with the exact devDependency versions from the Tech Stack.
- [ ] **Step 3:** `cd site && npm install`. Then run `npm test` at the root. Expected: all pass, and the root `package.json` is unchanged (`git diff package.json` is empty).
- [ ] **Step 4:** Edit `pages.yml`. Run `node --test test/node-version.test.mjs`; expected PASS.
- [ ] **Step 5: Commit** "Turn site/ into its own package and move the brand files to site/public".

### Task 3: Build-time data

**Files:**
- Create: `site/src/data.mjs`
- Test: `site/test/data.test.mjs`

**Interfaces:**
- Produces:
  - `loadStatus(path: string) → { phases: Array<{id, title, state}> }`;
  - `loadTokens(path: string) → { midnight, snow, violet, muted }`, as hex strings from `color.<name>.value`;
  - `normalizeReleases(raw: Array) → Array<{ tag, name, date, url, prerelease }>`:
    - drafts are excluded;
    - `name` falls back to `tag_name`;
    - `date` is `published_at.slice(0, 10)`;
    - sorted by `published_at` descending, at most 5;
  - `fetchReleases({ repo, token, required, fetchImpl = fetch }) → Promise<Array>`:
    - calls `https://api.github.com/repos/${repo}/releases?per_page=20`;
    - sends `Authorization: Bearer ${token}` when a token is set, plus `Accept: application/vnd.github+json` and `User-Agent: aria-site-build`;
    - when not `required` and there is no token, returns `[]` and calls `console.warn` once;
    - when `required`, a missing token, a non-2xx status or a fetch rejection throws an `Error` whose message includes the HTTP status or the cause.

- [ ] **Step 1: Write the failing tests**, using a fake `fetchImpl`:
  - `normalizeReleases`:
    - a draft is dropped;
    - an empty name falls back to the tag;
    - seven releases in mixed order give the five newest, in order;
    - `date` is `"2026-12-01"`;
  - `fetchReleases`:
    - `required` with a 403 rejects with a message containing `403`;
    - `required` without a token rejects;
    - not required without a token resolves to `[]`;
    - a 200 response returns normalized rows, and the request carries the three headers;
  - `loadStatus` reads Task 1's file;
  - `loadTokens` returns `midnight: "#0B1020"`.
- [ ] **Step 2:** `cd site && npm test`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `site/src/data.mjs`.
- [ ] **Step 4:** `cd site && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** "Read the status, brand tokens and releases at build time".

### Task 4: Pages, languages, theme and footer

**Files:**
- Create:
  - `site/src/Page.jsx`;
  - `site/src/render.jsx`;
  - `site/src/styles.css`;
  - `site/src/theme.js`, the inline script source, read as text by the build;
  - `site/src/locales/{en-US,pt-BR,es-ES}.json`;
  - `site/vite.config.mjs`, which adds `@vitejs/plugin-react`;
  - `site/scripts/build.mjs`.
- Create `site/public/author-mark.png` (96 px) and `site/public/author-mark@2x.png` (192 px), resized from `assets/brand/author-mark.png`.
- Test: `site/test/page.test.mjs`, `site/test/locales.test.mjs` and `site/test/dist.test.mjs`.

**Interfaces:**
- Consumes Task 3's functions.
- `LOCALES = [{ code: "en-US", path: "/" }, { code: "pt-BR", path: "/pt-br/" }, { code: "es-ES", path: "/es/" }]` is exported from `render.jsx`.
- `render({ locale, strings, status, releases, tokens, themeScript }) → string`:
  - returns the full `<!doctype html>` document, using `renderToStaticMarkup`;
  - `<html lang={locale}>`;
  - one `<link rel="alternate" hreflang>` per locale, plus `x-default` pointing to `/`;
  - `<link rel="canonical">` points to the page's own URL.
- `scripts/build.mjs`:
  - imports `../dist-ssr/render.js`;
  - fetches the releases once with `fetchReleases({ repo: "leandroaps/aria-orchestrator", token: process.env.GITHUB_TOKEN, required: process.env.GITHUB_ACTIONS === "true" })`;
  - writes `dist/index.html`, `dist/pt-br/index.html` and `dist/es/index.html`;
  - copies `public/` into `dist/` and removes `dist-ssr/`.
- **Head:**
  - the `<title>`, description (translated), `theme-color`, icons, manifest and the Open Graph and Twitter tags from today's landing page;
  - `og:url` is the page's own URL on `https://aria-orchestrator.dev`, and `og:image` is `https://aria-orchestrator.dev/og-image.png`;
  - `og:locale` is `en_US`, `pt_BR` or `es_ES`;
  - `styles.css` is inlined in a `<style>` tag;
  - the `themeScript` is inlined in a `<script>` tag.
- **Theme:**
  - `styles.css` defines the dark palette on `:root` and the light palette under `:root[data-theme="light"]` and `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) }`, using values built from `tokens`;
  - `theme.js` runs in `<head>`:
    - reads `localStorage["aria-theme"]` inside `try`;
    - sets `document.documentElement.dataset.theme` when the value is `"light"` or `"dark"`;
    - adds the class `js`;
    - on `DOMContentLoaded`, wires the button `#theme-toggle` to flip the theme, set `aria-pressed`, save inside `try`, and update its label from its `data-label-light` and `data-label-dark` attributes;
  - the button is hidden unless `html.js`.
- **Layout:**
  - `<body>` is a column flex container with `min-height: 100dvh`, so the footer always sits at the bottom;
  - `<nav class="controls">`, fixed to the top right, holds the language links (`EN`, `PT`, `ES`, with `aria-current="page"` on the current one) and the theme button.
- **Sections:**
  - `<header>`: the signature;
  - `<section id>` for `install`, `status` and `releases`, with the content and links from the spec;
  - status rows: the translated title and state word, plus the symbol (done `✓`, in-progress `→`, next `○`);
  - release dates: `Intl.DateTimeFormat(locale, { dateStyle: "medium" })`.
- **`<footer>`:**
  - the repository and license links;
  - then the author line: `<img src="/author-mark.png" srcset="/author-mark@2x.png 2x" width="32" height="32" alt="">` followed by the locale's footer text.
- **Locale JSON keys:**
  - `description`, `install.title`, `install.prealpha`, `install.latest` (with `{tag}`), `install.config`;
  - `status.title`, `status.states.{done,in-progress,next}`, `status.phases.P0`…`P8`, `status.plan`;
  - `releases.title`, `releases.empty`, `releases.prerelease`, `releases.all`;
  - `footer.repository`, `footer.license`, `footer.author`;
  - `controls.language`, `controls.themeToLight`, `controls.themeToDark`.

- [ ] **Step 1: Write the failing tests:**
  - `locales.test.mjs`:
    - `"every locale has every en-US key"`;
    - `"every phase in status.json has a title in every locale"`;
    - `"footer texts are the owner's exact copy"`, for all three locales;
  - `page.test.mjs`, which imports `../dist-ssr/render.js` (`npm test` builds first through `pretest`):
    - `"signature copy"`;
    - `"install shows the commands and the pre-alpha line without releases"`;
    - `"install names the latest release when one exists"`;
    - `"status rows match status.json"`: 9 rows and one `→`;
    - `"releases empty state"`;
    - `"release text is escaped"`;
    - `"html lang, hreflang alternates and canonical per locale"`;
    - `"language links mark the current page"`;
    - `"exactly one inline script, no src, no fetch or URL"`;
    - `"no external origin except github.com links"`;
    - `"footer has the author mark and text"`.
- [ ] **Step 2:** `cd site && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement the files and add `"pretest": "npm run build"` to `site/package.json`. Resize the author mark with `sips -Z 96` and `sips -Z 192`.
- [ ] **Step 4: Write `dist.test.mjs`:**
  - the three `index.html` files exist;
  - every file from `public/` is present in `dist/`;
  - `og:image` points to a file in `dist/`.
- [ ] **Step 5:** Run `cd site && npm test`, expecting PASS. Then open each language in a browser at 1280×800 and 375×667, in both themes. Check:
  - the signature looks as it does today;
  - the controls sit in the top right corner;
  - the footer sits at the bottom of a tall viewport;
  - nothing scrolls sideways;
  - a reload keeps the chosen theme with no flash.
- [ ] **Step 6: Commit** "Render the project page in three languages with light and dark themes".

### Task 5: Worker, deploy and CI

**Files:**
- Create:
  - `site/worker.mjs`;
  - `site/wrangler.jsonc`;
  - `.github/workflows/site.yml`.
- Modify: `.github/workflows/ci.yml` (add the `site` job).
- Test: `site/test/worker.test.mjs`.

**Interfaces:**
- `export default { fetch(request, env) }`:
  - when the host is `www.aria-orchestrator.dev`, returns `Response.redirect("https://aria-orchestrator.dev" + pathname + search, 301)`;
  - otherwise returns `env.ASSETS.fetch(request)`.
- `wrangler.jsonc`:
  - `name: "aria-orchestrator-site"`, `main: "worker.mjs"`;
  - `compatibility_date: "2026-11-27"`;
  - `assets: { directory: "dist", binding: "ASSETS", run_worker_first: true }`, so `www` paths that match a file are still redirected;
  - `routes: [{ pattern: "aria-orchestrator.dev", custom_domain: true }, { pattern: "www.aria-orchestrator.dev", custom_domain: true }]`.
- `site.yml`:
  - triggers:
    - `push` to `main` with paths `site/**`, `docs/plan/status.json`, `assets/brand/**` and `.github/workflows/site.yml`;
    - `release: { types: [published] }`;
    - `workflow_dispatch`;
  - `concurrency: { group: site, cancel-in-progress: false }`;
  - permissions: `contents: read`;
  - steps:
    - checkout and setup-node;
    - `npm ci`, `npm run build` and `npm test` with `working-directory: site`;
    - `npx wrangler deploy` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from secrets;
  - the build step gets `GITHUB_TOKEN: ${{ github.token }}`.
- `ci.yml` job `site`: the same install, build and test steps, without deploy.

- [ ] **Step 1: Write the failing test** `worker.test.mjs`:
  - a request to `https://www.aria-orchestrator.dev/a?b=1` returns a 301 with `location` set to `https://aria-orchestrator.dev/a?b=1`;
  - a request to the apex calls a fake `env.ASSETS.fetch` once, with the same request.
- [ ] **Step 2:** `cd site && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement `worker.mjs` and `wrangler.jsonc`. Then run `cd site && npm test`; expected PASS.
- [ ] **Step 4:** Run `npx wrangler deploy --dry-run --outdir /tmp/x` from `site/`. Expected: exit 0, without reaching the network or needing a token. Use the scratchpad directory instead of `/tmp/x`.
- [ ] **Step 5:** Write `site.yml` and the CI job. Run `npm test` at the root; the Node 24 test must still pass, with no new action in the table.
- [ ] **Step 6:** Update the docs:
  - `README.md` Development: `cd site && npm install && npm test`;
  - `docs/brand/identity.md` Landing page section: React, prerendered, Cloudflare, the new URL;
  - `CHANGELOG.md` entry.
- [ ] **Step 7: Commit** "Deploy the project page to Cloudflare Workers", then open PR 1.
  - The PR body lists the owner's tasks: create the token, set the two secrets, and merge.
  - After the merge, watch the `site` run and check:
    - `curl -sI https://aria-orchestrator.dev/` returns 200;
    - `curl -sI https://www.aria-orchestrator.dev/x` returns a 301 to the apex.

### Task 6: Retire GitHub Pages (PR 2, after the first successful deploy)

**Files:**
- Delete: `.github/workflows/pages.yml`
- Modify:
  - `README.md`: the header link becomes `https://aria-orchestrator.dev/`;
  - `docs/brand/identity.md`;
  - `docs/plan/0002-brand-experience.md`: "Outside the repository" names the new host.
- Test: `test/node-version.test.mjs`. It must still pass; the action table loses no entry that other workflows use.

- [ ] **Step 1:** Run `grep -rn "github.io/aria-orchestrator" --exclude-dir=node_modules .`. Expected: matches only in the files above.
- [ ] **Step 2:** Edit them, then run the same grep again. Expected: no matches outside `CHANGELOG.md` history lines.
- [ ] **Step 3:** Run `npm test` at the root and `cd site && npm test`. Expected: PASS.
- [ ] **Step 4:** Commit "Retire GitHub Pages now that the site runs on Cloudflare" and open PR 2.
- [ ] **Step 5:** After the merge:
  - disable Pages: `gh api -X DELETE repos/leandroaps/aria-orchestrator/pages`;
  - set the homepage: `gh repo edit --homepage https://aria-orchestrator.dev`;
  - comment on PR 2 with the results of both commands.
