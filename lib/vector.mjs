// 向量化（v2 增强层，零依赖）
// 用「特征哈希（hashing trick）」把文本映射成归一化向量：CJK 二元组 + 拉丁词 + 数字
// 好处：零依赖、离线、毫秒级，能做余弦相似度 + 聚类；代价：语义能力弱于稠密模型。
// 后续可替换成 bge-small-zh 等稠密模型——只要保持同签名 embed(text, dim) → Float32Array。
// 兜底原则：本模块任何异常都返回零向量，绝不阻塞检索（BM25 基座永远可用）。

const CJK = /[\u3400-\u9fff]/

function features(text) {
  const s = String(text || '').toLowerCase()
  const out = []
  // CJK 二元组（跨标点断开）
  let run = ''
  const flush = () => {
    for (let i = 0; i < run.length - 1; i++) out.push(run[i] + run[i + 1])
    run = ''
  }
  for (const ch of s) {
    if (CJK.test(ch)) run += ch
    else { flush() }
  }
  flush()
  // 拉丁词 / 数字
  for (const w of s.matchAll(/[a-z0-9_]{2,}/g)) out.push('w:' + w[0])
  return out
}

function hashToDim(str, dim) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % dim
}

/** 文本 → 归一化向量（默认 256 维） */
export function embed(text, dim = 256) {
  try {
    const vec = new Float32Array(dim)
    for (const f of features(text)) {
      const i = hashToDim(f, dim)
      const sign = hashToDim(f + '#s', 2) === 0 ? 1 : -1
      vec[i] += sign
    }
    let norm = 0
    for (let i = 0; i < dim; i++) norm += vec[i] * vec[i]
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < dim; i++) vec[i] /= norm
    return vec
  } catch {
    return new Float32Array(dim)
  }
}

/** 余弦相似度（向量已归一化，点积即余弦） */
export function cosine(a, b) {
  try {
    let dot = 0
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) dot += a[i] * b[i]
    return dot
  } catch { return 0 }
}

/** 在 items 里取与 queryVec 最相似的 top-k；items 元素需带 vec */
export function topK(queryVec, items, k = 10) {
  try {
    return items
      .map((it, idx) => ({ idx, sim: it.vec ? cosine(queryVec, it.vec) : 0 }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k)
  } catch { return [] }
}

/** 网格聚类：把 items 按余弦相似度聚到中心（在线、只读、不持久化归属） */
export function cluster(vectors, threshold = 0.75) {
  try {
    const centers = []
    const assign = []
    for (const v of vectors) {
      let best = -1
      let bestSim = threshold
      for (let c = 0; c < centers.length; c++) {
        const sim = cosine(v, centers[c])
        if (sim > bestSim) { bestSim = sim; best = c }
      }
      if (best < 0) { best = centers.length; centers.push(v) }
      assign.push(best)
    }
    return { centers, assign }
  } catch { return { centers: [], assign: [] } }
}
