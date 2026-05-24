import { ChangeDetectionStrategy, Component, HostListener, signal } from "@angular/core";

@Component({
  selector: "app-split-view",
  standalone: true,
  template: `
    <section class="split-view" [style.gridTemplateColumns]="gridTemplate()">
      <div class="split-view__pane split-view__pane--left">
        <ng-content select="[leftPane]"></ng-content>
      </div>

      <button
        type="button"
        class="split-view__divider"
        aria-label="Resize split view"
        (pointerdown)="beginResize($event)">
      </button>

      <div class="split-view__pane split-view__pane--right">
        <ng-content select="[rightPane]"></ng-content>
      </div>
    </section>
  `,
  styles: [`
    :host {
      display: block;
      min-height: 0;
      height: 100%;
    }

    .split-view {
      display: grid;
      grid-template-columns: minmax(320px, 1fr) 12px minmax(320px, 1fr);
      height: 100%;
      min-height: 0;
    }

    .split-view__pane {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      background: rgba(10, 15, 23, 0.64);
    }

    .split-view__divider {
      padding: 0;
      background: linear-gradient(180deg, rgba(94, 208, 255, 0.14), rgba(94, 208, 255, 0.04));
      border-left: 1px solid rgba(94, 208, 255, 0.16);
      border-right: 1px solid rgba(94, 208, 255, 0.16);
      cursor: col-resize;
    }

    .split-view__divider:hover {
      background: linear-gradient(180deg, rgba(94, 208, 255, 0.3), rgba(94, 208, 255, 0.08));
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SplitViewComponent {
  private resizing = false;
  private readonly left = signal(50);

  gridTemplate(): string {
    return `minmax(320px, ${this.left()}fr) 12px minmax(320px, ${100 - this.left()}fr)`;
  }

  beginResize(event: PointerEvent): void {
    event.preventDefault();
    this.resizing = true;
  }

  @HostListener("window:pointerup")
  endResize(): void {
    this.resizing = false;
  }

  @HostListener("window:pointermove", ["$event"])
  onPointerMove(event: PointerEvent): void {
    if (!this.resizing) {
      return;
    }

    const width = window.innerWidth;
    const ratio = (event.clientX / width) * 100;
    this.left.set(Math.min(70, Math.max(30, ratio)));
  }
}
