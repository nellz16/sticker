import sharp from "sharp";

sharp.cache(false);
sharp.concurrency(1);

const MAX_STICKER_BYTES = Number(process.env.MAX_STICKER_BYTES || 100 * 1024);
const WEBP_EFFORT = Number(process.env.WEBP_EFFORT || 4);
const QUALITY_ATTEMPTS = Number(process.env.QUALITY_ATTEMPTS || 6);
const MAX_INPUT_PIXELS = Number(process.env.MAX_INPUT_PIXELS || 12_000_000);

function parseBoxSizes() {
  const raw = process.env.BOX_SIZES || "";
  const parsed = raw
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x > 0 && x <= 512);

  return parsed.length ? parsed : null;
}

export function parseStickerOptions(text = "") {
  const caption = text.toLowerCase();

  const mode = caption.includes("cover")
    ? "cover"
    : caption.includes("contain")
      ? "contain"
      : (process.env.DEFAULT_MODE || "contain");

  const preset = caption.includes("text")
    ? "text"
    : caption.includes("icon")
      ? "icon"
      : caption.includes("draw")
        ? "drawing"
        : caption.includes("photo")
          ? "photo"
          : "picture";

  return {
    mode,
    preset,
    pixel: caption.includes("pixel"),
    white: caption.includes("white"),
    noPad: caption.includes("nopad"),
    high: caption.includes("high")
  };
}

export async function makeSticker(inputBuffer, options = {}) {
  const envBoxSizes = parseBoxSizes();

  const boxSizes = envBoxSizes || (
    options.noPad
      ? [512, 496, 480, 448, 416, 384]
      : [512, 496, 480, 448, 416, 384, 352]
  );

  let smallestBytes = Number.POSITIVE_INFINITY;

  for (const boxSize of boxSizes) {
    let low = options.high ? 45 : 32;
    let high = options.high ? 98 : 92;
    let bestUnderLimit = null;
    let bestQuality = 0;

    for (let attempt = 0; attempt < QUALITY_ATTEMPTS; attempt++) {
      const quality = Math.floor((low + high) / 2);
      const output = await renderWebp(inputBuffer, { ...options, boxSize, quality });

      if (output.length < smallestBytes) {
        smallestBytes = output.length;
      }

      if (output.length <= MAX_STICKER_BYTES) {
        bestUnderLimit = output;
        bestQuality = quality;
        low = quality + 1;
      } else {
        high = quality - 1;
      }
    }

    if (bestUnderLimit) {
      return {
        buffer: bestUnderLimit,
        bytes: bestUnderLimit.length,
        boxSize,
        quality: bestQuality,
        webpEffort: WEBP_EFFORT
      };
    }
  }

  throw new Error(`Cannot compress sticker under ${MAX_STICKER_BYTES} bytes. Smallest=${smallestBytes}`);
}

async function renderWebp(inputBuffer, options) {
  const {
    boxSize,
    quality,
    mode = "contain",
    preset = "picture",
    pixel = false,
    white = false
  } = options;

  const background = white
    ? { r: 255, g: 255, b: 255, alpha: 1 }
    : { r: 0, g: 0, b: 0, alpha: 0 };

  const kernel = pixel ? sharp.kernel.nearest : sharp.kernel.lanczos3;

  let pipeline = sharp(inputBuffer, { failOn: "none", limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({
      width: boxSize,
      height: boxSize,
      fit: mode === "cover" ? "cover" : "contain",
      position: "centre",
      background,
      kernel,
      withoutEnlargement: false
    });

  if (boxSize < 512) {
    const totalPadding = 512 - boxSize;
    const before = Math.floor(totalPadding / 2);
    const after = totalPadding - before;

    pipeline = pipeline.extend({
      top: before,
      bottom: after,
      left: before,
      right: after,
      background
    });
  }

  const buffer = await pipeline
    .webp({
      quality,
      alphaQuality: 100,
      effort: WEBP_EFFORT,
      smartSubsample: true,
      preset
    })
    .toBuffer();

  if (pipeline?.destroy) pipeline.destroy();
  return buffer;
}

export function getSharpDiagnostics() {
  return {
    cache: sharp.cache(),
    counters: sharp.counters(),
    concurrency: sharp.concurrency()
  };
}

export function trimSharpCache() {
  sharp.cache(false);
}
