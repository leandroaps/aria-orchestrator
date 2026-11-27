# Project site at aria-orchestrator.dev — design

Date: 2026-11-27
Status: Approved by the owner, 2026-11-27; Revision 1 the same day

## Intent

The ARIA project gets its own home at `https://aria-orchestrator.dev`, a
domain the owner registered on Cloudflare. A visitor should find, on one
page:

1. what ARIA is: the brand signature from the current landing page;
2. how to install it;
3. where the project stands: the plan's phases, which are done, which is in
   progress, and what comes next;
4. the releases.

It replaces the logo-only landing page on GitHub Pages
(`leandroaps.github.io/aria-orchestrator`).

## Goals

- One page with the four blocks above, in English, Brazilian Portuguese
  and Spanish, with a light and a dark theme, in the brand of
  `docs/brand/identity.md`: Midnight, Snow and Violet, Inter with system
  fallbacks, modest headings, no decoration.
- Built with React. The owner asked for React or Next and chose approach A
  below.
- The status and the releases stay current without anyone editing the page
  by hand.
- Hosted on Cloudflare, on the apex domain, with `www` redirecting to it.

## Non-goals

- More than one page: no docs site, blog or search.
- Client-side data fetching, analytics, cookies or forms.
- Moving the plugin's documentation off GitHub. The README stays the
  reference, and the page links to it.

## Anti-goals (a failure even if it works)

- The plugin gains a runtime or development dependency. `package.json` at
  the root keeps no `dependencies`, and `npm test` at the root still needs
  nothing installed.
- The browser makes a request to a third party (GitHub API, font CDN,
  analytics). The brand rule says no external request and no tracking.
- The page says ARIA is installable or released before it is. The install
  block must say plainly that the plugin is pre-alpha until v0.1.0.
- The status shows something that is not true. It comes from the same
  source the project updates when a phase lands, never from copy written
  for the page.

## Approaches considered

- **A. React and Vite, prerendered at build time and served as static
  assets by Cloudflare Workers. Chosen.**
  - Data is read during the build: phases from the repository, releases
    from the GitHub API with the workflow's own token.
  - The visitor gets finished HTML and CSS.
  - A workflow deploys on every push to `main` and whenever a release is
    published, so new releases appear without a server.
  - Costs: a Cloudflare API token stored as a repository secret, and build
    dependencies in a separate package.
- **B. Next.js on Cloudflare (OpenNext or vinext), server-rendered with a
  cached GitHub fetch.**
  - Releases would appear sooner.
  - It needs a runtime, an adapter and more upkeep for one page.
  - The release-triggered deploy in A covers the same need.
- **C. A Node script that writes the HTML, no framework.**
  - The lightest option, with zero dependencies.
  - Not what the owner asked for, and it gives up components if the page
    grows.

## Design

### Where it lives

- The current `site/` folder becomes its own npm package: `site/package.json`
  with its own `package-lock.json`, `"private": true` and Node 24
  (`engines`, reading the root `.nvmrc`). The root `package.json` is
  unchanged.
- The current static files (favicons, manifest, `aria-mark.svg`,
  `og-image.png`) move to `site/public/`. The brand test follows them and
  still checks that each copy equals its source in `assets/brand/`.
- The root `test/**/*.test.mjs` glob does not reach `site/`, so the
  plugin's tests never load site code.

### How the page is built

- Vite with React (`react`, `react-dom`) and `@vitejs/plugin-react`, all as
  dev dependencies of `site/`. TypeScript is the builder's call.
- At build time, the page is rendered to static HTML with
  `react-dom/server`, using Vite's SSR build or an equivalent prerender
  step.
- No React bundle and no hydration reach the browser. The only client code
  is one small inline script for the theme switch (see Revision 1).
- Styles: one CSS file with the brand tokens as custom properties. The
  values come from `assets/brand/brand-tokens.json`, read at build time,
  so the colours have one source.

### Page content, top to bottom

