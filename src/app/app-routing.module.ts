import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';
import { UrlAnalyzerComponent } from './flows/url-analyzer.component';
import { ContentDetectorComponent } from './flows/content-detector.component';
import { StrategySelectorComponent } from './flows/strategy-selector.component';
import { DataExtractorComponent } from './flows/data-extractor.component';
import { DataExporterComponent } from './flows/data-exporter.component';
import { ScraperComponent } from './flows/parent-tree.component';
import { JobsRunnerComponent } from './flows/jobs-runner.component';
import { SearchComponent } from './flows/search.component';

const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'url' },
  { path: 'url', component: UrlAnalyzerComponent },
  { path: 'content', component: ContentDetectorComponent },
  { path: 'strategy', component: StrategySelectorComponent },
  { path: 'extract', component: DataExtractorComponent },
  { path: 'export', component: DataExporterComponent },
  { path: 'parent-tree', component: ScraperComponent },
  { path: 'jobs', component: JobsRunnerComponent },
  { path: 'search', component: SearchComponent },
  { path: '**', redirectTo: 'url' },
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule],
})
export class AppRoutingModule {}
