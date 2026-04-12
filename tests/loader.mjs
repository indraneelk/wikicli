/**
 * ESM loader hook for test runs.
 * Remaps .js imports to .ts when the parent module is a .ts file in src/,
 * allowing Node's --experimental-strip-types to resolve TypeScript source files.
 */
import { register } from 'node:module';

const loaderSrc = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && context.parentURL) {
      const parentPath = new URL(context.parentURL).pathname;
      if (parentPath.includes('/src/') && parentPath.endsWith('.ts')) {
        const tsSpecifier = specifier.slice(0, -3) + '.ts';
        try {
          return await nextResolve(tsSpecifier, context);
        } catch {
          // fall through to original specifier
        }
      }
    }
    return nextResolve(specifier, context);
  }
`;

register('data:text/javascript,' + encodeURIComponent(loaderSrc));
