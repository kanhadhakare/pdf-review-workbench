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
import { type BlockStyles, type FixDelta, type JobEditSummary, type PageResult, type SemanticTag, type TextBlock } from "@pdf-review-workbench/shared";
import { FixService } from "../../services/fix.service";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

interface PointerActionState {
  mode: "move" | "resize";
  blockId: string;
  corner?: ResizeCorner;
  startX: number;
  startY: number;
  original: TextBlock;
}

interface PendingSummary {
  total: number;
  byType: Record<string, number>;
}

function cloneBlock<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function tagOrder(tag: SemanticTag): number {
  switch (tag) {
    case "h1":
      return 1;
    case "h2":
      return 2;
    case "h3":
      return 3;
    case "p":
      return 4;
    case "caption":
      return 5;
    case "span":
      return 6;
    default:
      return 7;
  }
}

@Component({
  selector: "app-fix-editor",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./fix-editor.component.html",
  styleUrl: "./fix-editor.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FixEditorComponent implements OnChanges {
  private readonly fixes = inject(FixService);
  private readonly canvas = viewChild<ElementRef<HTMLDivElement>>("canvas");
  private pointerState: PointerActionState | null = null;
  private pendingFixMap = new Map<string, FixDelta>();
  private baselineBlocks = new Map<string, TextBlock>();
  private currentBlocks = new Map<string, TextBlock>();
  private styleBaseline: BlockStyles | null = null;
  private lastTextEditPoint: { x: number; y: number } | null = null;

  @Input({ required: true }) jobId = "";
  @Input() page: PageResult | null = null;
  @Input() editMode = false;
  @Input() scale = 1;
  @Output() pendingChanged = new EventEmitter<PendingSummary>();
  @Output() fixesSaved = new EventEmitter<JobEditSummary>();

  readonly blocks = signal<TextBlock[]>([]);
  readonly selectedIds = signal<string[]>([]);
  readonly editingTextId = signal<string | null>(null);
  readonly statusMessage = signal("");
  readonly saving = signal(false);
  readonly showStylePanel = signal(false);
  readonly deletingIds = signal<string[]>([]);
  readonly styleDraft = signal<BlockStyles>({
    textIndent: 0,
    paddingLeft: 0,
    lineHeight: 1.4,
    textAlign: "left"
  });

  readonly selectedBlock = computed(() => {
    const id = this.selectedIds()[0];
    return id ? this.currentBlocks.get(id) ?? null : null;
  });

  readonly toolbarBlock = computed(() => {
    const ids = this.selectedIds();
    if (!ids.length) {
      return null;
    }

    const blocks = ids
      .map((id) => this.currentBlocks.get(id))
      .filter((block): block is TextBlock => Boolean(block));

    if (!blocks.length) {
      return null;
    }

    return [...blocks].sort((a, b) => (a.y - b.y) || (a.x - b.x))[0];
  });

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
    }
  }

  @HostListener("document:mousemove", ["$event"])
  handlePointerMove(event: MouseEvent): void {
    if (!this.pointerState || !this.editMode) {
      return;
    }

    event.preventDefault();
    const block = this.currentBlocks.get(this.pointerState.blockId);
    const page = this.page;
    if (!block || !page) {
      return;
    }

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
    if (!this.pointerState || !this.editMode) {
      return;
    }

    const state = this.pointerState;
    this.pointerState = null;
    document.body.style.cursor = "";
    const current = this.currentBlocks.get(state.blockId);
    if (!current) {
      return;
    }

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
    if (!this.editMode) {
      return;
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

  selectBlock(blockId: string, event: MouseEvent): void {
    if (!this.editMode) {
      return;
    }

    event.stopPropagation();
    const current = this.selectedIds();
    if (event.shiftKey) {
      if (!current.length) {
        this.selectedIds.set([blockId]);
      } else if (current[0] === blockId) {
        return;
      } else {
        this.selectedIds.set([current[0], blockId]);
      }
    } else {
      this.selectedIds.set([blockId]);
    }

    const block = this.currentBlocks.get(blockId);
    if (block) {
      this.styleBaseline = cloneBlock(block).styles;
      this.styleDraft.set({ ...block.styles });
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
    if (!this.editMode || this.editingTextId() === blockId) {
      return;
    }

    if ((event.target as HTMLElement).closest(".resize-handle") || (event.target as HTMLElement).closest(".block-toolbar")) {
      return;
    }

    const block = this.currentBlocks.get(blockId);
    if (!block) {
      return;
    }

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
    if (!this.editMode) {
      return;
    }

    event.stopPropagation();
    event.preventDefault();
    const block = this.currentBlocks.get(blockId);
    if (!block) {
      return;
    }

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
    if (!this.editMode) {
      return;
    }

    event.stopPropagation();
    this.lastTextEditPoint = { x: event.clientX, y: event.clientY };
    this.editingTextId.set(blockId);
    queueMicrotask(() => {
      const element = document.querySelector<HTMLElement>(`[data-editor-block-id="${blockId}"] .block-content`);
      if (!element) {
        return;
      }
      element.focus();
      this.placeCaretAtPoint(element, this.lastTextEditPoint);
    });
  }

  finishTextEdit(blockId: string, event: FocusEvent): void {
    const block = this.currentBlocks.get(blockId);
    const original = this.baselineBlocks.get(blockId);
    const element = event.target as HTMLElement;
    const nextText = element.innerText.trim();
    this.editingTextId.set(null);

    if (!block || !original || !nextText) {
      if (block) {
        element.innerText = block.text;
      }
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
    }
  }

  handleTextKeydown(blockId: string, event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      const block = this.currentBlocks.get(blockId);
      const target = event.target as HTMLElement;
      if (block) {
        target.innerText = block.text;
      }
      target.blur();
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

  styleHint(): string {
    const block = this.selectedBlock();
    if (!block) {
      return "";
    }

    const indent = this.styleDraft().textIndent;
    if (block.tag === "p" && block.isFirstLineIndented) {
      return "Correcting detected first-line indent.";
    }
    if (!block.isFirstLineIndented && indent > 0) {
      return "Adding indent - this block will be marked as first-line indented.";
    }
    if (block.tag === "p" && indent > 0) {
      return "This indent will be learned for this PDF type.";
    }
    return "";
  }

  changeTag(tag: SemanticTag | "delete"): void {
    const block = this.selectedBlock();
    if (!block) {
      return;
    }

    if (tag === "delete") {
      this.deleteSelected();
      return;
    }

    if (tag === block.tag) {
      return;
    }

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
    if (ids.length !== 2) {
      return;
    }

    const blocks = ids
      .map((id) => this.currentBlocks.get(id))
      .filter((block): block is TextBlock => Boolean(block))
      .sort((a, b) => (a.x - b.x) || (a.y - b.y));

    if (blocks.length !== 2) {
      return;
    }

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
    this.styleBaseline = cloneBlock(merged).styles;
    this.styleDraft.set({ ...merged.styles });
    this.refreshBlocks();
  }

  deleteSelected(): void {
    const ids = this.selectedIds();
    if (!ids.length) {
      return;
    }

    this.deletingIds.set(ids);
    window.setTimeout(() => {
      for (const id of ids) {
        const block = this.currentBlocks.get(id);
        if (!block) {
          continue;
        }

        this.upsertFix(`delete:${id}`, {
          id: crypto.randomUUID(),
          jobId: this.jobId,
          pageIndex: block.pageIndex,
          type: "delete",
          blockId: id,
          before: {
            x: block.x,
            y: block.y,
            w: block.w,
            h: block.h,
            text: block.text,
            tag: block.tag,
            styles: { ...block.styles }
          },
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
    }, 320);
  }

  applyStyleChanges(): void {
    const block = this.selectedBlock();
    if (!block || !this.styleBaseline) {
      return;
    }

    const draft = this.styleDraft();
    const nextBlock = {
      ...block,
      styles: {
        ...block.styles,
        ...draft
      },
      isFirstLineIndented: draft.textIndent > 0 ? true : block.isFirstLineIndented
    };
    this.currentBlocks.set(block.id, nextBlock);
    this.refreshBlocks();

    const changed = (["textIndent", "paddingLeft", "lineHeight", "textAlign"] as Array<keyof BlockStyles>)
      .some((key) => draft[key] !== this.styleBaseline![key]);

    if (changed) {
      this.upsertFix(`style:${block.id}`, {
        id: crypto.randomUUID(),
        jobId: this.jobId,
        pageIndex: block.pageIndex,
        type: "style-change",
        blockId: block.id,
        before: { styles: { ...this.styleBaseline } },
        after: { styles: { ...nextBlock.styles }, isFirstLineIndented: nextBlock.isFirstLineIndented },
        reviewerId: "local-reviewer",
        timestamp: new Date().toISOString()
      });
      this.styleBaseline = cloneBlock(nextBlock).styles;
      this.showStylePanel.set(false);
    }
  }

  discardChanges(): void {
    this.resetFromPage();
    this.statusMessage.set("Pending changes discarded.");
  }

  submitFixes(): void {
    const fixes = [...this.pendingFixMap.values()];
    if (!this.page || !fixes.length || this.saving()) {
      return;
    }

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

  isSelected(blockId: string): boolean {
    return this.selectedIds().includes(blockId);
  }

  isDeleting(blockId: string): boolean {
    return this.deletingIds().includes(blockId);
  }

  toolbarTop(): number {
    const block = this.toolbarBlock();
    if (!block) {
      return 0;
    }
    return block.y < 48 ? block.y + block.h + 8 : block.y - 48;
  }

  toolbarLeft(): number {
    return this.toolbarBlock()?.x ?? 0;
  }

  private resetFromPage(): void {
    this.pendingFixMap.clear();
    this.baselineBlocks.clear();
    this.currentBlocks.clear();
    this.selectedIds.set([]);
    this.editingTextId.set(null);
    this.statusMessage.set("");
    this.styleBaseline = null;
    this.showStylePanel.set(false);
    this.deletingIds.set([]);

    const nextBlocks = (this.page?.blocks ?? []).map((block) => cloneBlock(block));
    for (const block of nextBlocks) {
      this.baselineBlocks.set(block.id, cloneBlock(block));
      this.currentBlocks.set(block.id, block);
    }
    this.blocks.set(nextBlocks.sort((a, b) => (a.y - b.y) || (a.x - b.x)));
    this.emitPending();
  }

  private refreshBlocks(): void {
    this.blocks.set([...this.currentBlocks.values()].sort((a, b) => (a.y - b.y) || (a.x - b.x)));
  }

  private emitPending(): void {
    this.pendingChanged.emit(this.pendingSummary());
  }

  private upsertFix(key: string, fix: FixDelta): void {
    this.pendingFixMap.set(key, fix);
    this.emitPending();
  }

  private clearPendingForBlock(blockId: string, keepDelete = false): void {
    for (const [key, fix] of [...this.pendingFixMap.entries()]) {
      const affectsBlock = fix.blockId === blockId || fix.secondaryBlockId === blockId;
      if (!affectsBlock) {
        continue;
      }
      if (keepDelete && fix.type === "delete") {
        continue;
      }
      this.pendingFixMap.delete(key);
    }
    this.emitPending();
  }

  private cursorForCorner(corner: ResizeCorner): string {
    switch (corner) {
      case "top-left":
        return "nw-resize";
      case "top-right":
        return "ne-resize";
      case "bottom-left":
        return "sw-resize";
      default:
        return "se-resize";
    }
  }

  private placeCaretAtPoint(element: HTMLElement, point: { x: number; y: number } | null): void {
    if (!point) {
      return;
    }

    const documentWithCaret = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    selection.removeAllRanges();

    if (documentWithCaret.caretRangeFromPoint) {
      const range = documentWithCaret.caretRangeFromPoint(point.x, point.y);
      if (range) {
        selection.addRange(range);
        return;
      }
    }

    if (documentWithCaret.caretPositionFromPoint) {
      const position = documentWithCaret.caretPositionFromPoint(point.x, point.y);
      if (position) {
        const range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
        selection.addRange(range);
        return;
      }
    }

    const fallback = document.createRange();
    fallback.selectNodeContents(element);
    fallback.collapse(false);
    selection.addRange(fallback);
  }

  private resizeFromCorner(
    original: TextBlock,
    corner: ResizeCorner,
    dx: number,
    dy: number,
    pageWidth: number,
    pageHeight: number
  ): TextBlock {
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
    if (newX + newW > pageWidth) {
      newW = pageWidth - newX;
    }
    if (newY + newH > pageHeight) {
      newH = pageHeight - newY;
    }

    return {
      ...cloneBlock(original),
      x: Number(newX.toFixed(2)),
      y: Number(newY.toFixed(2)),
      w: Number(Math.max(10, newW).toFixed(2)),
      h: Number(Math.max(10, newH).toFixed(2))
    };
  }

}

