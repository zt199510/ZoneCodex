import { BrowserWindow } from 'electron'
import {
  imageThumbnailDimension,
  maxThumbnailBytes,
  maxImageDimension,
  maxImagePixels
} from '../../shared/image-input'
import type { ImageHeader } from './image-validation'
import { buildPngScanlinePlan, validatePngScanlines } from './png-scanlines'

const decodeTimeoutMs = 5000
export type DecodedImage = { thumbnail: Buffer; width: number; height: number }

/** Untrusted pixel decoding runs in a disposable sandbox renderer, never main. */
export async function decodeImageThumbnail(
  bytes: Buffer,
  header: ImageHeader,
  signal: AbortSignal
): Promise<DecodedImage> {
  signal.throwIfAborted()
  const window = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'zonecodex-image-decoder',
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  let rejectCancellation: (error: Error) => void = () => undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })
  const stop = (error: Error): void => {
    rejectCancellation(error)
    if (!window.isDestroyed()) window.destroy()
  }
  const abort = (): void => stop(new Error('图片导入已取消'))
  const timer = setTimeout(
    () => stop(new Error('图片处理超过 5 秒，请重新添加较小图片')),
    decodeTimeoutMs
  )
  signal.addEventListener('abort', abort, { once: true })
  try {
    const operation = async (): Promise<DecodedImage> => {
      await window.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; base-uri 'none'; form-action 'none'\"><title>图片校验</title>"
          )
      )
      signal.throwIfAborted()
      const dataUrl = `data:${header.mime};base64,${bytes.toString('base64')}`
      const pngPlan =
        header.mime === 'image/png'
          ? buildPngScanlinePlan(bytes, header.width, header.height)
          : null
      const result: unknown = await window.webContents.executeJavaScript(`(async () => {
        const dataUrl = ${JSON.stringify(dataUrl)};
        const pngPlan = ${JSON.stringify(pngPlan)};
        if (pngPlan) {
          const encoded = Uint8Array.from(atob(dataUrl.slice('data:image/png;base64,'.length)), character => character.charCodeAt(0));
          await (${validatePngScanlines.toString()})(encoded, pngPlan);
        }
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        const width=image.naturalWidth, height=image.naturalHeight;
        if (!((width === ${header.width} && height === ${header.height}) ||
              (width === ${header.height} && height === ${header.width})))
          throw new Error('图片实际尺寸与头部不一致');
        if (!width || !height || width > ${maxImageDimension} || height > ${maxImageDimension} || width * height > ${maxImagePixels})
          throw new Error('图片实际尺寸超过上限');
        const ratio = Math.min(1, ${imageThumbnailDimension} / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法生成图片预览');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return {thumbnailDataUrl:canvas.toDataURL('image/png'),width,height};
      })()`)
      signal.throwIfAborted()
      const prefix = 'data:image/png;base64,'
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new Error('图片解码结果无效')
      const decoded = result as Record<string, unknown>
      const url = decoded.thumbnailDataUrl
      const width = decoded.width,
        height = decoded.height
      if (
        typeof width !== 'number' ||
        typeof height !== 'number' ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        width > maxImageDimension ||
        height > maxImageDimension ||
        width * height > maxImagePixels ||
        !(
          (width === header.width && height === header.height) ||
          (width === header.height && height === header.width)
        )
      )
        throw new Error('图片解码尺寸无效')
      if (
        typeof url !== 'string' ||
        !url.startsWith(prefix) ||
        url.length > prefix.length + Math.ceil(maxThumbnailBytes / 3) * 4
      )
        throw new Error('图片缩略图超过上限或无效')
      const thumbnail = Buffer.from(url.slice(prefix.length), 'base64')
      if (!thumbnail.length || thumbnail.length > maxThumbnailBytes)
        throw new Error('图片缩略图无效')
      return { thumbnail, width, height }
    }
    return await Promise.race([operation(), cancelled])
  } catch (error) {
    if (signal.aborted) throw new Error('图片导入已取消')
    if (error instanceof Error && error.message.includes('5 秒')) throw error
    throw new Error('图片损坏或无法解码，请重新添加 PNG/JPEG')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    if (!window.isDestroyed()) window.destroy()
  }
}