1. **Signature.** Logo, `A R I A`, `AGENTIC SDLC ORCHESTRATOR`,
   `Complexity orchestrated.`, `Simplicity delivered.`, with the same
   colours and sizes as the current landing page. It is shorter than the
   full viewport, so the next blocks are visible.
2. **Install.**
   - The two Claude Code commands from the README
     (`/plugin marketplace add leandroaps/aria-orchestrator` and
     `/plugin install aria-orchestrator@aria`) in a JetBrains Mono block.
   - One line that sets expectations: before v0.1.0, it reads "Pre-alpha:
     not usable yet. v0.1.0 is tagged after real validation." Once a
     release exists, the line names the latest version instead.
   - A link to the README's Configuration section.
3. **Status.**
   - One row per phase of plan 0001 (P0 to P8), with its title and a state
     shown as a word and a symbol from the brand status table: done ✓, in
     progress →, next ○.
   - A link to the plan.
4. **Releases.**
   - Up to the five latest GitHub releases: tag, date, title, and a link
     to the release page.
   - The empty state says no release yet and points to the status block.
   - A link to all releases.
5. **Footer.** See Revision 1.

### Data sources

- **Status: `docs/plan/status.json` (my call).**
  - A small file next to the plan, listing each phase with `id`, `title`
    and `state` (`done`, `in-progress`, `next`).
  - Each phase pull request updates it in the same change that lands the
    phase. It is read at build time.
  - A root test checks it: valid states, exactly one phase in progress or
    none, and that every phase id it lists also appears in
    `docs/plan/0001-extraction.md`.
  - Why not parse the plan's prose: it changes shape too often to be a
    reliable source.
- **Releases.**
  - The build calls `GET /repos/leandroaps/aria-orchestrator/releases` with
    the workflow's `GITHUB_TOKEN`; the repository is public.
  - Drafts are excluded; prereleases are shown and labelled.
  - If the API call fails during a deploy, the build fails rather than
    publishing an empty list.
  - A local build without a token may use an empty list and print a
    warning.

### Hosting and deploy

- **Cloudflare Workers with static assets.** `site/wrangler.jsonc` names
  the Worker (`aria-orchestrator-site`) and serves `site/dist/`. There is
  no Worker script, only assets.
- **Domain.** `aria-orchestrator.dev` is attached to the Worker as a custom
  domain; Cloudflare creates the DNS record and the certificate.
  `www.aria-orchestrator.dev` redirects to the apex, via a second custom
  domain plus a redirect rule. The exact mechanism is the builder's call.
- **Workflow.** `.github/workflows/site.yml` replaces `pages.yml`:
  - triggers: pushes to `main` that touch `site/**`, `docs/plan/status.json`,
    `assets/brand/**` or the workflow itself; `release: published`;
    `workflow_dispatch`;
  - steps: checkout, `setup-node` with `node-version-file: .nvmrc`,
    `npm ci`, build, then `npx wrangler deploy` from `site/`'s own
    dependency;
  - it uses no new third-party action, so the Node 24 action table in
    `test/node-version.test.mjs` does not change.
- **CI.** `ci.yml` gains a job that installs, builds and tests `site/` on
  pull requests, so a broken page is caught before it is merged.
- **Secrets, set by the owner.** `CLOUDFLARE_API_TOKEN` (permission: edit
  Workers scripts on that account; Workers routes or custom domains on the
  zone) and `CLOUDFLARE_ACCOUNT_ID`. The session never sees the values.
- **Retiring GitHub Pages.**
  - Done after the first successful Cloudflare deploy: remove `pages.yml`
    and disable Pages for the repository.
  - Update the Open Graph URLs, the brand test constant, the README and
    `docs/brand/identity.md` to `https://aria-orchestrator.dev/`.
  - Set the repository homepage to the new domain.

### Tests

- **Root (no dependencies):**
  - the brand test follows the files to `site/public/`;
  - `docs/plan/status.json` is checked as described above;
  - the Node 24 test still passes; `site.yml` uses `node-version-file`.
