/**
 * Host-half checks for @local/dsh-multiuser-keys, driven through the real
 * `apply()` against a stub Cordis context. Run with:
 *
 *   node test/host.test.mjs
 *
 * The contract these checks pin down:
 *   - the browser that drives a session's latest activity supplies the key;
 *   - a browser with no key fails closed (resolve -> undefined) and never
 *     falls back to the server credential or to an earlier speaker's key;
 *   - unmapped references keep the harness default behaviour.
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
  const state = { fallbacks: 0 }
  let credentials = {
    resolve: async (ref) => {
      state.fallbacks += 1
      return { value: `env:${ref}`, source: 'env' }
    },
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
    state,
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

/** The client half's header when this browser holds no key at all. */
const NO_KEY = ringHeader({})

const REF = 'COMPANY_GATEWAY_API_KEY'
const OTHER = 'UNMAPPED_REF'
const RING = { [REF]: 'sk-user-a' }
const CONFIG = { providers: [{ provider: 'company-gateway', ref: REF, label: 'Gateway' }] }

// --- payload validation -----------------------------------------------------

check('normalizeRing keeps valid entries', normalizeRing({ keys: { A_KEY: 'v', 'bad name': 'x', B_KEY: '' } }), { A_KEY: 'v' })
check('normalizeRing accepts a well-formed empty ring', normalizeRing({ v: 1, keys: {} }), {})
check('normalizeRing rejects a non-object', normalizeRing('nope'), null)
check('normalizeRing rejects a non-object keys field', normalizeRing({ keys: 'nope' }), null)
check('decodeRingHeader round trip', decodeRingHeader(ringHeader(RING)), RING)
check('decodeRingHeader decodes the no-key signal', decodeRingHeader(NO_KEY), {})
check('decodeRingHeader rejects garbage', decodeRingHeader('!!!'), null)

// --- request scope ----------------------------------------------------------

{
  const harness = createHarness({ config: CONFIG })
  const inside = await harness.request({ 'x-dsh-user-keys': ringHeader(RING) }, async () => harness.credentials.resolve(REF))
  check('resolve inside the request scope uses the browser key', inside, { value: 'sk-user-a', source: 'browser' })
  check('a request-scoped resolution never touches the server credential', harness.state.fallbacks, 0)
}

{
  const harness = createHarness({ config: CONFIG })
  const inside = await harness.request({ 'x-dsh-user-keys': NO_KEY }, async () => harness.credentials.resolve(REF))
  check('a browser without a key fails closed inside its own request', inside, undefined)
  check('failing closed does not delegate to the server credential', harness.state.fallbacks, 0)
}

// --- the current speaker owns the session -----------------------------------

{
  const harness = createHarness({ config: CONFIG })

  // A starts the conversation.
  await harness.request({ 'x-dsh-user-keys': ringHeader(RING) }, async () => {
    harness.emit('session/event', { id: 'session-S' }, {})
  })
  harness.agents.currentInitiator = () => ({ id: 'session-S' })
  check('the speaker who started the session pays for it', await harness.credentials.resolve(REF), { value: 'sk-user-a', source: 'browser' })

  // B, on another machine, has no key and continues the same conversation.
  await harness.request({ 'x-dsh-user-keys': NO_KEY }, async () => {
    harness.emit('session/event', { id: 'session-S' }, {})
    harness.emit('agent/inbox/inserted', { agent: { id: 'session-S' }, message: {} })
  })
  check('a keyless browser taking over makes the call fail', await harness.credentials.resolve(REF), undefined)
  check('the takeover did not fall back to a server credential', harness.state.fallbacks, 0)

  // A comes back: her own key applies again.
  await harness.request({ 'x-dsh-user-keys': ringHeader(RING) }, async () => {
    harness.emit('session/event', { id: 'session-S' }, {})
  })
  check('the previous speaker takes the session back with her own key', await harness.credentials.resolve(REF), { value: 'sk-user-a', source: 'browser' })
}

{
  const harness = createHarness({ config: CONFIG })
  const RING_B = { [REF]: 'sk-user-b' }

  await harness.request({ 'x-dsh-user-keys': ringHeader(RING) }, async () => {
    harness.emit('session/event', { id: 'session-shared' }, {})
  })
  await harness.request({ 'x-dsh-user-keys': ringHeader(RING_B) }, async () => {
    harness.emit('session/event', { id: 'session-shared' }, {})
  })
  harness.agents.currentInitiator = () => ({ id: 'session-shared' })
  check('two keyed browsers: the latest speaker pays, not the session opener', await harness.credentials.resolve(REF), { value: 'sk-user-b', source: 'browser' })
}

