/**
 * Node's type stripper runs TypeScript directly but does not change module
 * resolution, so `import { x } from "./llm"` inside lib/*.ts fails: on disk it
 * is `llm.ts`. Retry a failed relative specifier with the extension, so tests
 * can import any lib module without the source carrying test-only extensions.
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith(".") && err?.code === "ERR_MODULE_NOT_FOUND") {
      return next(`${specifier}.ts`, context);
    }
    throw err;
  }
}
