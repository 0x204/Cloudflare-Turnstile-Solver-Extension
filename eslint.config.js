import js from "@eslint/js";
import globals from "globals";

export default [
	js.configs.recommended,
	{
		linterOptions: {
			reportUnusedDisableDirectives: "error",
		},
		rules: {
			eqeqeq: "error",
			"no-var": "error",
			"prefer-const": "error",
			"object-shorthand": "error",
		},
	},
	{
		files: ["extension/**/*.js"],
		languageOptions: {
			globals: { ...globals.browser, ...globals.webextensions },
		},
	},
	{
		files: ["extension/shared.js", "extension/content/**/*.js"],
		languageOptions: {
			sourceType: "script",
		},
	},
	{
		files: ["extension/background/**/*.js"],
		languageOptions: {
			globals: globals.serviceworker,
		},
	},
	{
		files: ["test/**/*.js", "eslint.config.js"],
		languageOptions: {
			globals: globals.node,
		},
	},
	{
		files: ["test/e2e/**/*.js"],
		languageOptions: {
			globals: { ...globals.browser, ...globals.webextensions },
		},
	},
];
