export enum ExtractionStatus {
  pending = "pending",
  processing = "processing",
  done = "done",
  failed = "failed"
}

export type SemanticTag = "h1" | "h2" | "h3" | "p" | "span" | "caption" | "table" | "artifact" | "img" | "equation";

export type SemanticBoxTag = "p" | "h1" | "h2" | "h3" | "caption" | "table" | "img" | "equation";

export interface SemanticBox {
  id: string;
  tag: SemanticBoxTag;
  x: number;
  y: number;
  w: number;
  h: number;
  createdAt: string;
  readingOrder?: number;
  math?: {
    latex?: string;
    mathml?: string;
    mathmlStatus?: "pending" | "ok" | "failed";
    mathmlError?: string;
    renderStyle?: {
      fontSizePx: number;
      color: string;
      fontFamily: string;
      cssFontFamily: string;
      leftOffsetPx: number;
      topOffsetPx: number;
      widthPx: number;
      heightPx: number;
      sourceWordCount: number;
    };
    status?: "pending" | "ok" | "unavailable" | "failed";
    engine?: string;
    error?: string;
    cropFileName?: string;
    recognizedAt?: string;
  };
}

export type SpanCorrectionScope = "span" | "page-font-size" | "book-font-size";

export interface SpanCorrection {
  id: string;
  scope: SpanCorrectionScope;
  pageIndex: number;
  wordIndex: number;
  cssClassName?: string;
  fontFamily: string;
  fontSizePx: number;
  fontWeight: string;
  fontStyle: string;
  topDeltaPx: number;
  leftDeltaPx: number;
  letterSpacingPx: number;
  createdAt: string;
  updatedAt: string;
}

export interface BlockStyles {
  textIndent: number;
  paddingLeft: number;
  lineHeight: number;
  textAlign: "left" | "right" | "center" | "justify";
}

export interface RawSpan {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  fontName: string;
  fontColor?: string;
}

export interface SemanticChildSpan {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  lineIndex: number;
  styleOverrides: Partial<Pick<TextBlock, "fontSize" | "fontName" | "fontWeight" | "fontColor">> & {
    styles?: Partial<BlockStyles>;
  };
}

export interface TextBlock {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  fontName: string;
  fontWeight: "normal" | "bold";
  fontColor: string;
  confidence: number;
  tag: SemanticTag;
  pageIndex: number;
  styles: BlockStyles;
  isFirstLineIndented: boolean;
  rawSpans: RawSpan[];
  textMode?: "plain" | "pre";
  semanticChildren?: SemanticChildSpan[];
  sourceSpanIds?: string[];
  reviewColor?: string;
  imageCrop?: {
    x: number;
    y: number;
    w: number;
    h: number;
    fileName?: string;
  };
}

export interface ExtractionJob {
  id: string;
  status: ExtractionStatus;
  pageCount: number;
  pdfFingerprint: string;
  createdAt: string;
  updatedAt: string;
  dpi: number;
  filePath: string;
  originalFileName: string;
  enableOcrValidation?: boolean;
}

export interface PageResult {
  pageIndex: number;
  imageUrl: string;
  htmlContent: string;
  blocks: TextBlock[];
  confidence: number;
  pageWidth: number;
  pageHeight: number;
  leftMarginPx: number;
  reviewStatus: "unvisited" | "reviewed" | "edited";
  ocrValidation?: OcrValidationSummary;
}

export type FixType = "move" | "resize" | "text-correct" | "tag-change" | "merge" | "delete" | "style-change" | "split" | "create-group";

export interface FixDelta {
  id: string;
  jobId: string;
  pageIndex: number;
  type: FixType;
  blockId: string;
  secondaryBlockId?: string;
  before: Partial<TextBlock> & { styles?: Partial<BlockStyles> };
  after: Partial<TextBlock> & { styles?: Partial<BlockStyles> };
  reviewerId: string;
  timestamp: string;
}

export interface DraftPageState {
  jobId: string;
  pageIndex: number;
  blocks: TextBlock[];
  pendingFixes: FixDelta[];
  hiddenWordIds: string[];
  updatedAt: string;
}

export interface ResumeInfo {
  jobId: string;
  lastVisitedPageIndex: number | null;
  draftPageIndices: number[];
}

export interface JobListItem {
  job: ExtractionJob;
  editSummary: JobEditSummary;
  lastVisitedPageIndex: number | null;
  draftPageIndices: number[];
}

export interface ExtractionProfile {
  fingerprint: string;
  sampleCount: number;
  yBandTolerance: number;
  xGapTolerance: number;
  baselineDrift: number;
  coordOffsetX: number;
  coordOffsetY: number;
  encodingMap: Record<string, string>;
  artifactThreshold: number;
  headingCutoffs: number[];
  firstLineIndentPx: number;
  indentedParaXOffset: number;
  defaultTextIndent: number;
  lastUpdated: string;
}

export interface ClassifierResult {
  blockId: string;
  predictedTag: SemanticTag;
  mergeDecision: "merge" | "split" | null;
  confidence: number;
}

export interface TrainingStatus {
  isTraining: boolean;
  lastTrainedAt: string | null;
  fixCountAtLastTrain: number;
  totalFixes: number;
  nextTrainAt: number;
}

export interface PageVisit {
  jobId: string;
  pageIndex: number;
  visitedAt: string;
  reviewerId: string;
}

export interface JobEditSummary {
  jobId: string;
  totalEdits: number;
  editsByPage: Record<number, number>;
  editsByType: Record<FixType, number>;
  pagesReviewed: number[];
  pagesEdited: number[];
  pagesAccurate: number[];
  sessionsCount: number;
  lastEditAt: string | null;
}

export interface ProfileSummary {
  fingerprint: string;
  sampleCount: number;
  lastUpdated: string;
}

export interface ProfileInsights {
  profile: ExtractionProfile;
  recentConfidenceScores: Array<{ pageIndex: number; confidence: number }>;
  improvementDelta: number;
}

export interface JobsResponse {
  job: ExtractionJob;
  editSummary: JobEditSummary;
  warning?: "large_file";
}

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
  words: OcrWord[];
}

export interface OcrPageResult {
  pageIndex: number;
  width: number;
  height: number;
  engine: "paddleocr" | "tesseract";
  status: "ok" | "unavailable" | "failed";
  averageConfidence: number;
  lines: OcrLine[];
  message?: string;
}

export type OcrComparisonIssueType =
  | "missing-text"
  | "position-mismatch"
  | "text-mismatch"
  | "coverage-mismatch"
  | "unexpected-extra-text"
  | "heading-mismatch";

export interface OcrComparisonIssue {
  type: OcrComparisonIssueType;
  severity: "low" | "medium" | "high";
  message: string;
  blockId?: string;
  ocrText?: string;
  extractedText?: string;
  region?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
}

export interface OcrComparisonResult {
  pageIndex: number;
  score: number;
  missingTextCount: number;
  mismatchedBlockCount: number;
  positionMismatchCount: number;
  issues: OcrComparisonIssue[];
}

export interface OcrValidationSummary {
  status: "ok" | "warning" | "unavailable" | "failed";
  score: number | null;
  issueCount: number;
  message?: string;
}
