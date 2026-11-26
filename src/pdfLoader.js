import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs';

const PT_TO_MM = 25.4 / 72;

/**
 * Inspects raw PDF bytes to extract TrimBox / BleedBox / CropBox / MediaBox
 * from the first page dictionary so print-ready PDFs (InDesign, Illustrator)
 * automatically strip crop marks and bleed.
 */
export function extractPdfBoxes(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  // Decode as latin1 to safely search ASCII PDF tokens
  const chunkSize = 0x8000;
  let text = '';
  // Usually page boxes appear near the start or end (xref/catalog); scan whole file if <= 12MB
  const limit = Math.min(bytes.length, 12 * 1024 * 1024);
  for (let i = 0; i < limit; i += chunkSize) {
    text += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, limit)));
  }

  const readBox = (name) => {
    const regex = new RegExp(`/${name}\\s*\\[\\s*([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s*\\]`);
    const match = text.match(regex);
    if (!match) return null;
    const nums = match.slice(1, 5).map(Number);
    if (nums.some((n) => Number.isNaN(n))) return null;
    return nums; // [x1, y1, x2, y2] in PDF points (bottom-left origin)
  };

  return {
    mediaBox: readBox('MediaBox'),
    cropBox: readBox('CropBox'),
    bleedBox: readBox('BleedBox'),
    trimBox: readBox('TrimBox'),
  };
}

/**
 * Renders a PDF page onto an HTMLCanvasElement, optionally cropping to TrimBox + extraCropMm.
 */
async function renderPageToCanvas(pdfPage, boxes, targetMaxPx, extraCropMm = 0) {
  // PDF.js page.view is [x1, y1, x2, y2] (usually CropBox or MediaBox)
  const view = pdfPage.view;
  const viewW = view[2] - view[0];
  const viewH = view[3] - view[1];

  // Determine active crop rectangle in PDF coordinates
  let activeBox = view;
  let hasTrimBox = false;
  if (boxes?.trimBox) {
    const [tx1, ty1, tx2, ty2] = boxes.trimBox;
    const tw = tx2 - tx1;
    const th = ty2 - ty1;
    // Validate TrimBox is inside or equal to view and reasonably sized
    if (tw > 20 && th > 20 && tw <= viewW + 2 && th <= viewH + 2) {
      activeBox = boxes.trimBox;
      hasTrimBox = true;
    }
  }

  const extraPt = extraCropMm / PT_TO_MM;
  const cropX1 = Math.max(view[0], activeBox[0] + extraPt);
  const cropY1 = Math.max(view[1], activeBox[1] + extraPt);
  const cropX2 = Math.min(view[2], activeBox[2] - extraPt);
  const cropY2 = Math.min(view[3], activeBox[3] - extraPt);

  const cropW = Math.max(10, cropX2 - cropX1);
  const cropH = Math.max(10, cropY2 - cropY1);

  // Scale so the cropped region hits targetMaxPx on its longest side
  const scale = targetMaxPx / Math.max(cropW, cropH);
  const fullViewport = pdfPage.getViewport({ scale });

  // Render full page to offscreen canvas
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = Math.round(fullViewport.width);
  fullCanvas.height = Math.round(fullViewport.height);
  const fullCtx = fullCanvas.getContext('2d', { alpha: false });
  fullCtx.fillStyle = '#ffffff';
  fullCtx.fillRect(0, 0, fullCanvas.width, fullCanvas.height);

  await pdfPage.render({
    canvasContext: fullCtx,
    viewport: fullViewport,
    intent: 'print',
  }).promise;

  // Convert PDF bottom-left crop coords to canvas top-left pixel coords
  const sx = Math.round((cropX1 - view[0]) * scale);
  const sy = Math.round((view[3] - cropY2) * scale);
  const sw = Math.round(cropW * scale);
  const sh = Math.round(cropH * scale);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = Math.max(2, sw);
  outCanvas.height = Math.max(2, sh);
  const outCtx = outCanvas.getContext('2d', { alpha: false });
  outCtx.fillStyle = '#ffffff';
  outCtx.fillRect(0, 0, outCanvas.width, outCanvas.height);
  outCtx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, outCanvas.width, outCanvas.height);

  return {
    canvas: outCanvas,
    widthMm: cropW * PT_TO_MM,
    heightMm: cropH * PT_TO_MM,
    rawWidthMm: viewW * PT_TO_MM,
    rawHeightMm: viewH * PT_TO_MM,
    hasTrimBox,
  };
}

