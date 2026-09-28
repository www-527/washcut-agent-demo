const REFERENCE_SHORT_EDGE_PX = 1_080;
const REFERENCE_FONT_SIZE_PX = 48;
const REFERENCE_HORIZONTAL_PADDING_PX = 64;

/** Keeps the caption baseline around the lower 72% area shown in the reference. */
export const SHORT_VIDEO_CAPTION_BOTTOM_RATIO = 0.27;

const estimatedTextWidthUnits = (text: string) => Array.from(text.trim()).reduce((total, character) => {
  if (/\s/u.test(character)) return total + 0.35;
  if (/[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/u.test(character)) return total + 1;
  if (/[A-Z]/u.test(character)) return total + 0.68;
  if (/[a-z0-9]/u.test(character)) return total + 0.56;
  return total + 0.5;
}, 0);

export const getShortVideoCaptionLayout = (width: number, height: number, text: string) => {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(safeWidth, safeHeight) / REFERENCE_SHORT_EDGE_PX;
  const horizontalPaddingPx = REFERENCE_HORIZONTAL_PADDING_PX * scale;
  const maxWidthPx = Math.max(1, safeWidth - horizontalPaddingPx * 2);
  const baseFontSizePx = REFERENCE_FONT_SIZE_PX * scale;
  const widthUnits = Math.max(1, estimatedTextWidthUnits(text));

  return {
    bottomPx: Math.round(safeHeight * SHORT_VIDEO_CAPTION_BOTTOM_RATIO),
    fontSizePx: Math.min(baseFontSizePx, maxWidthPx / widthUnits / 1.012),
    maxWidthPx,
    shadowBlurPx: 6 * scale,
    shadowOffsetPx: 4 * scale,
    strokePx: 2 * scale,
  };
};
