import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, ViewChild, signal } from "@angular/core";

@Component({
  selector: "app-split-view",
  standalone: true,
  imports: [CommonModule],
  templateUrl: "./split-view.component.html",
  styleUrls: ["./split-view.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SplitViewComponent {
  @ViewChild("container", { static: true }) container!: ElementRef<HTMLDivElement>;
  readonly ratio = signal(Number(localStorage.getItem("pdf-review-split") ?? 0.5));
  private dragging = false;

  get leftWidth(): string { return `${this.ratio() * 100}%`; }
  get rightWidth(): string { return `${(1 - this.ratio()) * 100}%`; }

  startDrag(): void { this.dragging = true; }
  reset(): void { this.ratio.set(0.5); localStorage.setItem("pdf-review-split", "0.5"); }

  @HostListener("document:mouseup") stopDrag(): void { this.dragging = false; }
  @HostListener("document:mousemove", ["$event"])
  move(event: MouseEvent): void {
    if (!this.dragging) return;
    const rect = this.container.nativeElement.getBoundingClientRect();
    const raw = (event.clientX - rect.left) / rect.width;
    const clamped = Math.max(0.2, Math.min(0.8, raw));
    this.ratio.set(clamped);
    localStorage.setItem("pdf-review-split", clamped.toString());
  }
}

