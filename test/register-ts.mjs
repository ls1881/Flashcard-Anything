// Loaded with --import so the resolve hook is in place before any test module.
import { register } from "node:module";
register("./ts-hooks.mjs", import.meta.url);
