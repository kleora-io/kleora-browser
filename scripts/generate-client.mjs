/**
 * Regenerate the account API's types from the OpenAPI document Kleora serves.
 *
 *   pnpm generate:client
 *
 * Fetches the deployed document (`ACCOUNT_OPENAPI_URL` overrides the default)
 * and writes two files, both committed:
 *
 * - `openapi/account-v1.json`: the document itself, pretty-printed. The unit
 *   tests read it, so they hold the hand-written wrappers in `src/account.ts`
 *   and `src/portal.ts` to the document without needing the network.
 * - `src/generated/account.ts`: the document as TypeScript, from
 *   `openapi-typescript`. `src/account.ts` gives the pieces their names.
 *
 * CI runs this and fails when either file differs from what is committed, so a
 * change to the deployed API surfaces as a red check rather than as a client
 * that silently disagrees with the server.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import openapiTS, { astToString } from 'openapi-typescript'

const DEFAULT_URL = 'https://id.kleora.eu/account/v1/openapi.json'

const BANNER = `/**
 * GENERATED — do not edit. \`pnpm generate:client\` writes it from the
 * deployed account API document (https://id.kleora.eu/account/v1/openapi.json).
 *
 * The end-user self-service API's OpenAPI document, as TypeScript.
 * \`src/account.ts\` gives the pieces their names and adds the bearer token and
 * problem parsing; nothing else imports this file.
 */

`

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const url = process.env.ACCOUNT_OPENAPI_URL || DEFAULT_URL

const response = await globalThis.fetch(url, { headers: { Accept: 'application/json' } })
if (!response.ok) {
  throw new Error(`GET ${url} answered ${response.status}`)
}
// Object keys sorted, array order kept: the committed files then change only
// when the API does, never because the server serialised a mapping differently.
const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
        )
      : value
const document = sorted(await response.json())

const outputs = [
  ['openapi/account-v1.json', JSON.stringify(document, null, 2) + '\n'],
  ['src/generated/account.ts', BANNER + astToString(await openapiTS(document))],
]

for (const [path, text] of outputs) {
  const output = resolve(root, path)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, text, 'utf8')
  process.stdout.write(`wrote ${relative(root, output)} from ${url}\n`)
}
