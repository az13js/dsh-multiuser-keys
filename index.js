/**
 * Multi-user provider API keys — Host half.
 *
 * The deployment shares one Harness process between several people, each with
 * their own provider account. The provider profiles on the server name a
 * credential reference (`apiKeyEnv`) that holds no usable key, so every user
 * keeps their own key in their own browser and the harness must resolve a
 * model request with the key of the person who is talking *right now*.
 *
 * Ownership rule: a conversation belongs to nobody. Whatever browser drove the
 * most recent activity of a session supplies the key for that session from then
 * on. If that browser has no key, the mapped reference resolves to nothing and
 * the provider call fails with `MISSING_CREDENTIAL`; it never falls back to the
 * server's credential or to another user's key.
 *
 * How a browser's key reaches a model request:
 *
 *   1. The Client half stores keys in `localStorage` and attaches them to
 *      every same-origin `/api` request as one header — including an empty
 *      ring, which is the "this browser has no key" signal.
 *   2. `connection/request` (the waterfall that owns every /api request) reads
 *      that header and runs the rest of the request inside an
 *      `AsyncLocalStorage` scope holding the ring. A missing or malformed
 *      header is treated as an empty ring, so a client that predates this
 *      plugin cannot inherit a previous speaker's key.
 *   3. Any session/agent activity driven by that request rebinds the session —
 *      and, through `agent/created`, every agent it later spawns — to that
 *      ring, overwriting whoever spoke before.
 *   4. `credentials.resolve(ref)` reads the ring from the request scope, else
 *      from the session of the agent that is driving the current model call
 *      (`ctx.agents.currentInitiator()`). A mapped reference with no key in
 *      scope resolves to `undefined`.
 *
 * Keys therefore live in process memory only: nothing is written to disk, and
 * a restart simply means each browser supplies its keys again on its next
 * request.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'

/** Cordis plugin name. */
export const name = 'multiuser-keys'

/** The plugin is inert in compositions with no credential seam. */
export const inject = ['credentials']

/** `localStorage` entry the Client half owns; injected into the page so both halves agree. */
const STORAGE_KEY = 'dsh.multiuser-keys.v1'

/** Page global carrying the administrator's provider catalog to the Client half. */
const CATALOG_GLOBAL = 'DSH_MULTIUSER_KEYS'

/** Credential source label reported for a browser-supplied value. */
const DEFAULT_SOURCE = 'browser'

/** Default request header carrying one browser's key ring. */
const DEFAULT_HEADER = 'x-dsh-user-keys'

/** Transport limits: a ring is a handful of keys, never a document. */
const MAX_HEADER_BYTES = 8192
const MAX_KEYS = 32
const MAX_KEY_LENGTH = 4096

/** A credential reference is a POSIX-style environment-variable name. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Bound on remembered session bindings; the oldest binding is evicted first. */
const SESSION_CAPACITY = 512

/**
 * Decode one ring header into a plain reference-to-key map.
 * An empty but well-formed ring decodes to `{}`: the browser spoke and had no
 * key, which is different from "no header at all" only for diagnostics.
 * @param raw - header value, or undefined when the browser sent none.
 * @returns the normalized ring, or null when the header is absent or unusable.
 */
export function decodeRingHeader(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_HEADER_BYTES) return null
  let text
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return normalizeRing(parsed)
}

/**
 * Validate an untrusted ring payload.
 * @param value - decoded JSON value.
 * @returns a fresh reference-to-key map (possibly empty), or null when the
 *   payload is not a ring at all.
 */
export function normalizeRing(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  let source
  if ('keys' in value) {
    if (value.keys === null || typeof value.keys !== 'object' || Array.isArray(value.keys)) return null
    source = value.keys
  } else {
    source = value
  }
  const ring = {}
  let count = 0
  for (const [ref, key] of Object.entries(source)) {
    if (count >= MAX_KEYS) break
    if (typeof key !== 'string') continue
    const trimmed = key.trim()
    if (trimmed.length === 0 || trimmed.length > MAX_KEY_LENGTH) continue
    if (!REF_PATTERN.test(ref)) continue
    ring[ref] = trimmed
    count += 1
  }
  return ring
}

/**
 * Read one header from a Node request.
 * @param request - incoming request, or anything else.
 * @param header - lower-case header name.
 * @returns the first header value, or undefined.
 */