// --- a request with no header is not an escape hatch ------------------------

{
  const harness = createHarness({ config: CONFIG })
  await harness.request({ 'x-dsh-user-keys': ringHeader(RING) }, async () => {
    harness.emit('session/event', { id: 'session-legacy' }, {})
  })
  // A stale/uninstrumented client sends no header at all.
  await harness.request({}, async () => {
    harness.emit('session/event', { id: 'session-legacy' }, {})
  })
  harness.agents.currentInitiator = () => ({ id: 'session-legacy' })
  check('a headerless takeover clears the binding instead of reusing it', await harness.credentials.resolve(REF), undefined)
}

// --- no global "last browser" fallback --------------------------------------

{
  const harness = createHarness({ config: CONFIG })
  await harness.request({ 'x-dsh-user-keys': ringHeader(RING) }, async () => {})
  harness.agents.currentInitiator = () => ({ id: 'session-other' })
  check('a session nobody has spoken in gets no borrowed key', await harness.credentials.resolve(REF), undefined)
  harness.agents.currentInitiator = () => undefined
  check('a call with no agent and no request scope gets no borrowed key', await harness.credentials.resolve(REF), undefined)
  check('no global fallback touched the server credential', harness.state.fallbacks, 0)
}

// --- unmapped references keep the default behaviour -------------------------

{
  const harness = createHarness({ config: CONFIG })
  await harness.request({ 'x-dsh-user-keys': ringHeader(RING) }, async () => {})
  check('an unmapped reference delegates even with no scope', await harness.credentials.resolve(OTHER), { value: `env:${OTHER}`, source: 'env' })
  check('an unmapped reference does not consult the browser ring', harness.state.fallbacks, 1)
}

// --- inheritance by spawned agents -----------------------------------------

{
  const harness = createHarness({ config: CONFIG })

  // A session created inside B's request is bound to B's ring from birth.
  await harness.request({ 'x-dsh-user-keys': ringHeader({ [REF]: 'sk-user-b' }) }, async () => {
    harness.emit('agent/created', { agent: { id: 'session-born' } })
  })
  harness.agents.currentInitiator = () => ({ id: 'session-born' })
  check('a session born in a request uses that browser’s key', await harness.credentials.resolve(REF), { value: 'sk-user-b', source: 'browser' })

  await harness.request({ 'x-dsh-user-keys': ringHeader(RING) }, async () => {
    harness.emit('session/event', { id: 'session-parent' }, {})
  })
  harness.agents.currentInitiator = () => ({ id: 'session-parent' })
  harness.emit('agent/created', { agent: { id: 'session-child' } })
  harness.agents.currentInitiator = () => ({ id: 'session-child' })
  check('a spawned agent inherits the current speaker’s ring', await harness.credentials.resolve(REF), { value: 'sk-user-a', source: 'browser' })

  // B takes over the parent session; a child spawned afterwards is B's.
  await harness.request({ 'x-dsh-user-keys': ringHeader({ [REF]: 'sk-user-b' }) }, async () => {
    harness.emit('session/event', { id: 'session-parent' }, {})
  })
  harness.agents.currentInitiator = () => ({ id: 'session-parent' })
  harness.emit('agent/created', { agent: { id: 'session-child-2' } })
  harness.agents.currentInitiator = () => ({ id: 'session-child-2' })
  check('a child spawned after a takeover carries the new speaker’s ring', await harness.credentials.resolve(REF), { value: 'sk-user-b', source: 'browser' })
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

// --- late settings discovery ------------------------------------------------

{
  const settings = { describe: () => [] }
  const harness = createHarness({ config: { providers: [{ provider: 'company-gateway' }] }, settings })
  check('a provider whose apiKeyEnv is not readable yet delegates', await harness.credentials.resolve(REF), { value: `env:${REF}`, source: 'env' })
  settings.describe = () => [{ ns: 'llm-pi-ai', value: { providers: { 'company-gateway': { apiKeyEnv: REF } } } }]
  const inside = await harness.request({ 'x-dsh-user-keys': ringHeader(RING) }, async () => harness.credentials.resolve(REF))
  check('an empty mapping is recomputed once the settings document is readable', inside, { value: 'sk-user-a', source: 'browser' })
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
