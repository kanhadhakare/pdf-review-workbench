import { CommonModule } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  computed,
  inject,
  signal,
  viewChild
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { FixService } from "../../services/fix.service";
import { type BlockStyles, type DraftPageState, type FixDelta, type JobEditSummary, type PageResult, type SemanticChildSpan, type SemanticTag, type TextBlock } from "../../types";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
type EditorMode = "words";

interface PointerActionState {
  mode: "move" | "resize";
  blockId: string;
  corner?: ResizeCorner;
  startX: number;
  startY: number;
  original: TextBlock;
}

interface SelectionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SelectionState {
  startX: number;
  startY: number;
}

interface PendingSummary {
  total: number;
  byType: Record<string, number>;
}

type WordSpan = TextBlock & {
  sourceBlockId: string;
};

interface StyleTextDraft {
  fontSize: number;
  fontColor: string;
}

interface PositionDraft {
  left: number;
  top: number;
}

function cloneBlock<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultStyles(): BlockStyles {
  return {
    textIndent: 0,
    paddingLeft: 0,
    lineHeight: 1.4,
    textAlign: "left"
  };
}

function tagOrder(tag: SemanticTag): number {
  switch (tag) {
    case "h1": return 1;
    case "h2": return 2;
    case "h3": return 3;
    case "p": return 4;
    case "caption": return 5;
    case "table": return 6;
    case "span": return 7;
    default: return 8;
  }
}

