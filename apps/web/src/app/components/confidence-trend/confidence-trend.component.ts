import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, Input } from "@angular/core";

@Component({
  selector: "app-confidence-trend",
  standalone: true,
  imports: [CommonModule],
  templateUrl: "./confidence-trend.component.html",
  styleUrl: "./confidence-trend.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ConfidenceTrendComponent {
  @Input() points: Array<{ pageIndex: number; confidence: number }> = [];

  path(): string {
    if (!this.points.length) return "";
    const maxX = Math.max(1, this.points.length - 1);
    return this.points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${index / maxX * 300} ${80 - (point.confidence * 80)}`).join(' ');
  }

  summary(): string {
    if (!this.points.length) return 'Avg confidence: 0.00';
    const avg = this.points.reduce((sum, point) => sum + point.confidence, 0) / this.points.length;
    return `Avg confidence: ${avg.toFixed(2)}`;
  }
}
