// Serves the static site and sends www to the apex. It runs before the
// assets (run_worker_first), so a www request for an existing file is still
// redirected.

const APEX = "aria-orchestrator.dev";

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.hostname === `www.${APEX}`) {
			return Response.redirect(`https://${APEX}${url.pathname}${url.search}`, 301);
		}
		return env.ASSETS.fetch(request);
	},
};
