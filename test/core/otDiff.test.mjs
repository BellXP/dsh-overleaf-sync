import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { diffToOps, applyOps } from '../../lib/core/otDiff.js'

describe('diffToOps (real-time applyOtUpdateSchema)', () => {
  it('never puts i and d in one operation: the strict server schema rejects that as "Invalid input"', () => {
    const base = 'hello world'
    const next = 'hello brave world'
    const ops = diffToOps(base, next)
    assert.ok(ops.length > 0)
    for (const op of ops) {
      assert.ok(Number.isInteger(op.p) && op.p >= 0)
      assert.ok(('i' in op) !== ('d' in op), `op ${JSON.stringify(op)} must carry exactly one of i/d`)
      if (op.i !== undefined) assert.ok(op.i.length > 0)
      if (op.d !== undefined) assert.ok(op.d.length > 0)
    }
    assert.equal(applyOps(base, ops), next)
  })

  it('emits the delete before the insert of a replace, both at the same position', () => {
    const ops = diffToOps('abc', 'aXc')
    assert.deepEqual(ops, [{ p: 1, d: 'b' }, { p: 1, i: 'X' }])
  })

  it('pure insert and pure delete stay single operations', () => {
    assert.deepEqual(diffToOps('ac', 'abc'), [{ p: 1, i: 'b' }])
    assert.deepEqual(diffToOps('abc', 'ac'), [{ p: 1, d: 'b' }])
    assert.deepEqual(diffToOps('same', 'same'), [])
  })

  it('whole-file replacement round-trips for a multi-line LaTeX document', () => {
    const base = '% old\n\\section{A}\ntext\n'
    const next = '% new\n\\section{B}\nother text\n\\end\n'
    const ops = diffToOps(base, next)
    assert.equal(applyOps(base, ops), next)
    assert.equal(ops.length, 2)
  })
})
