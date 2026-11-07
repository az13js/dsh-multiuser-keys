/**
 * Multi-user provider API keys — Client half.
 *
 * Owns two things in the browser:
 *
 *   - a settings page under Settings where the user stores their own key for
 *     each provider the server administrator mapped;
 *   - a `fetch` wrapper that attaches those keys to every same-origin `/api`
 *     request, which is how the Host half learns who is speaking. The header is
 *     sent even when this browser holds no key: an empty ring is the explicit
 *     "I have no key, do not spend anyone else's" signal.
 *
 * Keys never leave this browser except on those requests, and they are stored
 * nowhere else: `localStorage` is the only copy. Clearing site data removes
 * them, and configuring them again takes a few seconds.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-multiuser-keys',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'multiuser-keys'

    /** Catalog shape used when the Host half published none. */
    const EMPTY_CATALOG = {
      version: 1,
      storageKey: 'dsh.multiuser-keys.v1',
      header: 'x-dsh-user-keys',
      providers: [],
    }

    const ZH = {
      nav: '我的 API Key',
      title: '我的 API Key',
      intro:
        '这些 Key 只保存在当前浏览器里，并随请求发送给服务器内存使用。一个对话谁接着聊，就用谁的 Key——不管对话是谁开始的。服务器不会把它们写入磁盘，清除浏览器数据后需要重新填写。',
      emptyCatalog: '服务器管理员还没有配置需要个人 Key 的 provider。',
      footnote:
        '未在服务器配置中的 provider 继续使用服务器默认凭据，无需在此填写。填写后立即生效，无需重启服务。',
      save: '保存',
      clear: '清除',
      show: '显示',
      hide: '隐藏',
      saved: '已保存，后续请求生效',
      cleared: '已清除；在你重新填写前，接着聊任何对话都会因缺少 Key 而失败',
      empty: 'Key 不能为空',
      configured: '已配置',
      unconfigured: '未配置',
      placeholder: '粘贴你的 API Key',
    }

    const EN = {
      nav: 'My API keys',
      title: 'My API keys',
      intro:
        'These keys stay in this browser and travel with your requests into server memory. Whoever continues a conversation pays for it, no matter who started it. The server never writes them to disk; clearing site data means entering them again.',
      emptyCatalog: 'The server administrator has not mapped any provider to per-user keys yet.',
      footnote:
        'Providers outside the server configuration keep using the server default credential. Changes apply to your next request; no restart is needed.',
      save: 'Save',
      clear: 'Clear',
      show: 'Show',
      hide: 'Hide',
      saved: 'Saved — applies to your next request',
      cleared: 'Cleared — until you enter one again, continuing any conversation fails for lack of a key',
      empty: 'The key cannot be empty',
      configured: 'Configured',
      unconfigured: 'Not configured',
      placeholder: 'Paste your API key',
    }

    /** Read the administrator's catalog injected into the page head. */
    function readCatalog() {
      const published = globalThis.DSH_MULTIUSER_KEYS
      if (published === null || typeof published !== 'object') return EMPTY_CATALOG
      const providers = Array.isArray(published.providers)
        ? published.providers.filter(
            (entry) =>
              entry !== null &&
              typeof entry === 'object' &&
              typeof entry.ref === 'string' &&
              entry.ref.length > 0,
          )
        : []
      return {
        version: typeof published.version === 'number' ? published.version : EMPTY_CATALOG.version,
        storageKey:
          typeof published.storageKey === 'string' && published.storageKey.length > 0
            ? published.storageKey
            : EMPTY_CATALOG.storageKey,
        header:
          typeof published.header === 'string' && published.header.length > 0
            ? published.header
            : EMPTY_CATALOG.header,
        providers: providers.map((entry) => ({
          ref: entry.ref,
          provider: typeof entry.provider === 'string' ? entry.provider : entry.ref,
          label:
            typeof entry.label === 'string' && entry.label.length > 0
              ? entry.label
              : typeof entry.provider === 'string'
                ? entry.provider
                : entry.ref,
        })),
      }
    }

    /** Read the stored keys; an unreadable store reads as empty. */
    function readKeys(storageKey) {
      try {
        const raw = globalThis.localStorage?.getItem(storageKey)
        if (typeof raw !== 'string' || raw.length === 0) return {}
        const parsed = JSON.parse(raw)
        const source = parsed !== null && typeof parsed === 'object' && parsed.keys !== null && typeof parsed.keys === 'object' ? parsed.keys : parsed
        if (source === null || typeof source !== 'object') return {}
        const keys = {}
        for (const [ref, value] of Object.entries(source)) {
          if (typeof value === 'string' && value.length > 0) keys[ref] = value
        }
        return keys
      } catch {
        return {}
      }
    }

    /** Persist the keys; a refused write (private mode, quota) is reported to the caller. */
    function writeKeys(storageKey, keys) {
      try {
        globalThis.localStorage?.setItem(storageKey, JSON.stringify({ v: 1, keys }))
        return true
      } catch {
        return false
      }
    }

    /** Base64url one ring for the request header. */
    function encodeRing(keys) {
      const json = JSON.stringify({ v: 1, keys })
      const bytes = new TextEncoder().encode(json)
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    }

    /** Same-origin /api detection; anything else must never carry keys. */
    function isApiRequest(input) {
      try {
        const raw =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
        if (typeof raw !== 'string') return false
        const base = globalThis.location?.href ?? 'http://localhost/'
        const url = new URL(raw, base)
        if (url.origin !== new URL(base).origin) return false
        return url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.includes('/api/')
      } catch {
        return false
      }
    }

    /**
     * Attach this browser's keys to every same-origin API request.
     *
     * The header is set unconditionally — with an empty ring when this browser
     * has no key. That is what lets the Host tell "this speaker has no key"
     * apart from "this request was not made by a browser at all"; only the
     * former may hold a binding, and it must not fall back to someone else's
     * credential.
     * @param catalog - the administrator's catalog.
     * @returns disposer restoring the original fetch.
     */
    function installFetch(catalog) {
      const original = globalThis.fetch
      if (typeof original !== 'function') return () => {}
      const refs = new Set(catalog.providers.map((entry) => entry.ref))
      const wrapped = function (input, init) {
        let header = null
        try {
          if (isApiRequest(input)) {
            const stored = readKeys(catalog.storageKey)
            const keys = {}
            for (const ref of refs) {
              if (typeof stored[ref] === 'string' && stored[ref].length > 0) keys[ref] = stored[ref]
            }
            header = encodeRing(keys)
          }
        } catch {
          header = null
        }
        if (header !== null) {
          try {
            if (typeof Request !== 'undefined' && input instanceof Request) {
              const headers = new Headers(input.headers)
              headers.set(catalog.header, header)
              input = new Request(input, { headers })
            } else {
              const headers = new Headers(init?.headers ?? undefined)
              headers.set(catalog.header, header)
              init = { ...(init ?? {}), headers }
            }
          } catch {
            /* an unmodified request is better than a failed one */
          }
        }
        return original.call(this, input, init)
      }
      globalThis.fetch = wrapped
      return () => {
        if (globalThis.fetch === wrapped) globalThis.fetch = original
      }
    }

    /** Re-render the page whenever the locale changes. */
    function useLocaleRevision(locale) {
      const [, bump] = React.useReducer((count) => count + 1, 0)
      React.useEffect(() => locale.subscribe(() => bump()), [locale])
      return locale.getSnapshot().active
    }

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '720px' },
      title: { margin: '0', fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      intro: { margin: '0', fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      cardHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' },
      cardTitle: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      cardMeta: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      controls: { display: 'flex', alignItems: 'center', gap: '8px' },
      input: {
        flex: '1 1 auto',
        minWidth: '0',
        padding: '6px 8px',
        fontSize: '13px',
        font: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px',
      },
      primary: {
        flex: '0 0 auto',
        padding: '6px 12px',
        fontSize: '13px',
        font: 'inherit',
        color: '#ffffff',
        background: 'var(--dsw-alias-brand-primary)',
        border: 'none',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      secondary: {
        flex: '0 0 auto',
        padding: '6px 10px',
        fontSize: '13px',
        font: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      chip: (configured) => ({
        flex: '0 0 auto',
        fontSize: '11px',
        color: configured ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)',
      }),
      status: (kind) => ({
        margin: '0',
        fontSize: '12px',
        color:
          kind === 'error'
            ? 'var(--dsw-alias-state-error-primary)'
            : kind === 'ok'
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-label-secondary)',
      }),
      footnote: { margin: '0', fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
    }

    /**
     * Build the settings page component for one catalog.
     * @param ctx - Client plugin context.
     * @param catalog - the administrator's catalog.
     * @returns the React component registered into `settings.section`.
     */
    function createPage(ctx, catalog) {
      return function MultiuserKeysPage() {
        useLocaleRevision(ctx.locale)
        const t = ctx.locale.bind(NS)
        const [keys, setKeys] = React.useState(() => readKeys(catalog.storageKey))
        const [drafts, setDrafts] = React.useState({})
        const [revealed, setRevealed] = React.useState({})
        const [status, setStatus] = React.useState(null)

        const draftOf = (ref) => (ref in drafts ? drafts[ref] : (keys[ref] ?? ''))

        const save = (entry) => {
          const value = draftOf(entry.ref).trim()
          if (value.length === 0) {
            setStatus({ ref: entry.ref, kind: 'error', text: t('empty') })
            return
          }
          const next = { ...keys, [entry.ref]: value }
          if (!writeKeys(catalog.storageKey, next)) {
            setStatus({ ref: entry.ref, kind: 'error', text: t('footnote') })
            return
          }
          setKeys(next)
          setDrafts((current) => ({ ...current, [entry.ref]: value }))
          setStatus({ ref: entry.ref, kind: 'ok', text: t('saved') })
        }

        const clear = (entry) => {
          const next = { ...keys }
          delete next[entry.ref]
          writeKeys(catalog.storageKey, next)
          setKeys(next)
          setDrafts((current) => ({ ...current, [entry.ref]: '' }))
          setStatus({ ref: entry.ref, kind: 'idle', text: t('cleared') })
        }

        const rows = catalog.providers.map((entry) =>
          h(
            'div',
            { key: entry.ref, style: styles.card },
            h(
              'div',
              { style: styles.cardHead },
              h('span', { style: styles.cardTitle }, entry.label),
              h('span', { style: styles.chip(keys[entry.ref] !== undefined) }, keys[entry.ref] !== undefined ? t('configured') : t('unconfigured')),
            ),
            h('span', { style: styles.cardMeta }, `${entry.provider} · ${entry.ref}`),
            h(
              'div',
              { style: styles.controls },
              h('input', {
                type: revealed[entry.ref] === true ? 'text' : 'password',
                style: styles.input,
                value: draftOf(entry.ref),
                placeholder: t('placeholder'),
                spellCheck: false,
                autoComplete: 'off',
                onChange: (event) => {
                  const value = event.target.value
                  setDrafts((current) => ({ ...current, [entry.ref]: value }))
                  if (status !== null && status.ref === entry.ref) setStatus(null)
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  style: styles.secondary,
                  onClick: () => setRevealed((current) => ({ ...current, [entry.ref]: current[entry.ref] !== true })),
                },
                revealed[entry.ref] === true ? t('hide') : t('show'),
              ),
              h('button', { type: 'button', style: styles.primary, onClick: () => save(entry) }, t('save')),
              h(
                'button',
                {
                  type: 'button',
                  style: styles.secondary,
                  disabled: keys[entry.ref] === undefined,
                  onClick: () => clear(entry),
                },
                t('clear'),
              ),
            ),
            status !== null && status.ref === entry.ref ? h('p', { style: styles.status(status.kind) }, status.text) : null,
          ),
        )

        return h(
          'div',
          { style: styles.page },
          h('h2', { style: styles.title }, t('title')),
          h('p', { style: styles.intro }, t('intro')),
          catalog.providers.length === 0 ? h('p', { style: styles.intro }, t('emptyCatalog')) : null,
          ...rows,
          h('p', { style: styles.footnote }, t('footnote')),
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const catalog = readCatalog()
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'multiuser-keys: zh dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'multiuser-keys: en dictionary')
        ctx.effect(() => installFetch(catalog), 'multiuser-keys: request header')
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'multiuser-keys',
              order: 25,
              label: () => ctx.locale.bind(NS)('nav'),
            },
            createPage(ctx, catalog),
          ),
        )
      },
    }
  },
})
