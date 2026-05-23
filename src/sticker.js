import sharp from "sharp";

sharp.cache(false);
sharp.concurrency(1);

const MAX_STICKER_BYTES = Number(process.env.MAX_STICKER_BYTES || 100 * 1024);

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
  const boxSizes = options.noPad
    ? [512, 496, 480, 448, 416, 384]
    : [512, 504, 496, 480, 464, 448, 416, 384, 352, 320];

  let smallest = null;

  for (const boxSize of boxSizes) {
    let low = options.high ? 45 : 32;
    let high = options.high ? 98 : 94;
    let bestUnderLimit = null;
    let bestQuality = 0;

    for (let attempt = 0; attempt < 8; attempt++) {
      const quality = Math.floor((low + high) / 2);
      const output = await renderWebp(inputBuffer, { ...options, boxSize, quality });

      if (!smallest || output.length < smallest.length) {
        smallest = output;
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
        quality: bestQuality
      };
    }
  }

  const finalSize = smallest?.length || 0;
  throw new Error(`Cannot compress sticker under ${MAX_STICKER_BYTES} bytes. Smallest=${finalSize}`);
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

  let pipeline = sharp(inputBuffer, { failOn: "none", limitInputPixels: 25_000_000 })
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

  return pipeline
    .webp({
      quality,
      alphaQuality: 100,
      effort: 6,
      smartSubsample: true,
      preset
    })
    .toBuffer();
}
