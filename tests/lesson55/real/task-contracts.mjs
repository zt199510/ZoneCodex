import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
export const hash = (b) => createHash('sha256').update(b).digest('hex')
export const contracts = [
  {
    id: 'price',
    spec: 'lineSubtotalCents(unitPriceCents, quantity) 返回单价乘数量（整数分，含0数量）。discountedTotalCents(subtotalCents, discountBasisPoints) 的折扣单位是万分比，结果按 Math.round 舍入到整数分；0不打折，10000全免。仅修改这两个业务函数内部。',
    functions: [
      'export function lineSubtotalCents(unitPriceCents, quantity) {\n  return unitPriceCents + quantity\n}',
      'export function discountedTotalCents(subtotalCents, discountBasisPoints) {\n  return Math.round(subtotalCents * (1 - discountBasisPoints / 100))\n}'
    ],
    tests: `check('数量乘法', () => assert.equal(api.lineSubtotalCents(1299, 3), 3897));
check('零数量', () => assert.equal(api.lineSubtotalCents(1299, 0), 0));
check('单件', () => assert.equal(api.lineSubtotalCents(699, 1), 699));
check('万分比折扣', () => assert.equal(api.discountedTotalCents(10000, 1250), 8750));
check('舍入整数分', () => assert.equal(api.discountedTotalCents(101, 5000), 51));
check('无折扣', () => assert.equal(api.discountedTotalCents(399, 0), 399));
check('全免', () => assert.equal(api.discountedTotalCents(399, 10000), 0));
check('组合业务', () => assert.equal(api.discountedTotalCents(api.lineSubtotalCents(1299, 3), 1000), 3507));`
  },
  {
    id: 'shipping',
    spec: 'parseQuantity(text) 允许两端空白及十进制数字串（含前导零），返回1..999整数；含小数、后缀、符号、空串、超范围必须抛 RangeError。shippingCents(subtotalCents, remote) 在subtotalCents>=5000时基础运费0，否则500；remote为true始终另加300，含达到免基础运费门槛的情况。仅修改这两个业务函数内部。',
    functions: [
      'export function parseQuantity(text) {\n  return Number.parseInt(text, 10)\n}',
      'export function shippingCents(subtotalCents, remote) {\n  return subtotalCents > 5000 ? 0 : 500 + (remote ? 300 : 0)\n}'
    ],
    tests: `check('正常数量', () => assert.equal(api.parseQuantity(' 007 '), 7));
for (const bad of ['', '0', '-1', '+2', '2.5', '3box', '1000', 'NaN']) check('非法数量:'+bad, () => assert.throws(() => api.parseQuantity(bad), RangeError));
check('上限数量', () => assert.equal(api.parseQuantity('999'), 999));
check('门槛等于', () => assert.equal(api.shippingCents(5000, false), 0));
check('未达门槛', () => assert.equal(api.shippingCents(4999, false), 500));
check('远程未达门槛', () => assert.equal(api.shippingCents(100, true), 800));
check('远程达到门槛', () => assert.equal(api.shippingCents(5000, true), 300));
check('远程超过门槛', () => assert.equal(api.shippingCents(8000, true), 300));`
  },
  {
    id: 'inventory',
    spec: 'reserveStock(available, requested) 只接受非负整数available和requested，否则抛RangeError；最多分配available，返回{allocated, remaining, shortfall}，缺货差额是requested减allocated。refundCents(paidCents, totalQuantity, returnedQuantity) 接受非负整数金额、正整数totalQuantity及0..totalQuantity整数returnedQuantity，非法抛RangeError；退费是 Math.round(paidCents * returnedQuantity / totalQuantity)。仅修改这两个业务函数内部。',
    functions: [
      'export function reserveStock(available, requested) {\n  const allocated = requested\n  return { allocated, remaining: available - allocated, shortfall: 0 }\n}',
      'export function refundCents(paidCents, totalQuantity, returnedQuantity) {\n  return Math.floor(paidCents / totalQuantity) * returnedQuantity\n}'
    ],
    tests: `check('库存充足', () => assert.deepEqual(api.reserveStock(8, 3), {allocated:3,remaining:5,shortfall:0}));
check('库存不足', () => assert.deepEqual(api.reserveStock(2, 5), {allocated:2,remaining:0,shortfall:3}));
check('零库存', () => assert.deepEqual(api.reserveStock(0, 5), {allocated:0,remaining:0,shortfall:5}));
for (const values of [[-1,2],[3,-1],[2.5,1],[2,1.5]]) check('库存非法:'+values, () => assert.throws(() => api.reserveStock(...values), RangeError));
check('比例舍入', () => assert.equal(api.refundCents(1000, 3, 2), 667));
check('全退', () => assert.equal(api.refundCents(1000, 3, 3), 1000));
check('零退', () => assert.equal(api.refundCents(1000, 3, 0), 0));
for (const values of [[1000,0,0],[1000,3,4],[-1,3,1],[1000,3,1.5],[1000,3,-1]]) check('退费非法:'+values, () => assert.throws(() => api.refundCents(...values), RangeError));`
  }
]
export function materialize(c) {
  const lines = []
  for (let i = 1; i <= 490; i++) {
    if (i === 83 || i === 359) {
      const n = i === 83 ? 0 : 1
      lines.push(
        '// BUSINESS AREA ' + n + ' BEGIN',
        ...c.functions[n].split('\n'),
        '// BUSINESS AREA ' + n + ' END'
      )
    } else
      lines.push(
        '// Reference ' +
          String(i).padStart(4, '0') +
          ': ' +
          'local catalog explanatory material '.repeat(3) +
          '旁路中文正文必须保持，不参与业务计算。'
      )
  }
  const source = Buffer.from('\ufeff' + (lines.join('\n') + '\n\n\n').replaceAll('\n', '\r\n'))
  assert.ok(source.length > 32768 && source.length <= 131072)
  const test = Buffer.from(
    `import assert from 'node:assert/strict';\nimport * as api from './business.ts';\nconst failures=[];let checks=0;\nfunction check(name,fn){checks++;try{fn()}catch(e){failures.push({name,message:e.message})}}\n${c.tests}\nconsole.log(JSON.stringify({scenario:${JSON.stringify(c.id)},checks,failures}));\nprocess.exitCode=failures.length?1:0;\n`
  )
  return { source, test, totalLines: source.toString('utf8').split('\n').length }
}
export function outsideBusiness(bytes) {
  let s = bytes.toString('utf8')
  for (let n = 0; n < 2; n++) {
    const a = '// BUSINESS AREA ' + n + ' BEGIN\r\n',
      b = '// BUSINESS AREA ' + n + ' END'
    assert.equal(s.split(a).length, 2)
    assert.equal(s.split(b).length, 2)
    const start = s.indexOf(a) + a.length,
      end = s.indexOf(b, start)
    s = s.slice(0, start) + '<business body>\r\n' + s.slice(end)
  }
  return Buffer.from(s)
}
