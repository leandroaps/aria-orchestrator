import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Only used for the SSR build of src/render.jsx; scripts/build.mjs turns
// its output into static pages.
export default defineConfig({
	plugins: [react()],
	build: { emptyOutDir: true },
});