/**
 * Loads a cover PDF (typically Back + Spine + Front spread on page 1).
 */
export async function loadCoverPdf(arrayBuffer, extraCropMm = 0) {
  const boxes = extractPdfBoxes(arrayBuffer);
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  const page = await pdf.getPage(1);

  // Render at high resolution (3600px wide) for crisp 4K video export
  const rendered = await renderPageToCanvas(page, boxes, 3600, extraCropMm);
  await pdf.destroy();

  return {
    ...rendered,
    isSpread: rendered.widthMm > rendered.heightMm * 1.15,
    boxes,
  };
}

/**
 * Slices a full cover spread canvas into Back, Spine, and Front canvases
 * according to the exact physical coverWidthMm and spineWidthMm.
 */
export function sliceCoverCanvas(coverCanvas, coverWidthMm, spineWidthMm) {
  const w = coverCanvas.width;
  const h = coverCanvas.height;

  const spineRatio = Math.min(0.45, Math.max(0.01, spineWidthMm / coverWidthMm));
  const sideRatio = (1 - spineRatio) / 2;

  const backW = Math.round(w * sideRatio);
  const spineW = Math.max(4, Math.round(w * spineRatio));
  const frontX = backW + spineW;
  const frontW = Math.max(4, w - frontX);

  const crop = (sx, sw) => {
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = h;
    const ctx = c.getContext('2d', { alpha: false });
    ctx.drawImage(coverCanvas, sx, 0, sw, h, 0, 0, sw, h);
    return c;
  };

  // Also sample an average edge color from the cover for board edges
  const edgeColor = sampleEdgeColor(coverCanvas);

  const backCanvas = crop(0, backW);
  const spineCanvas = crop(backW, spineW);
  const frontCanvas = crop(frontX, frontW);

  // Build realistic hardcover inside-board textures with folded cover turn-ins
  // (using the outer edges of the cover art folded inward around top, bottom, and fore-edge)
  const frontInsideCanvas = buildInsideBoardCanvas(frontCanvas, 'front');
  const backInsideCanvas = buildInsideBoardCanvas(backCanvas, 'back');

  return {
    backCanvas,
    spineCanvas,
    frontCanvas,
    frontInsideCanvas,
    backInsideCanvas,
    edgeColor,
  };
}

/**
 * Generates an inside-cover texture with realistic folded cover edges (turn-ins)
 * around top, bottom, and fore-edge, and a textured cream endpaper pasted in the center.
 * @param {HTMLCanvasElement} outerCanvas Front or Back cover canvas
 * @param {'front'|'back'} side 'front' (fore-edge is LEFT on inside -z face) or 'back' (fore-edge is RIGHT on inside +z face)
 */
function buildInsideBoardCanvas(outerCanvas, side) {
  const w = Math.min(1024, outerCanvas.width);
  const h = Math.round((outerCanvas.height / outerCanvas.width) * w);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { alpha: false });

  // 1. Draw horizontally mirrored outer cover as base so the folded edges match the real print art seamlessly
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(outerCanvas, 0, 0, w, h);
  ctx.restore();

  // Slightly darken the folded turn-in edges for realistic interior lighting
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fillRect(0, 0, w, h);

  // 2. Paste the endpaper sheet inside, leaving a ~6.5% (~15mm) folded cover turn-in margin
  // on Top, Bottom, and Fore-edge (leaving Spine side flush with endpaper)
  const marginX = Math.round(w * 0.065);
  const marginY = Math.round(h * 0.062);

  const epX = side === 'front' ? marginX : 0;
  const epW = w - marginX;
  const epY = marginY;
  const epH = h - marginY * 2;

  // Subtle drop shadow where pasted endpaper meets folded cover cloth/paper
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
  ctx.shadowBlur = Math.max(4, Math.round(w * 0.008));
  ctx.fillStyle = '#f7f4ec';
  ctx.fillRect(epX, epY, epW, epH);
  ctx.restore();

  // Fine paper grain on the pasted endpaper
  ctx.fillStyle = 'rgba(0, 0, 0, 0.018)';
  for (let i = 0; i < 1800; i++) {
    const gx = epX + Math.random() * epW;
    const gy = epY + Math.random() * epH;
    ctx.fillRect(gx, gy, 2, 2);
  }

  // Subtle crease line near the spine edge
  const creaseX = side === 'front' ? w - Math.round(w * 0.03) : Math.round(w * 0.03);
  const grad = ctx.createLinearGradient(creaseX - 10, 0, creaseX + 10, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.08)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(creaseX - 10, 0, 20, h);

  return c;
}

