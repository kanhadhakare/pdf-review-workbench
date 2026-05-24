import { CommonModule } from "@angular/common";
import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { ConfidenceTrendComponent } from "../../components/confidence-trend/confidence-trend.component";
import { JobService } from "../../services/job.service";

@Component({
  selector: "app-dashboard-page",
  standalone: true,
  imports: [CommonModule, ConfidenceTrendComponent],
  templateUrl: "./dashboard.component.html",
  styleUrl: "./dashboard.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly jobs = inject(JobService);
  readonly summary = signal<any>(null);

  constructor() {
    const jobId = this.route.snapshot.paramMap.get("jobId") ?? "";
    this.jobs.getEditSummary(jobId).subscribe({ next: (data) => this.summary.set(data) });
  }
}
