export interface MuPdfRenderSizingOptions {
  minDpi: number;
  maxDpi: number;
  maxPixels: number;
}

export interface MuPdfRenderSizing {
  scale: number;
  dpi: number;
  widthPx: number;
  heightPx: number;
  pixelCount: number;
  capped: boolean;
}

function roundPixels(value: number): number {
  return Math.max(1, Math.round(value));
}

export function fitMuPdfRenderSizing(widthPt: number, heightPt: number, requestedDpi: number, options: MuPdfRenderSizingOptions): MuPdfRenderSizing {
  const requested = Math.min(options.maxDpi, Math.max(options.minDpi, requestedDpi));
  const requestedScale = requested / 72;
  const requestedWidthPx = roundPixels(widthPt * requestedScale);
  const requestedHeightPx = roundPixels(heightPt * requestedScale);
  const requestedPixels = requestedWidthPx * requestedHeightPx;
  if (requestedPixels <= options.maxPixels) {
    return {
      scale: requestedScale,
      dpi: requested,
      widthPx: requestedWidthPx,
      heightPx: requestedHeightPx,
      pixelCount: requestedPixels,
      capped: false
    };
  }

  const pageAreaPt = Math.max(1, widthPt * heightPt);
  const capScale = Math.sqrt(options.maxPixels / pageAreaPt);
  const minScale = options.minDpi / 72;
  const minPixels = roundPixels(widthPt * minScale) * roundPixels(heightPt * minScale);
  const fittedScale = minPixels <= options.maxPixels
    ? Math.max(minScale, Math.min(requestedScale, capScale))
    : Math.min(requestedScale, capScale);
  const widthPx = roundPixels(widthPt * fittedScale);
  const heightPx = roundPixels(heightPt * fittedScale);
  return {
    scale: fittedScale,
    dpi: Number((fittedScale * 72).toFixed(2)),
    widthPx,
    heightPx,
    pixelCount: widthPx * heightPx,
    capped: true
  };
}

export function fitMuPdfRenderSizingToWidth(widthPt: number, heightPt: number, targetWidthPx: number, options: Pick<MuPdfRenderSizingOptions, "maxPixels">): MuPdfRenderSizing {
  const widthPx = roundPixels(targetWidthPx);
  const scale = widthPx / widthPt;
  const requestedHeightPx = roundPixels(heightPt * scale);
  const requestedPixels = widthPx * requestedHeightPx;
  if (requestedPixels <= options.maxPixels) {
    return {
      scale,
      dpi: Number((scale * 72).toFixed(2)),
      widthPx,
      heightPx: requestedHeightPx,
      pixelCount: requestedPixels,
      capped: false
    };
  }

  const capScale = Math.sqrt(options.maxPixels / Math.max(1, widthPt * heightPt));
  const cappedWidthPx = roundPixels(widthPt * capScale);
  const cappedHeightPx = roundPixels(heightPt * capScale);
  return {
    scale: capScale,
    dpi: Number((capScale * 72).toFixed(2)),
    widthPx: cappedWidthPx,
    heightPx: cappedHeightPx,
    pixelCount: cappedWidthPx * cappedHeightPx,
    capped: true
  };
}