function boxesIntersect(a: SelectionBox, b: SelectionBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function commonNumber(values: number[]): number | null {
  if (!values.length) return null;
  const first = values[0];
  return values.every((value) => Math.abs(value - first) < 0.01) ? first : null;
}

function commonString<T extends string>(values: T[]): T | null {
  if (!values.length) return null;
  const first = values[0];
  return values.every((value) => value === first) ? first : null;
}

function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  const short = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (short) {
    const [r, g, b] = short[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  const full = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (full) return `#${full[1]}`.toUpperCase();
  return null;
}

@Component({
  selector: "app-fix-editor",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./fix-editor.component.html",
  styleUrls: ["./fix-editor.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FixEditorComponent implements OnChanges {
  private readonly fixes = inject(FixService);
  private readonly canvas = viewChild<ElementRef<HTMLDivElement>>("canvas");
  private pointerState: PointerActionState | null = null;
  private selectionState: SelectionState | null = null;
  private suppressCanvasClick = false;
  private pendingFixMap = new Map<string, FixDelta>();
  private baselineBlocks = new Map<string, TextBlock>();
  private currentBlocks = new Map<string, TextBlock>();
  private styleBaseline: BlockStyles | null = null;
  private lastTextEditPoint: { x: number; y: number } | null = null;
  private draftSaveTimer: number | null = null;
  private draftHydrating = false;
  private draftLoadToken = 0;

  @Input({ required: true }) jobId = "";
  @Input() page: PageResult | null = null;
  @Input() editMode = false;
  @Input() scale = 1;
  @Output() pendingChanged = new EventEmitter<PendingSummary>();
  @Output() fixesSaved = new EventEmitter<JobEditSummary>();

  readonly editorMode = signal<EditorMode>("words");
  readonly blocks = signal<TextBlock[]>([]);
  readonly wordSpans = signal<WordSpan[]>([]);
  readonly hiddenWordIds = signal<string[]>([]);
  readonly selectedIds = signal<string[]>([]);
  readonly selectedWordIds = signal<string[]>([]);
  readonly selectionBox = signal<SelectionBox | null>(null);
  readonly drawnBox = signal<SelectionBox | null>(null);
  readonly editingTextId = signal<string | null>(null);
  readonly statusMessage = signal("");
  readonly saving = signal(false);
  readonly draftSaving = signal(false);
  readonly draftSavedAt = signal<string | null>(null);
  readonly showBoxes = signal(false);
  readonly showStylePanel = signal(false);
  readonly deletingIds = signal<string[]>([]);
  readonly styleDraft = signal<BlockStyles>(defaultStyles());
  readonly styleTextDraft = signal<StyleTextDraft>({ fontSize: 10, fontColor: "#000000" });
  readonly styleTextBaseline = signal<StyleTextDraft | null>(null);
  readonly positionDraft = signal<PositionDraft>({ left: 0, top: 0 });
  readonly positionBaseline = signal<PositionDraft | null>(null);

  readonly normalizedFontColor = computed(() => normalizeHexColor(this.styleTextDraft().fontColor));

  readonly visibleWordSpans = computed(() => {
    const hidden = new Set(this.hiddenWordIds());
    return this.wordSpans().filter((word) => !hidden.has(word.id));
  });

  readonly displayBlocks = computed(() => {
    const blocks = this.blocks();
    return blocks.filter((block) => Boolean(block.sourceSpanIds?.length) || block.tag === "img");
  });

  readonly selectedBlock = computed(() => {
    const id = this.selectedIds()[0];
    return id ? this.currentBlocks.get(id) ?? null : null;
  });

  readonly toolbarBlock = computed(() => {
    const ids = this.selectedIds();
    if (!ids.length) return null;
    const blocks = ids
      .map((id) => this.currentBlocks.get(id))
      .filter((block): block is TextBlock => Boolean(block));
    return blocks.sort((a, b) => (a.y - b.y) || (a.x - b.x))[0] ?? null;
  });

  readonly selectedWordBox = computed(() => {
    const selected = new Set(this.selectedWordIds());
    const words = this.visibleWordSpans().filter((word) => selected.has(word.id));
    return words.length ? this.boundingBox(words) : null;
  });

  readonly activeDrawnBox = computed(() => this.drawnBox() ?? this.selectedWordBox());

  readonly pendingSummary = computed<PendingSummary>(() => {
    const byType: Record<string, number> = {};
    for (const fix of this.pendingFixMap.values()) {
      byType[fix.type] = (byType[fix.type] ?? 0) + 1;
    }
    return { total: this.pendingFixMap.size, byType };
  });

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["page"]) {
      this.resetFromPage();
    }
    if (changes["editMode"] && !this.editMode) {
      this.editingTextId.set(null);
      this.showStylePanel.set(false);
      this.selectionBox.set(null);
      this.drawnBox.set(null);
      this.selectedWordIds.set([]);
    }
  }

  @HostListener("document:mousemove", ["$event"])
  handlePointerMove(event: MouseEvent): void {
    if (this.selectionState && this.editorMode() === "words") {
      event.preventDefault();
      const point = this.canvasPoint(event);
      const x = Math.min(this.selectionState.startX, point.x);
      const y = Math.min(this.selectionState.startY, point.y);
      this.selectionBox.set({
        x,
        y,
        w: Math.abs(point.x - this.selectionState.startX),
        h: Math.abs(point.y - this.selectionState.startY)
      });
      return;
    }

    if (!this.pointerState || !this.editMode) return;
    event.preventDefault();
    const block = this.currentBlocks.get(this.pointerState.blockId);
    const page = this.page;
    if (!block || !page) return;

    const scale = Math.max(0.01, this.scale);
    const dx = (event.clientX - this.pointerState.startX) / scale;
    const dy = (event.clientY - this.pointerState.startY) / scale;
    const original = this.pointerState.original;
    let next = cloneBlock(original);

    if (this.pointerState.mode === "move") {
      next.x = Math.max(0, Math.min(original.x + dx, page.pageWidth - original.w));
      next.y = Math.max(0, Math.min(original.y + dy, page.pageHeight - original.h));
    } else if (this.pointerState.mode === "resize" && this.pointerState.corner) {
      next = this.resizeFromCorner(original, this.pointerState.corner, dx, dy, page.pageWidth, page.pageHeight);
    }

    this.currentBlocks.set(block.id, next);
    this.refreshBlocks();
  }

  @HostListener("document:mouseup")
  handlePointerUp(): void {
    if (this.selectionState && this.editorMode() === "words") {
      const box = this.selectionBox();
      this.selectionState = null;
      this.suppressCanvasClick = true;
      window.setTimeout(() => {
        this.suppressCanvasClick = false;
      });
      if (box && box.w > 3 && box.h > 3) {
        const selected = this.visibleWordSpans()
          .filter((word) => boxesIntersect(box, word))
          .map((word) => word.id);
        this.selectedWordIds.set(selected);
        this.selectedIds.set([]);
        this.drawnBox.set(box);
      }
      this.selectionBox.set(null);
      return;
    }

    if (!this.pointerState || !this.editMode) return;
    const state = this.pointerState;
    this.pointerState = null;
    document.body.style.cursor = "";
    const current = this.currentBlocks.get(state.blockId);
    if (!current) return;

    if (state.mode === "move") {
      const moved = Math.abs(current.x - state.original.x) > 2 || Math.abs(current.y - state.original.y) > 2;
      if (moved) {
        this.upsertFix(`move:${current.id}`, {
          id: crypto.randomUUID(),
          jobId: this.jobId,
          pageIndex: current.pageIndex,
          type: "move",
          blockId: current.id,
          before: { x: state.original.x, y: state.original.y },
          after: { x: current.x, y: current.y },
          reviewerId: "local-reviewer",
          timestamp: new Date().toISOString()
        });
      } else {
        this.currentBlocks.set(current.id, cloneBlock(state.original));
        this.refreshBlocks();
      }
      return;
    }

    const resized =
      Math.abs(current.x - state.original.x) > 0.5 ||
      Math.abs(current.y - state.original.y) > 0.5 ||
      Math.abs(current.w - state.original.w) > 0.5 ||
      Math.abs(current.h - state.original.h) > 0.5;

    if (resized) {
      this.upsertFix(`resize:${current.id}`, {
        id: crypto.randomUUID(),
        jobId: this.jobId,
        pageIndex: current.pageIndex,
        type: "resize",
        blockId: current.id,
        before: { x: state.original.x, y: state.original.y, w: state.original.w, h: state.original.h },
        after: { x: current.x, y: current.y, w: current.w, h: current.h },
        reviewerId: "local-reviewer",
        timestamp: new Date().toISOString()
      });
    }
  }

  @HostListener("document:keydown", ["$event"])
  handleKeydown(event: KeyboardEvent): void {
    if (!this.editMode) return;
    const target = event.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable || target.closest(".style-panel")) {
        return;
      }
    }
    if (this.editorMode() === "words") {
      const step = event.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      if (event.key === "ArrowLeft") dx = -step;
      if (event.key === "ArrowRight") dx = step;
      if (event.key === "ArrowUp") dy = -step;
      if (event.key === "ArrowDown") dy = step;
      if (dx !== 0 || dy !== 0) {
        event.preventDefault();
        event.stopPropagation();
        const page = this.page;
        if (!page) return;

        const selectedBlock = this.selectedBlock();
        if (this.showBoxes() && selectedBlock) {
          const nextX = Math.max(0, Math.min(selectedBlock.x + dx, page.pageWidth - selectedBlock.w));
          const nextY = Math.max(0, Math.min(selectedBlock.y + dy, page.pageHeight - selectedBlock.h));
          const updated: TextBlock = { ...selectedBlock, x: Number(nextX.toFixed(2)), y: Number(nextY.toFixed(2)) };
          this.currentBlocks.set(updated.id, updated);
          this.refreshBlocks();
          this.positionDraft.set({ left: updated.x, top: updated.y });
          const baseline = this.positionBaseline() ?? { left: selectedBlock.x, top: selectedBlock.y };
          this.positionBaseline.set(baseline);
          const moved = Math.abs(updated.x - baseline.left) > 0.5 || Math.abs(updated.y - baseline.top) > 0.5;
          if (moved) {
            this.pendingFixMap.set(`move:${updated.id}`, {
              id: crypto.randomUUID(),
              jobId: this.jobId,
              pageIndex: updated.pageIndex,
              type: "move",
              blockId: updated.id,
              before: { x: baseline.left, y: baseline.top },
              after: { x: updated.x, y: updated.y },
              reviewerId: "local-reviewer",
              timestamp: new Date().toISOString()
            });
            this.emitPending();
            this.scheduleDraftSave();
          } else if (this.pendingFixMap.delete(`move:${updated.id}`)) {
            this.emitPending();
            this.scheduleDraftSave();
          }
          return;
        }

        const box = this.drawnBox();
        if (!box) return;
        const nextX = Math.max(0, Math.min(box.x + dx, page.pageWidth - box.w));
        const nextY = Math.max(0, Math.min(box.y + dy, page.pageHeight - box.h));
        this.drawnBox.set({ ...box, x: Number(nextX.toFixed(2)), y: Number(nextY.toFixed(2)) });
        this.scheduleDraftSave();
        return;
      }
    }
    if (event.key.toLowerCase() === "delete" || event.key === "Backspace") {
      if (this.selectedIds().length) {
        event.preventDefault();
        this.deleteSelected();
      }
    }
  }

  transform(): string {
    return `scale(${this.scale})`;
  }

  setEditorMode(mode: EditorMode): void {
    this.editorMode.set(mode);
    this.deselect();
    this.selectedWordIds.set([]);
    this.selectionBox.set(null);
    this.drawnBox.set(null);
  }

  handleCanvasClick(event: MouseEvent): void {
    if (this.suppressCanvasClick) return;
    const target = event.target as HTMLElement;
    if (target.closest(".text-block") || target.closest(".word-span") || target.closest(".block-toolbar") || target.closest(".word-toolbar") || target.closest(".style-panel")) {
      return;
    }
    this.deselect();
    this.selectedWordIds.set([]);
    this.drawnBox.set(null);
  }

  startWordSelection(event: MouseEvent): void {
    if (this.editorMode() !== "words") return;
    const target = event.target as HTMLElement;
    if (target.closest(".text-block") || target.closest(".word-span") || target.closest(".block-toolbar") || target.closest(".word-toolbar") || target.closest(".style-panel")) {
      return;
    }
    event.preventDefault();
    const point = this.canvasPoint(event);
    this.selectionState = { startX: point.x, startY: point.y };
    this.selectionBox.set({ x: point.x, y: point.y, w: 0, h: 0 });
  }

  selectWord(wordId: string, event: MouseEvent): void {
    if (this.editorMode() !== "words") return;
    event.stopPropagation();
    const current = new Set(this.selectedWordIds());
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      current.has(wordId) ? current.delete(wordId) : current.add(wordId);
      this.selectedWordIds.set([...current]);
    } else {
      this.selectedWordIds.set([wordId]);
    }
    this.selectedIds.set([]);
    this.drawnBox.set(null);
  }

  groupSelectedWords(tag: SemanticTag = "p"): void {
    const selected = new Set(this.selectedWordIds());
    const words = this.visibleWordSpans().filter((word) => selected.has(word.id));
    if (!this.page) return;

    if (!words.length) {
      const box = this.activeDrawnBox();
      if (!box) return;
      const group: TextBlock = {
        id: crypto.randomUUID(),
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        text: "",
        fontSize: 12,
        fontName: "serif",
        fontWeight: "normal",
        fontColor: "#000000",
        confidence: 1,
        tag,
        pageIndex: this.page.pageIndex,
        styles: defaultStyles(),
        isFirstLineIndented: false,
        rawSpans: [],
        textMode: "pre",
        semanticChildren: [],
        sourceSpanIds: [],
        reviewColor: this.nextReviewColor()
      };
      this.currentBlocks.set(group.id, group);
      this.baselineBlocks.set(group.id, cloneBlock(group));
      this.selectedWordIds.set([]);
      this.drawnBox.set(null);
      this.selectedIds.set([group.id]);
      this.styleBaseline = cloneBlock(group.styles);
      this.styleDraft.set({ ...group.styles });
      this.positionDraft.set({ left: group.x, top: group.y });
      this.positionBaseline.set({ left: group.x, top: group.y });
      this.refreshBlocks();
      this.upsertFix(`create-group:${group.id}`, {
        id: crypto.randomUUID(),
        jobId: this.jobId,
        pageIndex: group.pageIndex,
        type: "create-group",
        blockId: group.id,
        before: {},
        after: cloneBlock(group),
        reviewerId: "local-reviewer",
        timestamp: new Date().toISOString()
      });
      return;
    }

    const box = this.boundingBox(words);
    const lines = this.groupWordsIntoLines(words);
    const text = lines.map((line) => line.map((word) => word.text).join(" ")).join("\n");
    const first = words[0];
    const parentFontSize = commonNumber(words.map((word) => word.fontSize)) ?? first.fontSize;
    const parentFontName = commonString(words.map((word) => word.fontName)) ?? first.fontName;
    const parentFontWeight = commonString(words.map((word) => word.fontWeight)) ?? first.fontWeight;
    const parentFontColor = commonString(words.map((word) => word.fontColor)) ?? first.fontColor;
    const parentStyles = this.commonStyles(words);

    const semanticChildren: SemanticChildSpan[] = lines.flatMap((line, lineIndex) => line.map((word) => ({
      id: word.id,
      text: word.text,
      x: Number((word.x - box.x).toFixed(2)),
      y: Number((word.y - box.y).toFixed(2)),
      w: word.w,
      h: word.h,
      lineIndex,
      styleOverrides: this.styleOverridesForWord(word, {
        fontSize: parentFontSize,
        fontName: parentFontName,
        fontWeight: parentFontWeight,
        fontColor: parentFontColor,
        styles: parentStyles
      })
    })));

    const sourceSpanIds = words.map((word) => word.id);
    const group: TextBlock = {
      id: crypto.randomUUID(),
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      text,
      fontSize: parentFontSize,
      fontName: parentFontName,
      fontWeight: parentFontWeight,
      fontColor: parentFontColor,
      confidence: Number(Math.min(...words.map((word) => word.confidence)).toFixed(3)),
      tag,
      pageIndex: this.page.pageIndex,
      styles: parentStyles,
      isFirstLineIndented: words.some((word) => word.isFirstLineIndented),
      rawSpans: words.flatMap((word) => word.rawSpans),
      textMode: "pre",
      semanticChildren,
      sourceSpanIds,
      reviewColor: this.nextReviewColor()
    };

    this.currentBlocks.set(group.id, group);
    this.baselineBlocks.set(group.id, cloneBlock(group));
    this.hiddenWordIds.set([...new Set([...this.hiddenWordIds(), ...sourceSpanIds])]);
    this.selectedWordIds.set([]);
    this.drawnBox.set(null);
    this.selectedIds.set([group.id]);
    this.styleBaseline = cloneBlock(group.styles);
    this.styleDraft.set({ ...group.styles });
    this.refreshBlocks();

    this.upsertFix(`create-group:${group.id}`, {
      id: crypto.randomUUID(),
      jobId: this.jobId,
      pageIndex: group.pageIndex,
      type: "create-group",
      blockId: group.id,
      before: {},
      after: cloneBlock(group),
      reviewerId: "local-reviewer",
      timestamp: new Date().toISOString()
    });
  }

  createImageBox(): void {
    const box = this.activeDrawnBox();
    if (!box || !this.page) return;

    const block: TextBlock = {
      id: crypto.randomUUID(),
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      text: "",
      fontSize: 1,
      fontName: "image",
      fontWeight: "normal",
      fontColor: "#000000",
      confidence: 1,
      tag: "img",
      pageIndex: this.page.pageIndex,
      styles: defaultStyles(),
      isFirstLineIndented: false,
      rawSpans: [],
      textMode: "plain",
      reviewColor: this.nextReviewColor(),
      imageCrop: { ...box }
    };

    this.currentBlocks.set(block.id, block);
    this.baselineBlocks.set(block.id, cloneBlock(block));
    this.selectedWordIds.set([]);
    this.drawnBox.set(null);
    this.selectedIds.set([block.id]);
    this.refreshBlocks();

    this.upsertFix(`create-group:${block.id}`, {
      id: crypto.randomUUID(),
      jobId: this.jobId,
      pageIndex: block.pageIndex,
      type: "create-group",
      blockId: block.id,
      before: {},
      after: cloneBlock(block),
      reviewerId: "local-reviewer",
      timestamp: new Date().toISOString()
    });
  }

  clearWordSelection(): void {
    this.selectedWordIds.set([]);
    this.drawnBox.set(null);
    this.selectionBox.set(null);
  }

  canCreateTextGroup(): boolean {
    return this.editMode && this.editorMode() === "words" && this.selectedWordIds().length > 0;
  }

  canCreateImageBox(): boolean {
    return this.editMode && this.editorMode() === "words" && Boolean(this.activeDrawnBox());
  }

  wordModeHelp(): string {
    if (this.editorMode() !== "words") return "";
    if (!this.editMode) return "Drag to draw a box or click word spans to select. Click Edit to create semantic groups/crops.";
    if (this.activeDrawnBox()) return "Choose a semantic tag for selected words, or choose img to crop this box in the final build.";
    return "Drag on the page to draw a box, or click/shift-click word spans, then choose a tag.";
  }

  selectBlock(blockId: string, event: MouseEvent): void {
    if (!this.editMode) return;
    event.stopPropagation();
    const current = this.selectedIds();
    if (event.shiftKey) {
      if (!current.length) this.selectedIds.set([blockId]);
      else if (current[0] !== blockId) this.selectedIds.set([current[0], blockId]);
    } else {
      this.selectedIds.set([blockId]);
    }
    this.selectedWordIds.set([]);

    const block = this.currentBlocks.get(blockId);
    if (block) {
      this.styleBaseline = cloneBlock(block.styles);
      this.styleDraft.set({ ...block.styles });
      this.styleTextDraft.set({ fontSize: block.fontSize, fontColor: block.fontColor });
      this.styleTextBaseline.set({ fontSize: block.fontSize, fontColor: block.fontColor });
      this.positionDraft.set({ left: block.x, top: block.y });
      const baseline = this.baselineBlocks.get(block.id) ?? block;
      this.positionBaseline.set({ left: baseline.x, top: baseline.y });
    }
  }

  deselect(event?: MouseEvent): void {
    event?.stopPropagation();
    this.selectedIds.set([]);
    this.editingTextId.set(null);
    this.styleBaseline = null;
    this.showStylePanel.set(false);
  }

  startMove(blockId: string, event: MouseEvent): void {
    if (!this.editMode || this.editingTextId() === blockId) return;
    if ((event.target as HTMLElement).closest(".resize-handle") || (event.target as HTMLElement).closest(".block-toolbar")) return;
    const block = this.currentBlocks.get(blockId);
    if (!block) return;
    this.selectBlock(blockId, event);
    this.pointerState = {
      mode: "move",
      blockId,
      startX: event.clientX,
      startY: event.clientY,
      original: cloneBlock(block)
    };
    document.body.style.cursor = "grabbing";
  }

  startResize(blockId: string, corner: ResizeCorner, event: MouseEvent): void {
    if (!this.editMode) return;
    event.stopPropagation();
    event.preventDefault();
    const block = this.currentBlocks.get(blockId);
    if (!block) return;
    this.selectBlock(blockId, event);
    this.pointerState = {
      mode: "resize",
      blockId,
      corner,
      startX: event.clientX,
      startY: event.clientY,
      original: cloneBlock(block)
    };
    document.body.style.cursor = this.cursorForCorner(corner);
  }

  beginTextEdit(blockId: string, event: MouseEvent): void {
    const block = this.currentBlocks.get(blockId);
    if (!this.editMode || block?.semanticChildren?.length) return;
    event.stopPropagation();
    this.lastTextEditPoint = { x: event.clientX, y: event.clientY };
    this.editingTextId.set(blockId);
    queueMicrotask(() => {
      const element = document.querySelector<HTMLElement>(`[data-editor-block-id="${blockId}"] .block-content`);
      if (!element) return;
      element.focus();
      this.placeCaretAtPoint(element, this.lastTextEditPoint);
    });
  }

  finishTextEdit(blockId: string, event: FocusEvent): void {
    const block = this.currentBlocks.get(blockId);
    const element = event.target as HTMLElement;
    const nextText = element.innerText.trim();
    this.editingTextId.set(null);
    if (!block || !nextText) {
      if (block) element.innerText = block.text;
      return;
    }
    if (nextText !== block.text) {
      const updated = { ...block, text: nextText };
      this.currentBlocks.set(blockId, updated);
      this.refreshBlocks();
      this.upsertFix(`text:${blockId}`, {
        id: crypto.randomUUID(),
        jobId: this.jobId,
        pageIndex: block.pageIndex,
        type: "text-correct",
        blockId,
        before: { text: block.text },
        after: { text: nextText },
        reviewerId: "local-reviewer",
        timestamp: new Date().toISOString()
      });
      this.scheduleDraftSave();
    }
  }

  handleTextKeydown(_: string, event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      (event.target as HTMLElement).blur();
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      (event.target as HTMLElement).blur();
    }
  }

  toggleStylePanel(event?: MouseEvent): void {
    event?.stopPropagation();
    this.showStylePanel.set(!this.showStylePanel());
  }

  updateStyleDraft(key: keyof BlockStyles, rawValue: unknown): void {
    const current = this.styleDraft();
    const nextValue =
      key === "textAlign"
        ? (String(rawValue) as BlockStyles["textAlign"])
        : Number(rawValue);
    this.styleDraft.set({ ...current, [key]: nextValue } as BlockStyles);
    this.applyStyleDraftLive(false);
  }

  updateFontSize(rawValue: unknown): void {
    const current = this.styleTextDraft();
    this.styleTextDraft.set({ ...current, fontSize: Number(rawValue) });
    this.applyStyleDraftLive(false);
  }

  updateFontColor(rawValue: unknown): void {
    const current = this.styleTextDraft();
    this.styleTextDraft.set({ ...current, fontColor: String(rawValue) });
    this.applyStyleDraftLive(false);
  }

  updatePositionDraft(key: keyof PositionDraft, rawValue: unknown): void {
    const next = { ...this.positionDraft(), [key]: Number(rawValue) } as PositionDraft;
    this.positionDraft.set(next);
    this.applyPositionDraftLive();
  }

  private applyPositionDraftLive(): void {
    const block = this.selectedBlock();
    const page = this.page;
    if (!block || !page) return;

    if (!this.positionBaseline()) {
      const baseline = this.baselineBlocks.get(block.id) ?? block;
      this.positionBaseline.set({ left: baseline.x, top: baseline.y });
    }

    const draft = this.positionDraft();
    const nextX = Math.max(0, Math.min(Number.isFinite(draft.left) ? draft.left : block.x, page.pageWidth - block.w));
    const nextY = Math.max(0, Math.min(Number.isFinite(draft.top) ? draft.top : block.y, page.pageHeight - block.h));
    const updated: TextBlock = { ...block, x: Number(nextX.toFixed(2)), y: Number(nextY.toFixed(2)) };
    this.currentBlocks.set(block.id, updated);
    this.refreshBlocks();

    const baseline = this.positionBaseline()!;
    const moved = Math.abs(updated.x - baseline.left) > 0.5 || Math.abs(updated.y - baseline.top) > 0.5;
    if (moved) {
      this.pendingFixMap.set(`move:${block.id}`, {
        id: crypto.randomUUID(),
        jobId: this.jobId,
        pageIndex: updated.pageIndex,
        type: "move",
        blockId: block.id,
        before: { x: baseline.left, y: baseline.top },
        after: { x: updated.x, y: updated.y },
        reviewerId: "local-reviewer",
        timestamp: new Date().toISOString()
      });
      this.emitPending();
      this.scheduleDraftSave();
      return;
    }

    if (this.pendingFixMap.delete(`move:${block.id}`)) {
      this.emitPending();
      this.scheduleDraftSave();
    }
  }

  private applyStyleDraftLive(closePanel: boolean): void {
    const block = this.selectedBlock();
    if (!block || !this.page) return;

    if (!this.styleBaseline) this.styleBaseline = cloneBlock(block.styles);
    if (!this.styleTextBaseline()) this.styleTextBaseline.set({ fontSize: block.fontSize, fontColor: block.fontColor });

    const draft = this.styleDraft();
    const textDraft = this.styleTextDraft();
    const baselineText = this.styleTextBaseline();
    const nextBlock: TextBlock = {
      ...block,
      styles: { ...block.styles, ...draft },
      fontSize: Number(textDraft.fontSize) || block.fontSize,
      fontColor: textDraft.fontColor || block.fontColor,
      isFirstLineIndented: draft.textIndent > 0 ? true : block.isFirstLineIndented
    };

    this.currentBlocks.set(block.id, nextBlock);
    this.refreshBlocks();

    const styleChanged = (["textIndent", "paddingLeft", "lineHeight", "textAlign"] as Array<keyof BlockStyles>)
      .some((key) => draft[key] !== this.styleBaseline![key]);
    const textChanged = Boolean(baselineText) && (textDraft.fontSize !== baselineText!.fontSize || textDraft.fontColor !== baselineText!.fontColor);

    const fixKey = `style:${block.id}`;
    if (styleChanged || textChanged) {
      this.pendingFixMap.set(fixKey, {
        id: crypto.randomUUID(),
        jobId: this.jobId,
        pageIndex: nextBlock.pageIndex,
        type: "style-change",
        blockId: block.id,
        before: {
          styles: { ...this.styleBaseline },
          fontSize: baselineText?.fontSize,
          fontColor: baselineText?.fontColor
        },
        after: {
          styles: { ...nextBlock.styles },
          fontSize: nextBlock.fontSize,
          fontColor: nextBlock.fontColor,
          isFirstLineIndented: nextBlock.isFirstLineIndented
        },
        reviewerId: "local-reviewer",
        timestamp: new Date().toISOString()
      });
      this.emitPending();
      this.scheduleDraftSave();
      if (closePanel) this.showStylePanel.set(false);
      return;
    }

    if (this.pendingFixMap.delete(fixKey)) {
      this.emitPending();
      this.scheduleDraftSave();
    }
    if (closePanel) this.showStylePanel.set(false);
  }

  styleHint(): string {
    const block = this.selectedBlock();
    if (!block) return "";
    const indent = this.styleDraft().textIndent;
    if (block.tag === "p" && block.isFirstLineIndented) return "Correcting detected first-line indent.";
    if (!block.isFirstLineIndented && indent > 0) return "Adding indent - this block will be marked as first-line indented.";
    if (block.tag === "p" && indent > 0) return "This indent will be learned for this PDF type.";
    return "";
  }

  changeTag(tag: SemanticTag | "delete"): void {
    const block = this.selectedBlock();
    if (!block) return;
    if (tag === "delete") {
      this.deleteSelected();
      return;
    }
    if (tag === block.tag) return;
    const updated = { ...block, tag };
    this.currentBlocks.set(block.id, updated);
    this.refreshBlocks();
    this.upsertFix(`tag:${block.id}`, {
      id: crypto.randomUUID(),
      jobId: this.jobId,
      pageIndex: block.pageIndex,
      type: "tag-change",
      blockId: block.id,
      before: { tag: block.tag },
      after: { tag },
      reviewerId: "local-reviewer",
      timestamp: new Date().toISOString()
    });
  }

  mergeSelected(): void {
    const ids = this.selectedIds();
    if (ids.length !== 2) return;
    const blocks = ids
      .map((id) => this.currentBlocks.get(id))
      .filter((block): block is TextBlock => Boolean(block))
      .sort((a, b) => (a.x - b.x) || (a.y - b.y));
    if (blocks.length !== 2) return;
    const [first, second] = blocks;
    const merged: TextBlock = {
      ...cloneBlock(first),
      id: crypto.randomUUID(),
      x: Math.min(first.x, second.x),
      y: Math.min(first.y, second.y),
      w: Math.max(first.x + first.w, second.x + second.w) - Math.min(first.x, second.x),
      h: Math.max(first.y + first.h, second.y + second.h) - Math.min(first.y, second.y),
      text: `${first.text} ${second.text}`.trim(),
      rawSpans: [...first.rawSpans, ...second.rawSpans].sort((a, b) => (a.x - b.x) || (a.y - b.y)),
      isFirstLineIndented: first.isFirstLineIndented || second.isFirstLineIndented,
      styles: first.isFirstLineIndented ? { ...first.styles } : second.isFirstLineIndented ? { ...second.styles } : { ...first.styles },
      tag: tagOrder(first.tag) <= tagOrder(second.tag) ? first.tag : second.tag,
      confidence: Number(Math.min(first.confidence, second.confidence).toFixed(3))
    };
    this.currentBlocks.delete(first.id);
    this.currentBlocks.delete(second.id);
    this.currentBlocks.set(merged.id, merged);
    this.baselineBlocks.set(merged.id, cloneBlock(merged));
    this.clearPendingForBlock(first.id);
    this.clearPendingForBlock(second.id);
    this.upsertFix(`merge:${first.id}:${second.id}`, {
      id: crypto.randomUUID(),
      jobId: this.jobId,
      pageIndex: first.pageIndex,
      type: "merge",
      blockId: first.id,
      secondaryBlockId: second.id,
      before: { x: first.x, y: first.y, w: first.w, h: first.h, text: first.text, isFirstLineIndented: first.isFirstLineIndented, styles: { ...first.styles } },
      after: { x: merged.x, y: merged.y, w: merged.w, h: merged.h, text: merged.text, isFirstLineIndented: merged.isFirstLineIndented, styles: { ...merged.styles } },
      reviewerId: "local-reviewer",
      timestamp: new Date().toISOString()
    });
    this.selectedIds.set([merged.id]);
    this.styleBaseline = cloneBlock(merged.styles);
    this.styleDraft.set({ ...merged.styles });
    this.styleTextDraft.set({ fontSize: merged.fontSize, fontColor: merged.fontColor });
    this.styleTextBaseline.set({ fontSize: merged.fontSize, fontColor: merged.fontColor });
    this.positionDraft.set({ left: merged.x, top: merged.y });
    this.positionBaseline.set({ left: merged.x, top: merged.y });
    this.refreshBlocks();
  }

  deleteSelected(): void {
    const ids = this.selectedIds();
    if (!ids.length) return;
    this.deletingIds.set(ids);
    window.setTimeout(() => {
      for (const id of ids) {
        const block = this.currentBlocks.get(id);
        if (!block) continue;
        if (block.sourceSpanIds?.length) {
          const hidden = new Set(this.hiddenWordIds());
          for (const sourceId of block.sourceSpanIds) hidden.delete(sourceId);
          this.hiddenWordIds.set([...hidden]);
        }
        this.upsertFix(`delete:${id}`, {
          id: crypto.randomUUID(),
          jobId: this.jobId,
          pageIndex: block.pageIndex,
          type: "delete",
          blockId: id,
          before: { x: block.x, y: block.y, w: block.w, h: block.h, text: block.text, tag: block.tag, styles: { ...block.styles } },
          after: {},
          reviewerId: "local-reviewer",
          timestamp: new Date().toISOString()
        });
        this.currentBlocks.delete(id);
        this.clearPendingForBlock(id, true);
      }
      this.selectedIds.set([]);
      this.deletingIds.set([]);
      this.refreshBlocks();
      this.scheduleDraftSave();
    }, 320);
  }

  applyStyleChanges(): void {
    this.applyStyleDraftLive(true);
  }

  discardChanges(): void {
    if (this.page) {
      this.fixes.deleteDraft(this.jobId, this.page.pageIndex).subscribe({ next: () => void 0, error: () => void 0 });
    }
    this.resetFromPage();
    this.statusMessage.set("Pending changes discarded.");
  }

  submitFixes(): void {
    const fixes = [...this.pendingFixMap.values()];
    if (!this.page || !fixes.length || this.saving()) return;
    this.saving.set(true);
    this.statusMessage.set("");
    this.fixes.submitFixes(this.jobId, this.page.pageIndex, fixes).subscribe({
      next: (response) => {
        const payload = response as { saved: number; editSummary: JobEditSummary };
        this.saving.set(false);
        this.pendingFixMap.clear();
        this.emitPending();
        for (const block of this.blocks()) {
          this.baselineBlocks.set(block.id, cloneBlock(block));
        }
        if (this.page) {
          this.fixes.deleteDraft(this.jobId, this.page.pageIndex).subscribe({ next: () => void 0, error: () => void 0 });
        }
        this.statusMessage.set(`${payload.saved} fixes saved - profile updated`);
        this.fixesSaved.emit(payload.editSummary);
      },
      error: (error) => {
        this.saving.set(false);
        this.statusMessage.set(error?.error?.message ?? "Unable to save fixes.");
      }
    });
  }

  trackByBlock(_: number, block: TextBlock): string {
    return block.id;
  }

  trackByWord(_: number, word: WordSpan): string {
    return word.id;
  }

  isSelected(blockId: string): boolean {
    return this.selectedIds().includes(blockId);
  }

  isWordSelected(wordId: string): boolean {
    return this.selectedWordIds().includes(wordId);
  }

  isDeleting(blockId: string): boolean {
    return this.deletingIds().includes(blockId);
  }

  toolbarTop(): number {
    const block = this.toolbarBlock();
    if (!block) return 0;
    return block.y < 48 ? block.y + block.h + 8 : block.y - 48;
  }

  toolbarLeft(): number {
    return this.toolbarBlock()?.x ?? 0;
  }

  wordToolbarTop(): number {
    const box = this.activeDrawnBox();
    if (!box) return 0;
    return box.y < 48 ? box.y + box.h + 8 : box.y - 48;
  }

  wordToolbarLeft(): number {
    return this.activeDrawnBox()?.x ?? 0;
  }

  semanticLines(block: TextBlock): SemanticChildSpan[][] {
    const children = block.semanticChildren ?? [];
    const groups = new Map<number, SemanticChildSpan[]>();
    for (const child of children) {
      const current = groups.get(child.lineIndex) ?? [];
      current.push(child);
      groups.set(child.lineIndex, current);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, line]) => line.sort((a, b) => a.x - b.x));
  }

  childStyleValue<T extends keyof SemanticChildSpan["styleOverrides"]>(child: SemanticChildSpan, key: T): SemanticChildSpan["styleOverrides"][T] | null {
    return child.styleOverrides[key] ?? null;
  }

  childBlockStyleValue<T extends keyof BlockStyles>(child: SemanticChildSpan, key: T): BlockStyles[T] | null {
    return child.styleOverrides.styles?.[key] ?? null;
  }

  groupColor(blockId: string): string {
    return this.currentBlocks.get(blockId)?.reviewColor ?? "#4A90E2";
  }

  groupBackground(blockId: string): string {
    return `${this.groupColor(blockId)}22`;
  }

  private resetFromPage(): void {
    if (this.draftSaveTimer) {
      window.clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }
    this.pendingFixMap.clear();
    this.baselineBlocks.clear();
    this.currentBlocks.clear();
    this.selectedIds.set([]);
    this.selectedWordIds.set([]);
    this.selectionBox.set(null);
    this.drawnBox.set(null);
    this.editingTextId.set(null);
    this.statusMessage.set("");
    this.styleBaseline = null;
    this.showStylePanel.set(false);
    this.deletingIds.set([]);
    this.hiddenWordIds.set([]);
    this.draftSavedAt.set(null);
    this.draftSaving.set(false);

    const nextBlocks = (this.page?.blocks ?? []).map((block) => cloneBlock(block));
    for (const block of nextBlocks) {
      this.baselineBlocks.set(block.id, cloneBlock(block));
      this.currentBlocks.set(block.id, block);
    }
    this.blocks.set(nextBlocks.sort((a, b) => (a.y - b.y) || (a.x - b.x)));
    this.wordSpans.set(this.deriveWordSpans(nextBlocks));
    this.emitPending();
    this.loadDraftFromServer();
  }

  private refreshBlocks(): void {
    this.blocks.set([...this.currentBlocks.values()].sort((a, b) => (a.y - b.y) || (a.x - b.x)));
  }

  private emitPending(): void {
    this.pendingChanged.emit(this.pendingSummary());
  }

  private draftKey(fix: FixDelta): string {
    switch (fix.type) {
      case "move": return `move:${fix.blockId}`;
      case "resize": return `resize:${fix.blockId}`;
      case "text-correct": return `text:${fix.blockId}`;
      case "tag-change": return `tag:${fix.blockId}`;
      case "delete": return `delete:${fix.blockId}`;
      case "merge": return `merge:${fix.blockId}:${fix.secondaryBlockId ?? ""}`;
      case "style-change": return `style:${fix.blockId}`;
      case "create-group": return `create-group:${fix.blockId}`;
      case "split": return `split:${fix.blockId}`;
      default: return fix.id;
    }
  }

  private loadDraftFromServer(): void {
    const page = this.page;
    if (!page || !this.jobId) return;
    const token = ++this.draftLoadToken;
    this.fixes.getDraft(this.jobId, page.pageIndex).subscribe({
      next: (draft) => {
        if (token !== this.draftLoadToken) return;
        this.applyDraft(draft);
      },
      error: () => void 0
    });
  }

  private applyDraft(draft: DraftPageState): void {
    if (!this.page || draft.pageIndex !== this.page.pageIndex) return;
    this.draftHydrating = true;
    try {
      this.pendingFixMap.clear();
      for (const fix of draft.pendingFixes ?? []) {
        if (!fix || typeof fix !== "object") continue;
        this.pendingFixMap.set(this.draftKey(fix), fix);
      }

      const blocks = (draft.blocks ?? []).map((block) => cloneBlock(block));
      this.currentBlocks.clear();
      for (const block of blocks) {
        this.currentBlocks.set(block.id, block);
      }
      this.blocks.set(blocks.sort((a, b) => (a.y - b.y) || (a.x - b.x)));
      this.wordSpans.set(this.deriveWordSpans(blocks));
      this.hiddenWordIds.set(Array.isArray(draft.hiddenWordIds) ? draft.hiddenWordIds : []);
      this.draftSavedAt.set(draft.updatedAt ?? null);
      this.emitPending();
    } finally {
      this.draftHydrating = false;
    }
  }

  private scheduleDraftSave(): void {
    if (this.draftHydrating) return;
    if (!this.page) return;
    if (!this.editMode) return;
    if (this.draftSaveTimer) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = window.setTimeout(() => {
      this.draftSaveTimer = null;
      const page = this.page;
      if (!page) return;
      const payload = {
        blocks: this.blocks(),
        pendingFixes: [...this.pendingFixMap.values()],
        hiddenWordIds: this.hiddenWordIds()
      } satisfies Pick<DraftPageState, "blocks" | "pendingFixes" | "hiddenWordIds">;
      this.fixes.saveDraft(this.jobId, page.pageIndex, payload).subscribe({
        next: (saved) => this.draftSavedAt.set(saved.updatedAt ?? new Date().toISOString()),
        error: () => void 0
      });
    }, 550);
  }

  saveDraftNow(): void {
    if (!this.page || this.draftSaving()) return;
    const payload = {
      blocks: this.blocks(),
      pendingFixes: [...this.pendingFixMap.values()],
      hiddenWordIds: this.hiddenWordIds()
    } satisfies Pick<DraftPageState, "blocks" | "pendingFixes" | "hiddenWordIds">;
    this.draftSaving.set(true);
    this.fixes.saveDraft(this.jobId, this.page.pageIndex, payload).subscribe({
      next: (saved) => {
        this.draftSaving.set(false);
        this.draftSavedAt.set(saved.updatedAt ?? new Date().toISOString());
        this.statusMessage.set("Draft saved.");
      },
      error: () => {
        this.draftSaving.set(false);
        this.statusMessage.set("Unable to save draft.");
      }
    });
  }

  private upsertFix(key: string, fix: FixDelta): void {
    this.pendingFixMap.set(key, fix);
    this.emitPending();
    this.scheduleDraftSave();
  }

  private clearPendingForBlock(blockId: string, keepDelete = false): void {
    for (const [key, fix] of [...this.pendingFixMap.entries()]) {
      const affectsBlock = fix.blockId === blockId || fix.secondaryBlockId === blockId;
      if (!affectsBlock) continue;
      if (keepDelete && fix.type === "delete") continue;
      this.pendingFixMap.delete(key);
    }
    this.emitPending();
    this.scheduleDraftSave();
  }

  private canvasPoint(event: MouseEvent): { x: number; y: number } {
    const element = this.canvas()?.nativeElement;
    if (!element) return { x: 0, y: 0 };
    const rect = element.getBoundingClientRect();
    const scale = Math.max(0.01, this.scale);
    return {
      x: Number(((event.clientX - rect.left) / scale).toFixed(2)),
      y: Number(((event.clientY - rect.top) / scale).toFixed(2))
    };
  }

  private deriveWordSpans(blocks: TextBlock[]): WordSpan[] {
    const words: WordSpan[] = [];
    for (const block of blocks) {
      const spans = block.rawSpans?.length ? block.rawSpans : [{
        x: block.x,
        y: block.y,
        w: block.w,
        h: block.h,
        text: block.text,
        fontSize: block.fontSize,
        fontName: block.fontName,
        fontColor: block.fontColor
      }];
      spans.forEach((span, spanIndex) => {
        const matches = [...span.text.matchAll(/\S+/g)];
        const unit = span.text.length > 0 ? span.w / span.text.length : span.w;
        matches.forEach((match, wordIndex) => {
          const text = match[0];
          const start = match.index ?? 0;
          const x = span.x + (start * unit);
          const w = Math.max(2, text.length * unit);
          words.push({
            id: `word:${block.id}:${spanIndex}:${wordIndex}`,
            sourceBlockId: block.id,
            x: Number(x.toFixed(2)),
            y: span.y,
            w: Number(w.toFixed(2)),
            h: span.h,
            text,
            fontSize: span.fontSize,
            fontName: span.fontName,
            fontWeight: block.fontWeight,
            fontColor: span.fontColor ?? block.fontColor ?? "#000000",
            confidence: block.confidence,
            tag: "span",
            pageIndex: block.pageIndex,
            styles: defaultStyles(),
            isFirstLineIndented: block.isFirstLineIndented,
            rawSpans: [{ ...span, text }],
            textMode: "plain"
          });
        });
      });
    }
    return words.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }

  private boundingBox(items: Array<Pick<TextBlock, "x" | "y" | "w" | "h">>): SelectionBox {
    const x = Math.min(...items.map((item) => item.x));
    const y = Math.min(...items.map((item) => item.y));
    const right = Math.max(...items.map((item) => item.x + item.w));
    const bottom = Math.max(...items.map((item) => item.y + item.h));
    return {
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      w: Number((right - x).toFixed(2)),
      h: Number((bottom - y).toFixed(2))
    };
  }

  private groupWordsIntoLines(words: WordSpan[]): WordSpan[][] {
    const sorted = [...words].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const tolerance = Math.max(3, (sorted.reduce((sum, word) => sum + word.h, 0) / Math.max(sorted.length, 1)) * 0.55);
    const lines: WordSpan[][] = [];
    for (const word of sorted) {
      const line = lines.find((candidate) => Math.abs(candidate[0].y - word.y) <= tolerance);
      if (line) line.push(word);
      else lines.push([word]);
    }
    return lines.map((line) => line.sort((a, b) => a.x - b.x)).sort((a, b) => a[0].y - b[0].y);
  }

  private commonStyles(words: WordSpan[]): BlockStyles {
    const textIndent = commonNumber(words.map((word) => word.styles.textIndent)) ?? 0;
    const paddingLeft = commonNumber(words.map((word) => word.styles.paddingLeft)) ?? 0;
    const lineHeight = commonNumber(words.map((word) => word.styles.lineHeight)) ?? 1.4;
    const textAlign = commonString(words.map((word) => word.styles.textAlign)) ?? "left";
    return { textIndent, paddingLeft, lineHeight, textAlign };
  }

  private styleOverridesForWord(word: WordSpan, parent: Pick<TextBlock, "fontSize" | "fontName" | "fontWeight" | "fontColor" | "styles">): SemanticChildSpan["styleOverrides"] {
    const overrides: SemanticChildSpan["styleOverrides"] = {};
    if (Math.abs(word.fontSize - parent.fontSize) >= 0.01) overrides.fontSize = word.fontSize;
    if (word.fontName !== parent.fontName) overrides.fontName = word.fontName;
    if (word.fontWeight !== parent.fontWeight) overrides.fontWeight = word.fontWeight;
    if (word.fontColor !== parent.fontColor) overrides.fontColor = word.fontColor;
    const styleOverrides: Partial<BlockStyles> = {};
    (["textIndent", "paddingLeft", "lineHeight", "textAlign"] as Array<keyof BlockStyles>).forEach((key) => {
      if (word.styles[key] !== parent.styles[key]) {
        styleOverrides[key] = word.styles[key] as never;
      }
    });
    if (Object.keys(styleOverrides).length) overrides.styles = styleOverrides;
    return overrides;
  }

  private nextReviewColor(): string {
    const colors = ["#4A90E2", "#27AE60", "#F39C12", "#E74C3C", "#8E44AD", "#16A085", "#D35400", "#2C82C9"];
    const groupedCount = this.blocks().filter((block) => block.sourceSpanIds?.length || block.tag === "img").length;
    return colors[groupedCount % colors.length];
  }

  private cursorForCorner(corner: ResizeCorner): string {
    switch (corner) {
      case "top-left": return "nw-resize";
      case "top-right": return "ne-resize";
      case "bottom-left": return "sw-resize";
      default: return "se-resize";
    }
  }

  private placeCaretAtPoint(element: HTMLElement, point: { x: number; y: number } | null): void {
    if (!point) return;
    const documentWithCaret = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    const range = documentWithCaret.caretRangeFromPoint?.(point.x, point.y);
    if (range) {
      selection.addRange(range);
      return;
    }
    const position = documentWithCaret.caretPositionFromPoint?.(point.x, point.y);
    if (position) {
      const nextRange = document.createRange();
      nextRange.setStart(position.offsetNode, position.offset);
      nextRange.collapse(true);
      selection.addRange(nextRange);
      return;
    }
    const fallback = document.createRange();
    fallback.selectNodeContents(element);
    fallback.collapse(false);
    selection.addRange(fallback);
  }

  private resizeFromCorner(original: TextBlock, corner: ResizeCorner, dx: number, dy: number, pageWidth: number, pageHeight: number): TextBlock {
    let newX = original.x;
    let newY = original.y;
    let newW = original.w;
    let newH = original.h;

    if (corner === "bottom-right") {
      newW = Math.max(10, original.w + dx);
      newH = Math.max(10, original.h + dy);
    } else if (corner === "bottom-left") {
      newW = Math.max(10, original.w - dx);
      newH = Math.max(10, original.h + dy);
      newX = original.x + dx;
    } else if (corner === "top-right") {
      newW = Math.max(10, original.w + dx);
      newH = Math.max(10, original.h - dy);
      newY = original.y + dy;
    } else {
      newW = Math.max(10, original.w - dx);
      newH = Math.max(10, original.h - dy);
      newX = original.x + dx;
      newY = original.y + dy;
    }

    if (newX < 0) {
      newW += newX;
      newX = 0;
    }
    if (newY < 0) {
      newH += newY;
      newY = 0;
    }
    if (newX + newW > pageWidth) newW = pageWidth - newX;
    if (newY + newH > pageHeight) newH = pageHeight - newY;

    return {
      ...cloneBlock(original),
      x: Number(newX.toFixed(2)),
      y: Number(newY.toFixed(2)),
      w: Number(Math.max(10, newW).toFixed(2)),
      h: Number(Math.max(10, newH).toFixed(2))
    };
  }
}
