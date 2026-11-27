// Entry of the SSR build: render({ locale, status, releases, tokens }) returns
// the full HTML document for one language.

import { renderToStaticMarkup } from "react-dom/server";
import enUS from "./locales/en-US.json";
import esES from "./locales/es-ES.json";
import ptBR from "./locales/pt-BR.json";
import { Page } from "./Page.jsx";
import css from "./styles.css?raw";
import themeScript from "./theme.js?raw";

export const ORIGIN = "https://aria-orchestrator.dev";

export const LOCALES = [
	{ code: "en-US", path: "/", short: "EN", name: "English", og: "en_US" },
	{ code: "pt-BR", path: "/pt-br/", short: "PT", name: "Português (Brasil)", og: "pt_BR" },
	{ code: "es-ES", path: "/es/", short: "ES", name: "Español", og: "es_ES" },
];

const STRINGS = { "en-US": enUS, "pt-BR": ptBR, "es-ES": esES };
const TITLE = "ARIA - Agentic SDLC Orchestrator";

function tokenStyles(tokens) {
	const vars = Object.entries(tokens).map(([name, value]) => `--brand-${name}: ${value};`);
	return `:root { ${vars.join(" ")} }\n${css}`;
}

function Head({ current, t, tokens }) {
	const url = `${ORIGIN}${current.path}`;
	return (
		<head>
			<meta charSet="utf-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1" />
			<title>{TITLE}</title>
			<meta name="description" content={t.description} />
			<meta name="theme-color" content={tokens.midnight} media="(prefers-color-scheme: dark)" />
			<meta name="theme-color" content={tokens.snow} media="(prefers-color-scheme: light)" />
			<link rel="canonical" href={url} />
			{LOCALES.map(({ code, path }) => (
				<link key={code} rel="alternate" hrefLang={code} href={`${ORIGIN}${path}`} />
			))}
			<link rel="alternate" hrefLang="x-default" href={`${ORIGIN}/`} />
			<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
			<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png" />
			<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
			<link rel="manifest" href="/site.webmanifest" />
			<meta property="og:type" content="website" />
			<meta property="og:url" content={url} />
			<meta property="og:title" content={TITLE} />
			<meta property="og:description" content={t.description} />
			<meta property="og:locale" content={current.og} />
			<meta property="og:image" content={`${ORIGIN}/og-image.png`} />
			<meta property="og:image:width" content="1200" />
			<meta property="og:image:height" content="630" />
			<meta property="og:image:alt" content="The ARIA monogram on a midnight background" />
			<meta name="twitter:card" content="summary_large_image" />
			<style dangerouslySetInnerHTML={{ __html: tokenStyles(tokens) }} />
			<script dangerouslySetInnerHTML={{ __html: themeScript }} />
		</head>
	);
}

export function render({ locale, status, releases, tokens }) {
	const current = LOCALES.find((entry) => entry.code === locale);
	if (!current) throw new Error(`unknown locale "${locale}"`);
	const t = STRINGS[locale];
	const markup = renderToStaticMarkup(
		<html lang={locale}>
			<Head current={current} t={t} tokens={tokens} />
			<body>
				<Page locale={locale} locales={LOCALES} t={t} status={status} releases={releases} />
			</body>
		</html>,
	);
	return `<!doctype html>\n${markup}\n`;
}