function readHeader(request, header) {
  const headers = request?.headers
  if (headers === null || typeof headers !== 'object') return undefined
  const value = headers[header] ?? headers[header.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

/**
 * Resolve the effective configuration: inline fields, then an optional JSON
 * file whose provider list is appended (the file wins for scalar fields).
 * @param rawConfig - plugin config from the profile patch.
 * @returns the resolved configuration.
 */
function resolveConfig(rawConfig) {
  const inline = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {}
  let fromFile = {}
  if (typeof inline.configFile === 'string' && inline.configFile.length > 0) {
    try {
      const parsed = JSON.parse(readFileSync(inline.configFile, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') fromFile = parsed
    } catch (error) {
      fromFile = { __fileError: `${inline.configFile}: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  const providers = []
  for (const list of [inline.providers, fromFile.providers]) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (typeof item === 'string' && item.length > 0) providers.push({ provider: item })
      else if (item !== null && typeof item === 'object' && typeof item.provider === 'string' && item.provider.length > 0) providers.push(item)
    }
  }
  return {
    header: typeof (fromFile.header ?? inline.header) === 'string' && (fromFile.header ?? inline.header).length > 0 ? (fromFile.header ?? inline.header) : DEFAULT_HEADER,
    source: typeof (fromFile.source ?? inline.source) === 'string' && (fromFile.source ?? inline.source).length > 0 ? (fromFile.source ?? inline.source) : DEFAULT_SOURCE,
    configFileError: fromFile.__fileError,
    logResolutions: (fromFile.logResolutions ?? inline.logResolutions) === true,
    providers,
  }
}

/**
 * Install the Host half.
 * @param ctx - Host plugin context.
 * @param rawConfig - plugin config from the profile patch.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger

  if (config.configFileError !== undefined) {
    logger?.warn?.(`multiuser-keys: cannot read configFile (${config.configFileError}); using inline config only`)
  }

  /** Declared entries, in administrator order. */
  const entries = config.providers.map((item) => ({
    provider: item.provider,
    ref: typeof item.ref === 'string' && item.ref.length > 0 ? item.ref : undefined,
    label: typeof item.label === 'string' && item.label.length > 0 ? item.label : undefined,
  }))

  /** reference -> entry, rebuilt when the settings document changes. */
  let mapping
  const warned = new Set()

  /** Read `apiKeyEnv` for every configured provider route out of the live settings document. */
  const discoverRefs = () => {
    const discovered = new Map()
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.describe !== 'function') return discovered
    let descriptors
    try {
      descriptors = settings.describe({ redactSecrets: true })
    } catch (error) {
      logger?.warn?.(`multiuser-keys: cannot read settings (${error instanceof Error ? error.message : String(error)})`)
      return discovered
    }
    for (const descriptor of descriptors ?? []) {
      const value = descriptor?.value
      if (value === null || typeof value !== 'object') continue
      const profiles = value.providers
      if (profiles !== null && typeof profiles === 'object') {
        for (const [route, profile] of Object.entries(profiles)) {
          const ref = profile !== null && typeof profile === 'object' ? profile.apiKeyEnv : undefined
          if (typeof ref === 'string' && ref.length > 0) discovered.set(route, ref)
        }
      }
      if (descriptor.ns === 'llm-deepseek-api-key' && typeof value.apiKeyEnv === 'string' && value.apiKeyEnv.length > 0) {
        discovered.set('deepseek-official', value.apiKeyEnv)
      }
    }
    return discovered
  }

  /** The effective `reference -> entry` map, computed on demand. */
  const effectiveMapping = () => {
    if (mapping !== undefined) return mapping
    const discovered = discoverRefs()
    const next = new Map()
    for (const entry of entries) {
      const ref = entry.ref ?? discovered.get(entry.provider)
      if (ref === undefined) {
        if (!warned.has(entry.provider)) {
          warned.add(entry.provider)
          logger?.warn?.(`multiuser-keys: provider "${entry.provider}" names no credential reference; set "ref" explicitly or configure the provider's apiKeyEnv`)
        }
        continue
      }
      next.set(ref, { ...entry, ref })
    }
    // Cache only a usable mapping: an empty result usually means the settings
    // document was not readable yet, and caching it would let mapped providers
    // slip through to the server credential for the life of the process.
    if (next.size > 0) mapping = next
    return next
  }

  ctx.on('settings/document-updated', () => {
    mapping = undefined
  })

  /** The provider catalog the Client half renders. */
  const catalog = () => ({
    version: 1,
    storageKey: STORAGE_KEY,
    header: config.header,
    source: config.source,
    providers: [...effectiveMapping().values()].map((entry) => ({
      provider: entry.provider,
      ref: entry.ref,
      label: entry.label ?? entry.provider,
    })),
  })

  ctx.on('webserver/index-inject', (table) => {
    try {
      table.push({ kind: 'global', name: CATALOG_GLOBAL, value: catalog() })
    } catch (error) {
      logger?.warn?.(`multiuser-keys: cannot publish the provider catalog (${error instanceof Error ? error.message : String(error)})`)
    }
  })

  /** Key rings are process-local state: request scope plus one binding per session. */
  const requestScope = new AsyncLocalStorage()
  const sessionRings = new Map()

  /**
   * Bind a session to the ring of the request that just touched it. The new
   * binding always wins, an empty ring included: the browser that spoke last
   * is the one whose key pays, even when it has no key at all.
   * @param id - session/agent identity.
   * @param keys - the current request's ring.
   */
  const bindSession = (id, keys) => {
    const previous = sessionRings.get(id)
    if (previous !== undefined && previous.keys === keys) {
      previous.at = Date.now()
      return
    }
    if (previous !== undefined) sessionRings.delete(id)
    sessionRings.set(id, { keys, at: Date.now() })
    while (sessionRings.size > SESSION_CAPACITY) {
      const oldest = sessionRings.keys().next().value
      if (oldest === undefined) break
      sessionRings.delete(oldest)
    }
  }

  /** Bind whatever session/agent the current browser request is driving. */
  const bindCurrentRequest = (id) => {
    if (id === undefined) return
    const scope = requestScope.getStore()
    if (scope === undefined) return
    bindSession(id, scope.keys)
  }

  ctx.on('connection/request', (request, response, next) => {
    let keys = null
    try {
      keys = decodeRingHeader(readHeader(request, config.header))
    } catch {
      keys = null
    }
    // Every HTTP request gets a scope, even without a usable header: an
    // uninstrumented client must not inherit a previous speaker's ring.
    return requestScope.run({ keys: keys ?? {} }, () => next())
  })

  ctx.on('session/event', (session) => {
    bindCurrentRequest(session?.id)
  })

  ctx.on('agent/inbox/inserted', (payload) => {
    bindCurrentRequest(payload?.agent?.id)
  })

  ctx.on('agent/status', (payload) => {
    bindCurrentRequest(payload?.agent?.id)
  })

  ctx.on('agent/created', (payload) => {
    const id = payload?.agent?.id
    if (id === undefined || sessionRings.has(id)) return undefined
    // A session/agent born inside a browser request belongs to that browser.
    const scope = requestScope.getStore()
    if (scope !== undefined) {
      bindSession(id, scope.keys)
      return undefined
    }
    const parent = currentAgent()
    if (parent === undefined || parent.id === id) return undefined
    const inherited = sessionRings.get(parent.id)
    if (inherited !== undefined) bindSession(id, inherited.keys)
    return undefined
  })

  /** The agent driving the current asynchronous chain, when there is one. */
  function currentAgent() {
    try {
      const agents = ctx.get('agents')
      if (agents === undefined || typeof agents.currentInitiator !== 'function') return undefined
      return agents.currentInitiator()
    } catch {
      return undefined
    }
  }

  /**
   * The browser key for one reference, or undefined when this browser carries none.
   * No global "last browser" state exists: attribution is the request scope, or
   * the binding of the session that is currently doing the talking.
   * @param ref - credential reference being resolved.
   * @returns the key, when the current speaker supplied one.
   */
  function browserKey(ref) {
    if (typeof ref !== 'string' || ref.length === 0) return undefined
    if (!effectiveMapping().has(ref)) return undefined

    const scope = requestScope.getStore()
    if (scope !== undefined) return scope.keys[ref]

    const agent = currentAgent()
    if (agent !== undefined) {
      const bound = sessionRings.get(agent.id)
      if (bound !== undefined) return bound.keys[ref]
    }

    return undefined
  }

  if (entries.length === 0) {
    logger?.info?.('multiuser-keys: no provider configured; every credential keeps the harness default')
    return
  }

  ctx.inject(['credentials'], (credentialCtx) => {
    const service = credentialCtx.credentials
    const original = service?.resolve
    if (typeof original !== 'function') {
      logger?.warn?.('multiuser-keys: the credential provider exposes no resolve(); plugin inactive')
      return
    }
    const patched = function resolve(ref) {
      let mapped = false
      try {
        mapped = effectiveMapping().has(String(ref))
      } catch {
        mapped = false
      }
      if (!mapped) return original.call(this, ref)

      let key
      try {
        key = browserKey(ref)
      } catch (error) {
        key = undefined
        logger?.warn?.(`multiuser-keys: key lookup failed for ${String(ref)} (${error instanceof Error ? error.message : String(error)})`)
      }
      if (typeof key === 'string' && key.length > 0) {
        if (config.logResolutions) logger?.info?.(`multiuser-keys: resolved ${String(ref)} from the current speaker`)
        return Promise.resolve({ value: key, source: config.source })
      }
      // Fail closed: the mapped provider is per-user by definition, so an
      // absent browser key must surface as MISSING_CREDENTIAL instead of
      // silently spending the server's or another user's quota.
      if (config.logResolutions) logger?.info?.(`multiuser-keys: ${String(ref)} has no key for the current speaker; refusing the server credential`)
      return Promise.resolve(undefined)
    }
    service.resolve = patched
    credentialCtx.effect(() => () => {
      if (service.resolve === patched) service.resolve = original
    }, 'multiuser-keys: credentials.resolve')
    logger?.info?.(`multiuser-keys: per-user keys active for ${[...effectiveMapping().keys()].join(', ') || '(no resolvable reference yet)'}`)
  })
}
