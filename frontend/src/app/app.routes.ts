import { Routes } from "@angular/router";
import { UploadComponent } from "./pages/upload/upload.component";
import { ReviewComponent } from "./pages/review/review.component";
import { DashboardComponent } from "./pages/dashboard/dashboard.component";
import { PdfDashboardComponent } from "./pages/pdf-dashboard/pdf-dashboard.component";
import { ArchiveUploadComponent } from "./pages/archive-upload/archive-upload.component";
import { ArchiveBookComponent } from "./pages/archive-book/archive-book.component";
import { HomeComponent } from "./pages/home/home.component";

export const appRoutes: Routes = [
  { path: "", component: HomeComponent },
  { path: "upload-pdf", component: UploadComponent },
  { path: "upload-archive", component: ArchiveUploadComponent },
  { path: "archive/:jobId", component: ArchiveBookComponent },
  { path: "review/:jobId", component: ReviewComponent },
  { path: "dashboard", component: PdfDashboardComponent },
  { path: "dashboard/:jobId", component: DashboardComponent },
  { path: "**", redirectTo: "" }
];
