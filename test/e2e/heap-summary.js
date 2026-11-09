// Summarizes a V8 .heapsnapshot: total self size by node type and by constructor/name, and the largest single strings.
// usage: node test/e2e/heap-summary.js <file.heapsnapshot> [top]
const fs = require('fs')
const [file, topArg] = process.argv.slice(2)
const top = Number(topArg) || 25
const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'))
const meta = snapshot.snapshot.meta
const fields = meta.node_fields
const types = meta.node_types[0]
const nodes = snapshot.nodes
const strings = snapshot.strings
const width = fields.length
const typeAt = fields.indexOf('type')
const nameAt = fields.indexOf('name')
const sizeAt = fields.indexOf('self_size')
const byType = {}
const byName = {}
const bigStrings = []
let total = 0
for (let i = 0; i < nodes.length; i += width) {
  const type = types[nodes[i + typeAt]]
  const name = strings[nodes[i + nameAt]]
  const size = nodes[i + sizeAt]
  total += size
  byType[type] = (byType[type] || 0) + size
  const key = type === 'object' || type === 'closure' || type === 'native' || type === 'array' ? type + ' ' + name : type
  byName[key] = byName[key] || { size: 0, count: 0 }
  byName[key].size += size
  byName[key].count++
  if ((type === 'string' || type === 'concatenated string') && size > 100000) {
    bigStrings.push({ size, text: String(name).slice(0, 90).replace(/\s+/g, ' ') })
  }
}
const mb = n => Math.round(n / 1048576 * 10) / 10
console.log('total self size: ' + mb(total) + ' MB, nodes: ' + nodes.length / width)
console.log('by type: ' + Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, s]) => t + ' ' + mb(s)).join(', '))
console.log('largest groups:')
Object.entries(byName).sort((a, b) => b[1].size - a[1].size).slice(0, top).forEach(([k, v]) => console.log('  ' + mb(v.size) + ' MB  x' + v.count + '  ' + k.slice(0, 100)))
console.log('largest strings:')
bigStrings.sort((a, b) => b.size - a.size).slice(0, 15).forEach(s => console.log('  ' + mb(s.size) + ' MB  ' + s.text))