function sampleEdgeColor(canvas) {
  const ctx = canvas.getContext('2d');
  const sample = ctx.getImageData(Math.floor(canvas.width * 0.03), Math.floor(canvas.height * 0.5), 1, 1).data;
  const toHex = (v) => v.toString(16).padStart(2, '0');
  return `#${toHex(sample[0])}${toHex(sample[1])}${toHex(sample[2])}`;
}

/**
 * Loads interior pages PDF and renders pages to canvases.
 */
export async function loadInteriorPdf(arrayBuffer, onProgress = () => {}) {
  const boxes = extractPdfBoxes(arrayBuffer);
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  const totalPages = pdf.numPages;

  // Render pages at 960px (crisp even in 4K while keeping GPU texture memory smooth)
  const targetPx = totalPages > 60 ? 720 : 960;
  const pageCanvases = [];
  let pageWidthMm = 210;
  let pageHeightMm = 297;
  let hasTrimBox = false;

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdf.getPage(i);
    const rendered = await renderPageToCanvas(page, boxes, targetPx, 0);
    if (i === 1) {
      pageWidthMm = rendered.widthMm;
      pageHeightMm = rendered.heightMm;
      hasTrimBox = rendered.hasTrimBox;
    }
    pageCanvases.push(rendered.canvas);
    onProgress(i / totalPages, i, totalPages);
  }

  await pdf.destroy();

  return {
    pages: pageCanvases,
    numPages: totalPages,
    pageWidthMm,
    pageHeightMm,
    hasTrimBox,
  };
}

/**
 * Infers exact book geometry (page size, cover overhang, spine width, hardcover vs softcover)
 * from the uploaded Cover PDF and Interior PDF.
 */
export function detectBookFormat(coverData, interiorData) {
  const pageWidthMm = interiorData ? interiorData.pageWidthMm : (coverData ? (coverData.widthMm * 0.48) : 240);
  const pageHeightMm = interiorData ? interiorData.pageHeightMm : (coverData ? coverData.heightMm : 240);

  let coverWidthMm = coverData ? coverData.widthMm : pageWidthMm * 2 + 12;
  let coverHeightMm = coverData ? coverData.heightMm : pageHeightMm + 6;

  // Detect hardcover overhang if cover TrimBox is taller than interior page TrimBox
  const heightDiff = coverHeightMm - pageHeightMm;
  const detectedHardcover = heightDiff > 1.5;
  const overhangMm = detectedHardcover ? Math.min(8, Math.max(2, heightDiff / 2)) : 0;

  let spineWidthMm = 12;
  if (coverData && coverData.isSpread) {
    const estimatedBoardW = pageWidthMm + overhangMm;
    const computedSpine = coverWidthMm - 2 * estimatedBoardW;
    if (computedSpine >= 3 && computedSpine <= 90) {
      spineWidthMm = Math.round(computedSpine * 2) / 2;
    } else if (interiorData) {
      // Estimate from page count (~0.14mm per sheet for children's/art books)
      spineWidthMm = Math.max(6, Math.round((interiorData.numPages / 2) * 0.18 + (detectedHardcover ? 4 : 0)));
    }
  } else if (interiorData) {
    spineWidthMm = Math.max(6, Math.round((interiorData.numPages / 2) * 0.18 + 3));
  }

  return {
    pageWidthMm: Math.round(pageWidthMm * 10) / 10,
    pageHeightMm: Math.round(pageHeightMm * 10) / 10,
    coverWidthMm: Math.round(coverWidthMm * 10) / 10,
    coverHeightMm: Math.round(coverHeightMm * 10) / 10,
    spineWidthMm,
    overhangMm: Math.round(overhangMm * 10) / 10,
    recommendedCoverType: detectedHardcover ? 'hardcover' : 'softcover',
    numPages: interiorData ? interiorData.numPages : 0,
  };
}
