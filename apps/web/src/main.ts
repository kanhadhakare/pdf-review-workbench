import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, RouterOutlet } from "@angular/router";
import { provideHttpClient } from "@angular/common/http";
import { Component } from "@angular/core";
import { appRoutes } from "./app/app.routes";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [RouterOutlet],
  template: `<router-outlet />`
})
class AppComponent {}

bootstrapApplication(AppComponent, {
  providers: [provideRouter(appRoutes), provideHttpClient()]
}).catch((error) => console.error(error));
