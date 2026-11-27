/**
 * Outbound proxy for the socket.io transports.
 *
 * `fetch` is proxied by the harness: dsh resolves one policy from `http_proxy` / `https_proxy` /
 * `no_proxy` at startup, installs it as undici's global dispatcher and writes the answer back into
 * `process.env`. The realtime socket never sees that dispatcher — socket.io opens its own TLS
 * sockets — so on a network that only lets traffic out through a proxy the project list arrives
 * over HTTP while every `joinProject` times out.
 *
 * The policy is not re-derived here. Reading the standard names yields the answer dsh already
 * gave its dispatcher (the launcher's snapshot, `.env` included); in a standalone script they hold
 * what the user exported, which is the same policy by construction. The tunnelling is Node's own
 * (`Agent({ proxyEnv })`, Node 24.5+): CONNECT for https targets, websocket upgrades included. On
 * an older Node the option is ignored and the sockets go out directly, exactly as before.
 */
import { Agent as HttpAgent, type AgentOptions as HttpAgentOptions } from 'node:http'
import { Agent as HttpsAgent, type AgentOptions as HttpsAgentOptions } from 'node:https'

/** Where one URL's traffic goes: the proxy URL as written, and the host:port a hint can name. */
export interface ProxyRoute {
  readonly proxy: string
  readonly host: string
}

/** Proxy URL schemes Node's built-in proxy support understands; anything else means "direct". */
const SUPPORTED_PROXY_SCHEMES = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:'])

/** Lowercase first, uppercase as the fallback, blank treated as unset — the policy's own order. */
function readEnv(name: string): string | undefined {
  for (const key of [name, name.toUpperCase()]) {
    const value = process.env[key]
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** A usable proxy URL, or undefined for a value Node cannot route through (reported nowhere: direct). */
function parseProxyUrl(value: string): string | undefined {
  // `host:port` without a scheme is how many users write it; `new URL` would read `host:` as a scheme.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
  try {
    const parsed = new URL(candidate)
    if (!SUPPORTED_PROXY_SCHEMES.has(parsed.protocol)) return undefined
    return parsed.href
  } catch {
    return undefined
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '0.0.0.0' || host === '::1' || /^127\./.test(host)
}

/**
 * `no_proxy` matching by the policy's rules: an entry names a host together with every subdomain
 * under it, a leading `.` or `*.` means the same thing, an entry may carry a `:port`, and `*`
 * bypasses everything. CIDR is not matched.
 */
function bypassed(hostname: string, effectivePort: string, list: string | undefined): boolean {
  if (list === undefined) return false
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  for (const raw of list.split(/[,\s]+/)) {
    let entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    // Windows writes loopback ranges as `127.0.0.1*`; the star is a wildcard for the range.
    if (entry.endsWith('*')) entry = entry.slice(0, -1)
    if (entry.startsWith('*.')) entry = entry.slice(1)
    if (entry.startsWith('.')) entry = entry.slice(1)
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry)
    if (match === null) continue
    const named = (match[1] ?? '').replace(/^\[|\]$/g, '')
    if (named === '') continue
    if (host !== named && !host.endsWith(`.${named}`)) continue
    const namedPort = match[2]
    if (namedPort !== undefined && namedPort !== effectivePort) continue
    return true
  }
  return false
}

/**
 * The proxy this process routes `url` through, or undefined for a direct connection.
 * For `https:` the names are `https_proxy`, `all_proxy`, then the HTTP proxy as the last resort
 * (neither Node nor undici derives that one on its own); for `http:` they are `http_proxy`,
 * `all_proxy`. Loopback and `no_proxy` always go direct.
 */
export function proxyFor(url: URL): string | undefined {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (isLoopback(url.hostname)) return undefined
  const effectivePort = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  if (bypassed(url.hostname, effectivePort, readEnv('no_proxy'))) return undefined
  const named = url.protocol === 'https:' ? readEnv('https_proxy') : readEnv('http_proxy')
  const last = url.protocol === 'https:' ? readEnv('http_proxy') : undefined
  for (const candidate of [named, readEnv('all_proxy'), last]) {
    if (candidate === undefined) continue
    const parsed = parseProxyUrl(candidate)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** `proxyFor` plus the `host:port` an error hint can name without exposing credentials. */
export function proxyRouteFor(url: URL): ProxyRoute | undefined {
  const proxy = proxyFor(url)
  if (proxy === undefined) return undefined
  let host: string
  try {
    host = new URL(proxy).host
  } catch {
    host = 'the outbound proxy'
  }
  return { proxy, host }
}

/**
 * What a join that failed through the proxy should tell the user. The generic "check
 * network/proxy access" does not say which knob to turn, so this names the proxy (never its
 * credentials) and the `NO_PROXY` entry that would bypass it.
 */
export function proxyJoinHint(proxy: { readonly host: string; readonly target: string }): string {
  return (
    `the socket was routed through proxy ${proxy.host}; a join that fails only this way usually means ` +
    `the proxy cannot carry the websocket upgrade — add ${proxy.target} to NO_PROXY, or let the proxy pass websockets`
  )
}

/** `proxyEnv` is what Node's `Agent` reads (Node 24.5+); older typings do not know the field. */
type ProxyAgentOptions = HttpAgentOptions & HttpsAgentOptions & { proxyEnv?: Record<string, string> }

/**
 * An agent that routes every request through `proxy` — the http or https flavour to match the
 * target, as the request modules expect. Sockets are not pooled: the legacy transport hands each
 * request its own socket, and an upgrade must not inherit a pooled connection. The bypass list is
 * emptied on purpose: the route was already decided for the one URL this agent serves.
 */
export function createProxyAgent(proxy: string, protocol: 'http:' | 'https:'): HttpAgent {
  const options: ProxyAgentOptions = {
    keepAlive: false,
    proxyEnv: { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: '' },
  }
  return protocol === 'http:' ? new HttpAgent(options) : new HttpsAgent(options)
}

/** The agent a socket to `url` should use, or undefined to connect directly. */
export function proxyAgentFor(url: URL): HttpAgent | undefined {
  const proxy = proxyFor(url)
  if (proxy === undefined) return undefined
  return createProxyAgent(proxy, url.protocol === 'http:' ? 'http:' : 'https:')
}
