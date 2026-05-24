import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from "@angular/core";

@Component({
  selector: "app-page-nav",
  standalone: true,
  imports: [CommonModule],
  templateUrl: "./page-nav.component.html",
  styleUrl: "./page-nav.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PageNavComponent {
  @Input() pageCount = 0;
  @Input() currentPageIndex = 0;
  @Input() confidenceMap: Record<number, number> = {};
  @Input() editCountMap: Record<number, number> = {};
  @Output() pageSelected = new EventEmitter<number>();

  pages(): number[] { return Array.from({ length: this.pageCount }, (_, index) => index); }
  confidenceClass(index: number): string { const value = this.confidenceMap[index] ?? 0; return value >= 0.85 ? 'good' : value >= 0.6 ? 'warn' : 'bad'; }
}
