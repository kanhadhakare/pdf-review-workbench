import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";

@Component({
  selector: "app-page-nav",
  standalone: true,
  imports: [CommonModule],
  template: `
    <nav class="page-nav" aria-label="Page navigation">
      <header class="page-nav__header">
        <p>Pages</p>
        <span>{{ pageCount() }}</span>
      </header>

      <div class="page-nav__list">
        @for (page of pages(); track page) {
          <button
            type="button"
            class="page-nav__button"
            [class.is-active]="page === currentPageIndex()"
            [style.--status]="pageTone(page)"
            (click)="pageSelected.emit(page)">
            <span>{{ page + 1 }}</span>
            <small>{{ formatConfidence(page) }}</small>
          </button>
        }
      </div>
    </nav>
  `,
  styles: [`
    .page-nav {
      display: flex;
      flex-direction: column;
      height: 100%;
      border-right: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(10, 17, 29, 0.94), rgba(12, 23, 37, 0.88));
    }

    .page-nav__header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin: 0;
      padding: var(--space-3);
      border-bottom: 1px solid var(--border);
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 0.78rem;
    }

    .page-nav__header p {
      margin: 0;
    }

    .page-nav__list {
      display: grid;
      gap: var(--space-2);
      padding: var(--space-3);
      overflow: auto;
    }

    .page-nav__button {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 14px;
      border-radius: var(--radius-sm);
      background: rgba(255, 255, 255, 0.02);
      color: var(--text);
      border: 1px solid color-mix(in srgb, var(--status) 38%, transparent);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
      transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
    }

    .page-nav__button:hover {
      transform: translateX(2px);
      background: rgba(255, 255, 255, 0.05);
    }

    .page-nav__button.is-active {
      background: linear-gradient(135deg, rgba(94, 208, 255, 0.2), rgba(94, 208, 255, 0.08));
      border-color: rgba(94, 208, 255, 0.55);
    }

    .page-nav__button small {
      color: var(--status);
      font-size: 0.78rem;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PageNavComponent {
  readonly pageCount = input.required<number>();
  readonly currentPageIndex = input.required<number>();
  readonly confidenceMap = input<Record<number, number>>({});
  readonly pageSelected = output<number>();

  readonly pages = computed(() => Array.from({ length: this.pageCount() }, (_, index) => index));

  pageTone(pageIndex: number): string {
    const confidence = this.confidenceMap()[pageIndex] ?? 0;
    if (confidence >= 0.85) {
      return "var(--success)";
    }

    if (confidence >= 0.6) {
      return "var(--warning)";
    }

    return "var(--danger)";
  }

  formatConfidence(pageIndex: number): string {
    const confidence = this.confidenceMap()[pageIndex];
    return typeof confidence === "number" ? confidence.toFixed(2) : "--";
  }
}
