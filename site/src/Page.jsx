// The project page. Rendered to static HTML at build time; no React code
// reaches the browser.

const REPO = "https://github.com/leandroaps/aria-orchestrator";
const SYMBOLS = { done: "✓", "in-progress": "→", next: "○" };
const COMMANDS = ["/plugin marketplace add leandroaps/aria-orchestrator", "/plugin install aria-orchestrator@aria"];

function formatDate(date, locale) {
	return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
		new Date(`${date}T00:00:00Z`),
	);
}

function Controls({ locale, locales, t }) {
	return (
		<nav className="controls" aria-label={t.controls.language}>
			<ul className="languages">
				{locales.map(({ code, path, short, name }) => (
					<li key={code}>
						<a
							href={path}
							hrefLang={code}
							lang={code}
							aria-current={code === locale ? "page" : undefined}
							title={name}
						>
							{short}
						</a>
					</li>
				))}
			</ul>
			<button
				type="button"
				id="theme-toggle"
				data-label-light={t.controls.themeToLight}
				data-label-dark={t.controls.themeToDark}
			>
				{t.controls.themeToLight}
			</button>
		</nav>
	);
}

function Signature() {
	return (
		<header className="hero">
			<img className="logo" src="/aria-mark.svg" width="480" height="432" alt="ARIA — Agentic SDLC Orchestrator" />
			<div className="signature">
				<h1>ARIA</h1>
				<p className="descriptor">Agentic SDLC Orchestrator</p>
				<p className="slogan">Complexity orchestrated.</p>
				<p className="slogan">Simplicity delivered.</p>
			</div>
		</header>
	);
}

function Install({ releases, t }) {
	const latest = releases[0];
	return (
		<section id="install" aria-labelledby="install-title">
			<h2 id="install-title">{t.install.title}</h2>
			<p>{t.install.intro}</p>
			<pre>
				<code>{COMMANDS.join("\n")}</code>
			</pre>
			<p className="note">{latest ? t.install.latest.replace("{tag}", latest.tag) : t.install.prealpha}</p>
			<p>
				<a href={`${REPO}#configuration`}>{t.install.config}</a>
			</p>
		</section>
	);
}

function Status({ status, t }) {
	return (
		<section id="status" aria-labelledby="status-title">
			<h2 id="status-title">{t.status.title}</h2>
			<ol className="phases">
				{status.phases.map(({ id, state }) => (
					<li key={id} data-state={state}>
						<span className="symbol" aria-hidden="true">
							{SYMBOLS[state]}
						</span>
						<span className="id">{id}</span>
						<span className="title">{t.status.phases[id]}</span>
						<span className="state">{t.status.states[state]}</span>
					</li>
				))}
			</ol>
			<p>
				<a href={`${REPO}/blob/main/docs/plan/0001-extraction.md`}>{t.status.plan}</a>
			</p>
		</section>
	);
}

function Releases({ releases, locale, t }) {
	return (
		<section id="releases" aria-labelledby="releases-title">
			<h2 id="releases-title">{t.releases.title}</h2>
			{releases.length === 0 ? (
				<p className="note">{t.releases.empty}</p>
			) : (
				<ul className="releases">
					{releases.map((release) => (
						<li key={release.tag}>
							<a className="tag" href={release.url}>
								{release.tag}
							</a>
							<span className="name">
								{release.name}
								{release.prerelease ? <span className="label"> · {t.releases.prerelease}</span> : null}
							</span>
							<time className="date" dateTime={release.date}>
								{formatDate(release.date, locale)}
							</time>
						</li>
					))}
				</ul>
			)}
			<p>
				<a href={`${REPO}/releases`}>{t.releases.all}</a>
			</p>
		</section>
	);
}

function Footer({ t }) {
	return (
		<footer>
			<ul className="footer-links">
				<li>
					<a href={REPO}>{t.footer.repository}</a>
				</li>
				<li>
					<a href={`${REPO}/blob/main/LICENSE`}>{t.footer.license}</a>
				</li>
			</ul>
			<p className="author">
				<img src="/author-mark.png" srcSet="/author-mark@2x.png 2x" width="32" height="32" alt="" loading="lazy" />
				<span>{t.footer.author}</span>
			</p>
		</footer>
	);
}

export function Page({ locale, locales, t, status, releases }) {
	return (
		<>
			<Controls locale={locale} locales={locales} t={t} />
			<main>
				<Signature />
				<Install releases={releases} t={t} />
				<Status status={status} t={t} />
				<Releases releases={releases} locale={locale} t={t} />
			</main>
			<Footer t={t} />
		</>
	);
}
