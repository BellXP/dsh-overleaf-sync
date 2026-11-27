/**
 * An HTTPS agent whose sockets come from an SSH connection's `direct-tcpip` channel.
 *
 * Used when the folder linked to an Overleaf project lives on an SSH host: the
 * project's realtime traffic then leaves from that host's network position
 * (`ssh` service `forwardOut`), not from the machine that runs dsh - no local
 * listening port, no extra process, and the local proxy policy is bypassed.
 * TLS is terminated here as usual: the channel is a plain byte stream, so the
 * certificate is still verified against the real host name.
 */
import { Agent } from 'node:https'
import tls from 'node:tls'
import type { Duplex } from 'node:stream'

export type OpenStream = () => Promise<Duplex>

export interface SshTunnelAgentOptions {
  /** Host name the TLS handshake and certificate check must use (`www.overleaf.com`). */
  servername: string
  /** How long the channel may take to open and the TLS handshake to finish. */
  timeoutMs?: number
}

export class SshTunnelAgent extends Agent {
  readonly #open: OpenStream
  readonly #servername: string
  readonly #timeoutMs: number
  #closed = false

  constructor(open: OpenStream, options: SshTunnelAgentOptions) {
    super({ keepAlive: false })
    this.#open = open
    this.#servername = options.servername
    this.#timeoutMs = options.timeoutMs ?? 15_000
  }

  override createConnection(
    options: Record<string, unknown>,
    callback: (error: Error | null, stream?: Duplex) => void,
  ): undefined {
    void this.#connect(callback)
    return undefined
  }

  async #connect(done: (error: Error | null, stream?: Duplex) => void): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    let stream: Duplex | undefined
    let secure: tls.TLSSocket | undefined
    const finish = (error: Error | null, socket?: Duplex): void => {
      if (timer !== undefined) clearTimeout(timer)
      if (error !== null) {
        secure?.destroy()
        stream?.destroy()
      }
      done(error, socket)
    }
    try {
      timer = setTimeout(() => {
        finish(new Error(`the tunnelled connection to ${this.#servername} did not open within ${this.#timeoutMs} ms`))
      }, this.#timeoutMs)
      timer.unref?.()
      stream = await this.#open()
      if (this.#closed) {
        stream.destroy()
        finish(new Error('the SSH tunnel agent was closed'))
        return
      }
      secure = tls.connect({ socket: stream, servername: this.#servername, rejectUnauthorized: true })
      secure.once('secureConnect', () => finish(null, secure))
      secure.once('error', (error) => finish(error))
      stream.once('error', (error) => finish(error))
      stream.once('close', () => {
        if (!secure?.encrypted) finish(new Error('the SSH channel closed before TLS was established'))
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Nothing new can be opened; existing sockets are left to their owners. */
  close(): void {
    this.#closed = true
    super.destroy()
  }
}

/** Build the agent for a credential's base URL from an `ssh` service `forwardOut`-style opener. */
export function sshTunnelAgentFor(
  openPort: (host: string, port: number) => Promise<Duplex>,
  baseUrl: string,
  options: { timeoutMs?: number } = {},
): SshTunnelAgent | undefined {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:') return undefined
  const port = url.port === '' ? 443 : Number(url.port)
  if (!Number.isInteger(port)) return undefined
  const host = url.hostname
  return new SshTunnelAgent(() => openPort(host, port), {
    servername: host,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  })
}
