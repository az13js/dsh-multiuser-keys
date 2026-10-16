/**
 * Host-half checks for @local/dsh-multiuser-keys, driven through the real
 * `apply()` against a stub Cordis context. Run with:
 *
 *   node test/host.test.mjs
 */

import { apply, decodeRingHeader, normalizeRing } from '../index.js'

let failures = 0
let checks = 0

function check(label, actual, expected) {
  checks += 1
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures += 1
    console.error(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

/** A stub context exposing exactly the surface the Host half uses. */
function createHarness(options = {}) {
  const listeners = new Map()
  const disposers = []
  const warnings = []
  const infos = []
  let credentials = {
    resolve: async (ref) => ({ value: `env:${ref}`, source: 'env' }),
  }
  const agents = {
    currentInitiator: options.currentInitiator ?? (() => undefined),
  }
  const settings = options.settings
  const ctx = {
    logger: {
      info: (...args) => infos.push(args.join(' ')),
      warn: (...args) => warnings.push(args.join(' ')),
    },
    get(name) {
      if (name === 'agents') return agents
      if (name === 'settings') return settings
      return undefined
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject(names, callback) {
      callback({ credentials, effect: ctx.effect })
    },
  }
  apply(ctx, options.config ?? {})
  return {
    credentials,
    warnings,
    infos,
    agents,
    /** Fire an emit-mode event. */
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    /** Run the connection/request waterfall, as the web transport does. */
    request(headers, next) {
      const chain = listeners.get('connection/request') ?? []
      const run = (index) => async () => {
        if (index >= chain.length) return next()
        return chain[index]({ headers }, {}, run(index + 1))
      }
      return run(0)()
    },
    /** Emit an event and collect the table argument, as the index renderer does. */
    injectIndex() {
      const table = []
      for (const listener of listeners.get('webserver/index-inject') ?? []) listener(table)
      return table
    },
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose()
    },
  }
}

/** One browser's ring, encoded the way the Client half encodes it. */
function ringHeader(keys) {
  return Buffer.from(JSON.stringify({ v: 1, keys }), 'utf8').toString('base64url')
}

const REF = 'COMPANY_GATEWAY_API_KEY'
const OTHER = 'UNMAPPED_REF'
const RING = { [REF]: 'sk-user-a' }
const CONFIG = { providers: [{ provider: 'company-gateway', ref: REF, label: 'Gateway' }] }

// --- payload validation -----------------------------------------------------

check('normalizeRing keeps valid entries', normalizeRing({ keys: { A_KEY: 'v', 'bad name': 'x', B_KEY: '' } }), { A_KEY: 'v' })
check('normalizeRing rejects a non-object', normalizeRing('nope'), null)
check('decodeRingHeader round trip', decodeRingHeader(ringHeader(RING)), RING)
check('decodeRingHeader rejects garbage', decodeRingHeader('!!!'), null)

// --- request scope, session binding, default behaviour ----------------------

{
  const harness = createHarness({ config: CONFIG })
  const inside = await harness.request({ 'x-dsh-user-keys': ringHeader(RING) }, async () => {
    harness.emit('session/event', { id: 'session-a' }, {})
    harness.agents.currentInitiator = () => ({ id: 'session-a' })
    return harness.credentials.resolve(REF)
  })
  check('resolve inside the request scope uses the browser key', inside, { value: 'sk-user-a', source: 'browser' })
  check('resolve from the bound session uses the browser key', await harness.credentials.resolve(REF), { value: 'sk-user-a', source: 'browser' })
  check('an unmapped reference keeps the default behaviour', await harness.credentials.resolve(OTHER), { value: `env:${OTHER}`, source: 'env' })
}

{
  const harness = createHarness({ config: CONFIG, currentInitiator: () => ({ id: 'session-untouched' }) })
  check('a mapped reference with no browser key falls through', await harness.credentials.resolve(REF), { value: `env:${REF}`, source: 'env' })
}

{
  const harness = createHarness({ config: CONFIG })
  await harness.request({ 'x-dsh-user-keys': ringHeader({ OTHER: 'sk-other' }) }, async () => {
    harness.emit('session/event', { id: 'session-b' }, {})
  })
  harness.agents.currentInitiator = () => ({ id: 'session-b' })
  check('a ring without the mapped reference falls through', await harness.credentials.resolve(REF), { value: `env:${REF}`, source: 'env' })
}

// --- last-activity fallback and its window ---------------------------------

{
  const harness = createHarness({ config: CONFIG })
  await harness.request({ 'x-dsh-user-keys': ringHeader(RING) }, async () => {})
  check('recent browser activity answers with no session binding', await harness.credentials.resolve(REF), { value: 'sk-user-a', source: 'browser' })
}

{
  const harness = createHarness({ config: { ...CONFIG, recentRingWindowMs: 0 } })
  await harness.request({ 'x-dsh-user-keys': ringHeader(RING) }, async () => {})
  check('a zero window disables the fallback', await harness.credentials.resolve(REF), { value: `env:${REF}`, source: 'env' })
}

// --- inheritance by spawned agents -----------------------------------------

{
  const harness = createHarness({ config: CONFIG })
  await harness.request({ 'x-dsh-user-keys': ringHeader(RING) }, async () => {
    harness.emit('session/event', { id: 'session-parent' }, {})
  })
  harness.agents.currentInitiator = () => ({ id: 'session-parent' })
  harness.emit('agent/created', { agent: { id: 'session-child' } })
  harness.agents.currentInitiator = () => ({ id: 'session-child' })
  check('a spawned agent inherits its parent ring', await harness.credentials.resolve(REF), { value: 'sk-user-a', source: 'browser' })
}

// --- provider catalog -------------------------------------------------------

{
  const harness = createHarness({
    config: { providers: [{ provider: 'company-gateway' }, { provider: 'nowhere' }] },
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: { 'company-gateway': { apiKeyEnv: REF } } } }],
    },
  })
  const [row] = harness.injectIndex()
  check('catalog discovers apiKeyEnv from the settings document', row.value.providers, [{ provider: 'company-gateway', ref: REF, label: 'company-gateway' }])
  check('catalog reports the storage key the Client half uses', row.value.storageKey, 'dsh.multiuser-keys.v1')
  check('an unresolvable provider is warned about once', harness.warnings.filter((line) => line.includes('nowhere')).length, 1)
}

// --- teardown ---------------------------------------------------------------

{
  const harness = createHarness({ config: CONFIG })
  const patched = harness.credentials.resolve
  await harness.dispose()
  check('disposal restores the original resolve', harness.credentials.resolve === patched, false)
  check('the restored resolve delegates', await harness.credentials.resolve(REF), { value: `env:${REF}`, source: 'env' })
}

{
  const harness = createHarness({ config: { providers: [] } })
  check('an unmapped configuration leaves resolve untouched', await harness.credentials.resolve(REF), { value: `env:${REF}`, source: 'env' })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
