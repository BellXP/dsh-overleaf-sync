import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  createProxyAgent,
  proxyAgentFor,
  proxyFor,
  proxyJoinHint,
  proxyRouteFor,
} from '../../lib/transport/proxy.js'
import { TEST_CERT } from '../helpers/proxy-cert.mjs'

const HELPERS = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Policy resolution — pure `process.env` reading, so each case sets the names it needs.
// ---------------------------------------------------------------------------

const PROXY_NAMES = [
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
]

/** Run `run` with only the proxy names `values` names, then put the process back. */
function withEnv(values, run) {
  const saved = {}
  for (const name of PROXY_NAMES) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
  Object.assign(process.env, values)
  try {
    return run()
  } finally {
    for (const name of PROXY_NAMES) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  }
}

const OVERLEAF = new URL('https://www.overleaf.com/project/abc')

describe('proxyFor (the process proxy policy, by dsh-http-proxy\'s rules)', () => {
  it('is direct without any proxy name', () => {
    withEnv({}, () => assert.equal(proxyFor(OVERLEAF), undefined))
  })

  it('routes https through https_proxy, and http through http_proxy', () => {
    withEnv({ HTTPS_PROXY: 'http://p.test:3128', HTTP_PROXY: 'http://q.test:3129' }, () => {
      assert.equal(proxyFor(OVERLEAF), 'http://p.test:3128/')
      assert.equal(proxyFor(new URL('http://ce.test/overleaf/')), 'http://q.test:3129/')
    })
  })

  it('reads lowercase first and uppercase as the fallback; blank counts as unset', { skip: process.platform === 'win32' && 'environment names are one key on Windows: lowercase and uppercase cannot differ' }, () => {
    withEnv({ https_proxy: 'http://lower.test:1', HTTPS_PROXY: 'http://upper.test:2' }, () =>
      assert.equal(proxyFor(OVERLEAF), 'http://lower.test:1/'))
  })

  it('a blank value counts as unset, so the other casing or name is used', () => {
    // One casing is enough to set the single Windows key, so the case holds on every platform.
    withEnv({ HTTPS_PROXY: '   ', ALL_PROXY: 'http://any.test:2' }, () =>
      assert.equal(proxyFor(OVERLEAF), 'http://any.test:2/'))
  })

  it('falls back to all_proxy, then (for https only) to the HTTP proxy', () => {
    withEnv({ ALL_PROXY: 'http://any.test:3' }, () => {
      assert.equal(proxyFor(OVERLEAF), 'http://any.test:3/')
      assert.equal(proxyFor(new URL('http://ce.test/')), 'http://any.test:3/')
    })
    withEnv({ HTTP_PROXY: 'http://http-first.test:4' }, () => {
      assert.equal(proxyFor(OVERLEAF), 'http://http-first.test:4/')
    })
  })

  it('skips a value Node cannot route through and keeps looking', () => {
    withEnv({ https_proxy: 'socks5h://old.test:1080', HTTPS_PROXY: 'http://next.test:5' }, () =>
      assert.equal(proxyFor(OVERLEAF), 'http://next.test:5/'))
    withEnv({ https_proxy: 'not a url at all' }, () => assert.equal(proxyFor(OVERLEAF), undefined))
  })

  it('accepts `host:port` written without a scheme', () => {
    withEnv({ HTTPS_PROXY: 'corp.test:8080' }, () => assert.equal(proxyFor(OVERLEAF), 'http://corp.test:8080/'))
  })

  it('never proxies loopback, with or without a no_proxy entry', () => {
    withEnv({ HTTPS_PROXY: 'http://p.test:3128' }, () => {
      for (const host of ['localhost', '127.0.0.1', '127.9.9.9', '[::1]', '0.0.0.0']) {
        assert.equal(proxyFor(new URL(`https://${host}:3000/`)), undefined, host)
      }
    })
  })

  it('matches no_proxy the way the policy does: host with its subdomains, dot or *., :port, *', () => {
    const env = { HTTPS_PROXY: 'http://p.test:3128', NO_PROXY: '.internal.test,exact.test:8443,overleaf.org' }
    withEnv(env, () => {
      assert.equal(proxyFor(new URL('https://a.internal.test/')), undefined, 'subdomain of .internal.test')
      assert.equal(proxyFor(new URL('https://internal.test/')), undefined, 'the bare host of .internal.test')
      assert.equal(proxyFor(new URL('https://notinternal.test/')), 'http://p.test:3128/', 'a suffix match is not enough: it needs the dot')
      assert.equal(proxyFor(new URL('https://exact.test:8443/')), undefined, 'host and port both match')
      assert.equal(proxyFor(new URL('https://exact.test/')), 'http://p.test:3128/', 'port differs')
      assert.equal(proxyFor(new URL('https://www.overleaf.org/')), undefined, 'subdomain of a bare entry')
    })
    withEnv({ ...env, NO_PROXY: '*.sibling.test' }, () =>
      assert.equal(proxyFor(new URL('https://x.sibling.test/')), undefined, '*.entry'))
    withEnv({ ...env, NO_PROXY: '127.0.0.1*,.corp.test' }, () => {
      // How Windows writes a loopback range; the host part still matches.
      assert.equal(proxyFor(new URL('https://127.0.0.1:9777/')), undefined)
      assert.equal(proxyFor(new URL('https://a.corp.test/')), undefined)
    })
    withEnv({ ...env, NO_PROXY: '*' }, () => assert.equal(proxyFor(OVERLEAF), undefined, '* bypasses everything'))
  })

  it('leaves non-http(s) URLs alone', () => {
    withEnv({ ALL_PROXY: 'http://any.test:3' }, () =>
      assert.equal(proxyFor(new URL('ftp://files.test/x')), undefined))
  })
})

