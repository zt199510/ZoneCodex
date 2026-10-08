export type PngScanlinePlan = {
  passes: Array<{ rowBytes: number; rows: number }>
  expectedBytes: number
}

/** Only arithmetic runs in main; full decompression runs in the sandbox window. */
export function buildPngScanlinePlan(
  bytes: Buffer,
  width: number,
  height: number
): PngScanlinePlan {
  const depth = bytes[24]
  const color = bytes[25]
  const interlace = bytes[28]
  const depths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16]
  }
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  if (!depths[color]?.includes(depth) || (interlace !== 0 && interlace !== 1))
    throw new Error('PNG 编码格式无效')
  const geometry =
    interlace === 0
      ? [[0, 0, 1, 1]]
      : [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2]
        ]
  const passes: PngScanlinePlan['passes'] = []
  for (const [x, y, dx, dy] of geometry) {
    const columns = width <= x ? 0 : Math.ceil((width - x) / dx)
    const rows = height <= y ? 0 : Math.ceil((height - y) / dy)
    if (!columns || !rows) continue
    passes.push({ rowBytes: Math.ceil((columns * channels[color] * depth) / 8), rows })
  }
  const expectedBytes = passes.reduce((sum, pass) => sum + (pass.rowBytes + 1) * pass.rows, 0)
  return { passes, expectedBytes }
}

/** Serialized into the disposable renderer; has no closures or Node dependencies. */
export async function validatePngScanlines(
  bytes: Uint8Array<ArrayBuffer>,
  plan: PngScanlinePlan
): Promise<void> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let chunkPosition = 0
  let chunkEnd = 0
  const encoded = new ReadableStream<BufferSource>({
    pull(controller) {
      while (chunkPosition >= chunkEnd) {
        if (offset + 12 > bytes.length) {
          controller.close()
          return
        }
        const length = view.getUint32(offset)
        const start = offset + 8
        const end = start + length
        if (end + 4 > bytes.length) throw new Error('PNG 图片数据不完整')
        const idat =
          bytes[offset + 4] === 73 &&
          bytes[offset + 5] === 68 &&
          bytes[offset + 6] === 65 &&
          bytes[offset + 7] === 84
        offset = end + 4
        if (idat && length > 0) {
          chunkPosition = start
          chunkEnd = end
        }
      }
      // Bound each compressed write too: an inflater must not queue a whole
      // highly compressed image before the reader can enforce its output cap.
      const end = Math.min(chunkPosition + 1024, chunkEnd)
      controller.enqueue(bytes.subarray(chunkPosition, end))
      chunkPosition = end
    }
  })
  const reader = encoded.pipeThrough(new DecompressionStream('deflate')).getReader()
  let count = 0
  let passIndex = 0
  let rows = plan.passes[0]?.rows ?? 0
  let remainingInRow = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.byteLength > plan.expectedBytes - count)
        throw new Error('PNG 图片扫描行超过预期长度')
      count += value.byteLength
      let cursor = 0
      while (cursor < value.byteLength) {
        const pass = plan.passes[passIndex]
        if (!pass) throw new Error('PNG 图片包含多余扫描行')
        if (remainingInRow === 0) {
          if (value[cursor++] > 4) throw new Error('PNG 图片扫描行过滤方式无效')
          remainingInRow = pass.rowBytes
        }
        const take = Math.min(remainingInRow, value.byteLength - cursor)
        cursor += take
        remainingInRow -= take
        if (remainingInRow === 0) {
          rows--
          if (rows === 0) {
            passIndex++
            rows = plan.passes[passIndex]?.rows ?? 0
          }
        }
      }
    }
    // Read through stream completion: this also checks the zlib trailer/Adler32
    // and rejects truncated streams after an otherwise complete last row.
    if (count !== plan.expectedBytes || passIndex !== plan.passes.length || remainingInRow !== 0)
      throw new Error('PNG 图片扫描行不完整')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
