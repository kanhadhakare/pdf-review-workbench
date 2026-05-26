import { Routes } from "@angular/router";
import { UploadComponent } from "./pages/upload/upload.component";
import { ReviewComponent } from "./pages/review/review.component";
import { DashboardComponent } from "./pages/dashboard/dashboard.component";
import { PdfDashboardComponent } from "./pages/pdf-dashboard/pdf-dashboard.component";

export const appRoutes: Routes = [
  { path: "", component: UploadComponent },
  { path: "review/:jobId", component: ReviewComponent },
  { path: "dashboard", component: PdfDashboardComponent },
  { path: "dashboard/:jobId", component: DashboardComponent },
  { path: "**", redirectTo: "" }
];
