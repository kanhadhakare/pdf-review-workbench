import type { Routes } from "@angular/router";
import { ReviewComponent } from "./pages/review/review.component";
import { UploadComponent } from "./pages/upload/upload.component";

export const appRoutes: Routes = [
  { path: "", component: UploadComponent },
  { path: "review/:jobId", component: ReviewComponent },
  { path: "**", redirectTo: "" }
];
