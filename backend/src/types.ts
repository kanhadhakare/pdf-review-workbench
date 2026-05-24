export enum ExtractionStatus {
  pending = "pending",
  processing = "processing",
  done = "done",
  failed = "failed"
}

export type SemanticTag = "h1" | "h2" | "h3" | "p" | "span" | "caption" | "artifact";

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
  confidence: number;
  tag: SemanticTag;
  pageIndex: number;
  styles: BlockStyles;
  isFirstLineIndented: boolean;
  rawSpans: RawSpan[];
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

export type FixType = "move" | "resize" | "text-correct" | "tag-change" | "merge" | "delete" | "style-change" | "split";

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
  engine: "paddleocr";
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
