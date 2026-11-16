/**
 * The CSS-module scoping plugin, shared by the shipping build and the preview
 * harness.
 *
 * Single source on purpose. When the harness stubbed CSS modules to `{}`, every
 * component received `undefined` as its class name and rendered unstyled markup
 * — screenshots that looked plausible and proved nothing. Extracting the plugin
 * means the harness gets byte-identical class hashes and stylesheet injection,
 * and the two can never drift apart again.
 */

import { readFile } from 'node:fs/promises'

/** Short, stable hash of a file path — used to scope CSS module classes. */
export function hashString(value) {
  let hash = 5381
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

/** Only a class selector counts: it must start with a letter and be followed by
 * a name character, and it must not be preceded by a digit or a dot (so `.5rem`
 * in a numeric value is never mistaken for one). */
const CLASS_RE = /(?<![\w.-])\.([A-Za-z_][A-Za-z0-9_-]*)/g

/**
 * Intercept CSS module imports and emit a JS module whose default export maps
 * class names to scoped hashes, injecting the scoped stylesheet once. The
 * scoping is what keeps plugin styles from colliding with the host's.
 */
export const CSS_MODULES_PLUGIN = {
  name: 'css-modules',
  setup(build) {
    build.onLoad({ filter: /\.module\.css$/ }, async args => {
      const source = await readFile(args.path, 'utf8')
      const classes = [...source.matchAll(CLASS_RE)].map(match => match[1])
      const scoped = new Map()
      const hash = hashString(args.path)
      for (const name of classes) {
        scoped.set(name, `${name}_${hash}`)
      }
      const css = source.replace(CLASS_RE, (match, name) => `.${scoped.get(name) ?? name}`)
      const body = `
const style = document.createElement('style')
style.setAttribute('data-plugin', '')
style.textContent = ${JSON.stringify(css)}
if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin][data-key="${hash}"]')) {
  style.setAttribute('data-key', ${JSON.stringify(hash)})
  document.head.appendChild(style)
}
export default ${JSON.stringify(Object.fromEntries(scoped))}
`
      return { contents: body, loader: 'js' }
    })
  },
}