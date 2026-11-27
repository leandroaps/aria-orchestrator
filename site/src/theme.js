// Inlined in <head>: applies the saved theme before the first paint, then
// wires the theme button. The page follows the system theme until the
// visitor picks one. localStorage can throw (private mode, blocked
// storage); the system theme then applies and the button still works for
// the visit.
(() => {
	const root = document.documentElement;
	const KEY = "aria-theme";
	try {
		const saved = localStorage.getItem(KEY);
		if (saved === "light" || saved === "dark") root.dataset.theme = saved;
	} catch {}
	root.classList.add("js");
	const current = () =>
		root.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
	document.addEventListener("DOMContentLoaded", () => {
		const button = document.getElementById("theme-toggle");
		if (!button) return;
		const sync = () => {
			const light = current() === "light";
			button.setAttribute("aria-pressed", String(light));
			button.textContent = light ? button.dataset.labelDark : button.dataset.labelLight;
		};
		button.addEventListener("click", () => {
			root.dataset.theme = current() === "light" ? "dark" : "light";
			try {
				localStorage.setItem(KEY, root.dataset.theme);
			} catch {}
			sync();
		});
		sync();
	});
})();