describe('proxyRouteFor / proxyJoinHint / createProxyAgent', () => {
  it('names the proxy host for a hint without exposing its credentials', () => {
    withEnv({ HTTPS_PROXY: 'http://alice:s3cret@corp.test:8080' }, () => {
      const route = proxyRouteFor(OVERLEAF)
      assert.equal(route.host, 'corp.test:8080')
      assert.equal(route.proxy, 'http://alice:s3cret@corp.test:8080/')
      assert.doesNotMatch(route.host, /s3cret/)
    })
    withEnv({}, () => assert.equal(proxyRouteFor(OVERLEAF), undefined))
  })

  it('the join hint names the proxy and the NO_PROXY entry that bypasses it, never a credential', () => {
    const hint = proxyJoinHint({ host: 'corp.test:8080', target: 'www.overleaf.com' })
    assert.match(hint, /proxy corp\.test:8080/)
    assert.match(hint, /add www\.overleaf\.com to NO_PROXY/)
    assert.match(hint, /websocket/)
  })

  it('builds the http or https agent flavour to match the target, and none without a policy', () => {
    withEnv({ HTTPS_PROXY: 'http://corp.test:8080', HTTP_PROXY: 'http://corp.test:8080' }, () => {
      assert.ok(proxyAgentFor(OVERLEAF) instanceof https.Agent, 'https target → https.Agent')
      const plain = proxyAgentFor(new URL('http://ce.test/'))
      assert.ok(plain instanceof http.Agent && !(plain instanceof https.Agent), 'http target → http.Agent')
      plain.destroy()
      proxyAgentFor(OVERLEAF).destroy()
    })
    withEnv({}, () => assert.equal(proxyAgentFor(OVERLEAF), undefined))
  })

  it('the agent is not a pooling one: a transport hands each request its own socket', () => {
    const agent = createProxyAgent('http://corp.test:8080', 'https:')
    assert.equal(agent.keepAlive, false)
    agent.destroy()
  })
})

// ---------------------------------------------------------------------------
// The tunnel itself — in a child Node, so NODE_EXTRA_CA_CERTS can make the test CA trusted.
// ---------------------------------------------------------------------------

describe('the socket through an HTTP CONNECT proxy (Node\'s built-in proxy agent)', () => {
  it('runs every tunnel check in the child', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-overleaf-sync-proxy-'))
    try {
      const certPath = path.join(dir, 'ca.pem')
      writeFileSync(certPath, TEST_CERT)
      const env = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (!/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(key)) env[key] = value
      }
      env.NODE_EXTRA_CA_CERTS = certPath
      const child = spawnSync(process.execPath, [path.join(HELPERS, '..', 'helpers', 'proxy-tunnel-child.mjs')], {
        env,
        encoding: 'utf8',
        timeout: 60_000,
      })
      const records = String(child.stdout ?? '')
        .split('\n')
        .filter((line) => line.startsWith('RESULT '))
        .map((line) => JSON.parse(line.slice('RESULT '.length)))
      assert.ok(records.length >= 10, `child produced ${records.length} results\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`)
      for (const record of records) {
        assert.equal(record.ok, true, `${record.name}\n    ${record.detail}`)
      }
      assert.equal(child.status, 0, `child exit ${child.status}\n${child.stderr}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
