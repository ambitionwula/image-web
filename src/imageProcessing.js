import { fitGptImage2OutputSize } from './imageSizing.js'

const REENCODE_THRESHOLD_BYTES = 8_000_000
const LOSSY_QUALITY = 0.94
const COMPACT_QUALITY_STEPS = [0.86, 0.76, 0.66, 0.56]

function outputType(file, compact = false) {
  if (compact) return { mime: 'image/webp', extension: 'webp' }
  const type = (file?.type || '').toLowerCase()
  if (type === 'image/jpeg' || type === 'image/jpg') return { mime: 'image/jpeg', extension: 'jpg' }
  if (type === 'image/webp') return { mime: 'image/webp', extension: 'webp' }
  return { mime: 'image/png', extension: 'png' }
}

function optimizedFilename(filename, extension) {
  const base = (filename || 'image').replace(/\.[^.]+$/, '') || 'image'
  return `${base}-optimized.${extension}`
}

function canvasBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('浏览器无法导出优化后的图片')), mime, quality)
  })
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
  }

  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'async'
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = () => reject(new Error('浏览器无法解码该图片格式'))
      image.src = url
    })
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => {} }
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function formatImageBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 1 : 2)} MB`
}

export function fitGptImageInputSize(originalWidth, originalHeight, targetPixels) {
  const width = Math.max(1, Math.round(Number(originalWidth) || 1))
  const height = Math.max(1, Math.round(Number(originalHeight) || 1))
  const fittedOutput = fitGptImage2OutputSize(width, height, targetPixels)
  const scale = Math.min(1, Math.sqrt((fittedOutput.width * fittedOutput.height) / (width * height)))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export async function optimizeImageForGpt(file, options = {}) {
  if (!(file instanceof Blob)) throw new Error('没有可处理的图片文件')
  const targetPixels = Number(options.targetPixels) || undefined
  const maxBytes = Math.max(0, Number(options.maxBytes) || 0)
  const skipIfUnderBytes = Math.max(0, Number(options.skipIfUnderBytes) || 0)
  const compact = Boolean(options.compact)
  const forceReencode = Boolean(options.forceReencode)
  const decoded = await decodeImage(file)
  try {
    const originalWidth = decoded.width
    const originalHeight = decoded.height
    if (!originalWidth || !originalHeight) throw new Error('无法读取图片宽高')

    if (skipIfUnderBytes && file.size <= skipIfUnderBytes) {
      return {
        file,
        width: originalWidth,
        height: originalHeight,
        originalWidth,
        originalHeight,
        originalBytes: file.size,
        processedBytes: file.size,
        optimized: false,
      }
    }

    const fittedInput = fitGptImageInputSize(originalWidth, originalHeight, targetPixels)
    let width = fittedInput.width
    let height = fittedInput.height
    const resized = width < originalWidth || height < originalHeight
    const reencode = forceReencode || resized || file.size > REENCODE_THRESHOLD_BYTES || (maxBytes > 0 && file.size > maxBytes)

    if (!reencode) {
      return {
        file,
        width: originalWidth,
        height: originalHeight,
        originalWidth,
        originalHeight,
        originalBytes: file.size,
        processedBytes: file.size,
        optimized: false,
      }
    }

    const canvas = document.createElement('canvas')
    const drawAtSize = () => {
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { alpha: true })
      if (!context) throw new Error('浏览器无法创建图片处理画布')
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(decoded.source, 0, 0, width, height)
    }
    drawAtSize()

    const { mime, extension } = outputType(file, compact)
    const qualities = mime === 'image/png' ? [undefined] : compact ? COMPACT_QUALITY_STEPS : [LOSSY_QUALITY]
    let blob
    for (let resizeRound = 0; resizeRound < 5; resizeRound++) {
      for (const quality of qualities) {
        blob = await canvasBlob(canvas, mime, quality)
        if (!maxBytes || blob.size <= maxBytes) break
      }
      if (!maxBytes || blob.size <= maxBytes) break
      width = Math.max(384, Math.round(width * 0.82))
      height = Math.max(384, Math.round(height * 0.82))
      drawAtSize()
    }
    canvas.width = 1
    canvas.height = 1
    const optimizedFile = new File([blob], optimizedFilename(file.name, extension), {
      type: mime,
      lastModified: file.lastModified || Date.now(),
    })

    return {
      file: optimizedFile,
      width,
      height,
      originalWidth,
      originalHeight,
      originalBytes: file.size,
      processedBytes: optimizedFile.size,
      optimized: true,
    }
  } finally {
    decoded.close()
  }
}
