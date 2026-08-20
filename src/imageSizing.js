const GPT_IMAGE_2_MIN_PIXELS = 655_360
const GPT_IMAGE_2_MAX_PIXELS = 8_294_400
const GPT_IMAGE_2_MAX_EDGE = 3840
const GPT_IMAGE_2_MAX_RATIO = 3
const GPT_IMAGE_2_SIZE_STEP = 16
const DEFAULT_TARGET_PIXELS = 1024 * 1024

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function candidateScore(width, height, targetRatio, targetPixels) {
  const ratioError = Math.abs(Math.log((width / height) / targetRatio))
  const pixelError = Math.abs(Math.log((width * height) / targetPixels))
  return ratioError * 100 + pixelError
}

export function fitGptImage2OutputSize(sourceWidth, sourceHeight, targetPixels = DEFAULT_TARGET_PIXELS) {
  const originalWidth = positiveNumber(sourceWidth)
  const originalHeight = positiveNumber(sourceHeight)
  if (!originalWidth || !originalHeight) {
    return { width: 1024, height: 1024, size: '1024x1024', ratioLimited: false }
  }

  const originalRatio = originalWidth / originalHeight
  const targetRatio = Math.min(GPT_IMAGE_2_MAX_RATIO, Math.max(1 / GPT_IMAGE_2_MAX_RATIO, originalRatio))
  const safeTargetPixels = Math.min(GPT_IMAGE_2_MAX_PIXELS, Math.max(GPT_IMAGE_2_MIN_PIXELS, positiveNumber(targetPixels) || DEFAULT_TARGET_PIXELS))
  let best = null

  for (let height = GPT_IMAGE_2_SIZE_STEP; height <= GPT_IMAGE_2_MAX_EDGE; height += GPT_IMAGE_2_SIZE_STEP) {
    const idealWidth = height * targetRatio
    const nearestWidth = Math.round(idealWidth / GPT_IMAGE_2_SIZE_STEP) * GPT_IMAGE_2_SIZE_STEP
    for (const width of [nearestWidth - GPT_IMAGE_2_SIZE_STEP, nearestWidth, nearestWidth + GPT_IMAGE_2_SIZE_STEP]) {
      if (width < GPT_IMAGE_2_SIZE_STEP || width > GPT_IMAGE_2_MAX_EDGE) continue
      const pixels = width * height
      if (pixels < GPT_IMAGE_2_MIN_PIXELS || pixels > GPT_IMAGE_2_MAX_PIXELS) continue
      if (Math.max(width, height) / Math.min(width, height) > GPT_IMAGE_2_MAX_RATIO) continue
      const score = candidateScore(width, height, targetRatio, safeTargetPixels)
      if (!best || score < best.score || (score === best.score && pixels < best.pixels)) {
        best = { width, height, pixels, score }
      }
    }
  }

  const result = best || { width: 1024, height: 1024 }
  return {
    width: result.width,
    height: result.height,
    size: `${result.width}x${result.height}`,
    ratioLimited: originalRatio > GPT_IMAGE_2_MAX_RATIO || originalRatio < 1 / GPT_IMAGE_2_MAX_RATIO,
  }
}
