export enum ExtractionStatus {
  pending = "pending",
  processing = "processing",
  done = "done",
  failed = "failed"
}

export interface ExtractionJob {
  id: string;
  status: ExtractionStatus;
  pageCount: number;
  createdAt: string;
}

export interface PageResult {
  pageIndex: number;
  imageUrl: string;
  htmlContent: string;
  cssUrl: string;
  confidence: number;
  width: number;
  height: number;
  debugHtmlContent?: string;
  boxesHtmlContent?: string;
}
