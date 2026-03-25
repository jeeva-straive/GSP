import { BrowserModule } from '@angular/platform-browser';
import { CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA, NgModule } from '@angular/core';
import { HttpClientModule } from '@angular/common/http';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UrlAnalyzerComponent } from './flows/url-analyzer.component';
import { ContentDetectorComponent } from './flows/content-detector.component';
import { StrategySelectorComponent } from './flows/strategy-selector.component';
import { DataExtractorComponent } from './flows/data-extractor.component';
import { DataExporterComponent } from './flows/data-exporter.component';
import { ScraperComponent } from './flows/parent-tree.component';
import { ExportService } from './services/export.service';
import { ResultStoreService } from './services/result-store.service';
import { JobsRunnerComponent } from './flows/jobs-runner.component';
import { SearchComponent } from './flows/search.component';

@NgModule({
  declarations: [
    AppComponent,
    UrlAnalyzerComponent,
    ContentDetectorComponent,
    StrategySelectorComponent,
    DataExtractorComponent,
    DataExporterComponent,

    ScraperComponent,
    JobsRunnerComponent,
    SearchComponent,
  ],
  imports: [
    BrowserModule,
    AppRoutingModule,
    CommonModule,
    FormsModule,
    HttpClientModule,
  ],
  providers: [ExportService, ResultStoreService],
  bootstrap: [AppComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA],
})
export class AppModule {}