- **`site/` (its own `npm test`, on the built `dist/`):**
  - the HTML contains the four blocks and the signature text;
  - there is no `<script src>`, and no URL to a host other than
    `aria-orchestrator.dev`, `github.com` and `api.github.com` (the last
    only at build);
  - the status rows match `status.json`;
  - the releases block renders the empty state from an empty list and
    renders rows from a fixture list.

## Calls made in the design (the owner can change any of them)

- **Languages.**
  - The page exists in English (`/`, the default), Brazilian Portuguese
    (`/pt-br/`) and Spanish (`/es/`).
  - The owner wrote "es-SP"; this design reads it as Spain Spanish,
    `es-ES`.
  - The brand signature stays in English in every language, as brand copy.
- **Author mark in the footer.** The owner's logo ships at 96 px, both 1x
  and 2x, from `assets/brand/author-mark.png`.
- **Status covers plan 0001 only.** The brand phases of plan 0002 are not
  shown, and sub-parts (P3.1, P3.2) stay inside their phase.
- **Initial status.** P0–P2 done, P3 in progress, P4–P8 next.
- **Status file.** The status lives in `docs/plan/status.json`, not in the
  plan's prose.
- **Separate from P3.** The work goes in its own pull requests:
  1. the site package and the Cloudflare deploy;
  2. retiring GitHub Pages, once the first deploy works.

## Revision 1 (2026-11-27, requested by the owner)

**Controls.** The language and theme controls share one group, in the top
right corner of the page.
- **Language** is a set of three links: `EN`, `PT`, `ES`.
  - Each points to the same page in that language, so it works without
    JavaScript.
  - Each page sets `<html lang>` (`en-US`, `pt-BR`, `es-ES`) and lists the
    other two with `<link rel="alternate" hreflang>`.
  - The current language is marked with `aria-current`.
- **Theme** is a button that switches between light and dark.
  - By default, the page follows `prefers-color-scheme`.
  - The visitor's choice is kept in `localStorage` and applied before the
    first paint by a small inline script in `<head>`, so the page does not
    flash.
  - Without JavaScript, the button is hidden and the system theme applies.
- **Light theme:** Snow background (`#F8FAFC`), Midnight text, Violet
  accents (5.4:1 on Snow).
- **Dark theme:** today's palette.
- The logo is the same in both themes.

**Content in three languages.**
- Every string on the page comes from `site/src/locales/{en-US,pt-BR,es-ES}.json`.
  This includes the headings, the install text, the status words, the phase
  titles (keyed by phase id), the empty states and the footer.
- A site test fails if any locale lacks a key that `en-US` has.
- Release names and tags come from GitHub and are not translated.
- Dates are formatted with `Intl.DateTimeFormat` for the page's locale.

**Author footer.**
- The footer always sits at the bottom of the viewport: on a short page it
  rests at the bottom, and on a long one it follows the content.
- It starts with the owner's logo (`L` monogram), followed by:
  - en-US: `Designed and built with ❤️ by Leandro Aparecido de Siqueira. All rights reserved.`
  - pt-BR: `Projetado e desenvolvido com ❤️ por Leandro Aparecido de Siqueira. Todos os direitos reservados.`
  - es-ES: `Diseñado y desarrollado con ❤️ por Leandro Aparecido de Siqueira. Todos los derechos reservados.`
- The repository and license links stay in the footer, before the author
  line.
- The heart emoji is the owner's explicit choice. It is the one exception
  to the brand's "no emojis" rule, limited to this line.

**Effect on the anti-goals.** The one inline script makes no network
request and reads no third-party resource. The test changes from "no
script tag" to:
- exactly one inline `<script>`, in `<head>`;
- no `src` attribute;
- no `fetch`, `XMLHttpRequest` or URL inside it.

## Owner's tasks

1. Create the Cloudflare API token and add the two secrets to the GitHub
   repository.
2. Approve the pull request that retires GitHub Pages.

## Left to the builder

TypeScript or not; prerender mechanics; component split; exact CSS; how the
`www` redirect is configured; build-time cache of the GitHub response.
