import type { Agent } from 'node:http'
import type { Credential, OverleafTransport, TransportFactory } from '../types.js'
import { isOverleafError, OverleafSyncError } from '../core/errors.js'
import { normalizeBaseUrl } from './credentials.js'
import { detectSocketProtocol } from './legacy.js'
import { LegacyTransport } from './legacyTransport.js'
import { createProxyAgent, proxyJoinHint, proxyRouteFor } from './proxy.js'
import { OverleafSocket } from './socket.js'

/**
 * Hard budget for a legacy connect. The 0.9 stack retries a refused upgrade on
 * the same session, and a server that is holding another editor session for the
 * same account and project can keep us waiting indefinitely, so the caller must never hang.
 */
const LEGACY_CONNECT_BUDGET_MS = 45_000

const LEGACY_HINT =
  'a self-hosted Overleaf instance that refuses the socket upgrade usually has another editor session for the same account and project — close the project in your browser, then retry'

/** The proxy agent the Overleaf socket goes through, plus what a hint may say about it. */
interface SocketProxy {
  agent: Agent
  /** `host:port` of the proxy — never its credentials. */
  host: string
  /** The Overleaf host a `NO_PROXY` entry has to name. */
  target: string
}

/** Read the process's proxy policy for the Overleaf origin (see `./proxy.ts`); undefined = direct. */
function socketProxy(baseUrl: string): SocketProxy | undefined {
  let url: URL
  try {
    url = new URL(normalizeBaseUrl(baseUrl))
  } catch {
    return undefined
  }
  const route = proxyRouteFor(url)
  if (route === undefined) return undefined
  return {
    agent: createProxyAgent(route.proxy, url.protocol === 'http:' ? 'http:' : 'https:'),
    host: route.host,
    target: url.host,
  }
}

/**
 * A socket that only fails through a proxy is a proxy problem, and the generic
 * "check network/proxy access" does not say which knob to turn. Name the proxy,
 * and the `NO_PROXY` entry that bypasses it, in the hint.
 */
function withProxyHint(error: unknown, proxy: SocketProxy | undefined): unknown {
  if (proxy === undefined || !isOverleafError(error)) return error
  if (error.code !== 'E_TIMEOUT' && error.code !== 'E_TRANSPORT') return error
  const hint = proxyJoinHint(proxy)
  return new OverleafSyncError(
    error.code,
    error.message,
    error.hint === undefined ? hint : `${error.hint}; ${hint}`,
  )
}

/**
 * Transport factory used by the service layer. Resolves only after the socket
 * has joined the project, so callers immediately get a usable transport.
 *
 * Overleaf deployments come in two socket.io generations and they are not wire
 * compatible (see `docs/design.md` §12.1). Probe once, then pick the matching
 * implementation: `OverleafSocket` for Engine.IO 4, and `LegacyTransport` for
 * Socket.IO 0.9 (older self-hosted builds — and, on the day of writing,
 * overleaf.com itself: its `/socket.io/1/` answers the 0.9 handshake). The probe
 * falls back to `v4`, so a v4 setup that cannot be probed keeps its behaviour.
 *
 * `fetch` is proxied by the harness but these sockets are not, so the probe and
 * both transports are handed the proxy agent the process's policy names for the
 * Overleaf origin (`./proxy.ts`). Without a policy the agent is undefined and
 * everything connects directly, exactly as before.
 */
export const createTransport: TransportFactory = async (
  credential: Credential,
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<OverleafTransport> => {
  const proxy = socketProxy(credential.baseUrl)
  const protocol = await detectSocketProtocol(credential.baseUrl, {
    ...(credential.cookie ? { cookie: credential.cookie } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(proxy ? { agent: proxy.agent } : {}),
  })
  try {
    if (protocol === 'legacy') {
      return await connectLegacy(credential, projectId, options, proxy?.agent)
    }
    return await OverleafSocket.connect(credential, projectId, {
      ...(options ?? {}),
      ...(proxy ? { agent: proxy.agent } : {}),
    })
  } catch (error) {
    throw withProxyHint(error, proxy)
  }
}

/** `LegacyTransport.connect` with a hard deadline and an actionable timeout. */
async function connectLegacy(
  credential: Credential,
  projectId: string,
  options?: { signal?: AbortSignal },
  agent?: Agent,
): Promise<OverleafTransport> {
  const controller = new AbortController()
  const outer = options?.signal
  const onOuterAbort = (): void => controller.abort()
  if (outer?.aborted === true) controller.abort()
  outer?.addEventListener('abort', onOuterAbort, { once: true })

  const timer: NodeJS.Timeout = setTimeout(() => controller.abort(), LEGACY_CONNECT_BUDGET_MS)
  const deadline = new Promise<never>((_, reject) => {
    const onAbort = (): void =>
      reject(
        new OverleafSyncError(
          'E_TIMEOUT',
          `could not join the Overleaf project within ${Math.round(LEGACY_CONNECT_BUDGET_MS / 1000)} s`,
          LEGACY_HINT,
        ),
      )
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([
      LegacyTransport.connect(credential, projectId, {
        ...(options ?? {}),
        ...(agent ? { agent } : {}),
        signal: controller.signal,
      }),
      deadline,
    ])
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onOuterAbort)
  }
}

export { OverleafHttp } from './http.js'
export { OverleafSocket, socketEndpoint } from './socket.js'
export { LegacyOverleafSocket, detectSocketProtocol } from './legacy.js'
export { LegacyTransport } from './legacyTransport.js'
export { createProxyAgent, proxyAgentFor, proxyFor, proxyJoinHint, proxyRouteFor } from './proxy.js'
export type { ProxyRoute } from './proxy.js'
export type { LegacySocketOptions, LegacyJoinProjectResult, SocketProtocol } from './legacy.js'
export type { SocketConnectOptions, SocketEndpoint } from './socket.js'
export type { LegacyTransportOptions } from './legacyTransport.js'
export * from './credentials.js'
export * from './packed.js'
