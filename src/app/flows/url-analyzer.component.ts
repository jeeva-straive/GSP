import { Component } from '@angular/core';
import { ScrapeService } from '../scrape.service';
import { ResultStoreService } from '../services/result-store.service';

@Component({
  selector: 'app-url-analyzer',
  template: `
    <div class="card">
      <div class="card-header">URL Analyzer</div>
      <div class="card-body">
        <div class="d-flex align-items-end gap-2 flex-wrap">
          <div class="flex-grow-1">
            <label class="form-label">URL</label>
            <input class="form-control" [(ngModel)]="url" placeholder="https://example.com" />
          </div>
          <div>
            <label class="form-label d-block">&nbsp;</label>
            <button class="btn btn-primary" (click)="run()" [disabled]="loading || !url">Analyze</button>
          </div>
        </div>
        <div *ngIf="loading" class="alert alert-info mt-3">Analyzing...</div>
        <div *ngIf="result" class="mt-3">
          <pre>{{ result | json }}</pre>
        </div>
      </div>
    </div>
  `,
})
export class UrlAnalyzerComponent {
  url = '';
  loading = false;
  result: any = null;

  constructor(private api: ScrapeService, private store: ResultStoreService) {}

  run() {
    if (!this.url) return;
    this.loading = true;
    this.result = null;
    this.api.analyzeUrl(this.url).subscribe({
      next: (r) => { this.result = r; this.loading = false; this.store.set(r); },
      error: (e) => { this.result = e?.error || e; this.loading = false; this.store.set(this.result); },
    });
  }
}

