import { Component } from '@angular/core';
import { ScrapeService } from '../scrape.service';
import { ResultStoreService } from '../services/result-store.service';
import { ExportService } from '../services/export.service';

@Component({
  selector: 'app-strategy-selector',
  template: `
    <div class="card">
      <div class="card-header">Scraping Strategy Selector</div>
      <div class="card-body">
        <div class="d-flex align-items-end gap-2 flex-wrap">
          <div class="flex-grow-1">
            <label class="form-label">URL</label>
            <input
              class="form-control"
              [(ngModel)]="url"
              placeholder="https://example.com"
            />
          </div>
          <div>
            <label class="form-label d-block">&nbsp;</label>
            <button
              class="btn btn-primary"
              (click)="run()"
              [disabled]="loading || !url"
            >
              Select
            </button>
          </div>
        </div>
        <div *ngIf="loading" class="alert alert-info mt-3">Analyzing...</div>
        <div *ngIf="result" class="mt-3">
          <div class="d-flex gap-2 mb-2">
            <button
              class="btn btn-sm btn-outline-success"
              (click)="export1.downloadJSON(result, 'strategy.json')"
            >
              Export JSON
            </button>
            <button
              class="btn btn-sm btn-outline-secondary"
              (click)="export1.downloadCSV([result?.data], 'strategy.csv')"
            >
              Export CSV
            </button>
            <button
              class="btn btn-sm btn-outline-primary"
              (click)="export1.downloadExcel([result?.data], 'strategy.xlsx')"
            >
              Export Excel
            </button>
            <button class="btn btn-sm btn-outline-dark" (click)="print()">
              Print/PDF
            </button>
          </div>
          <pre>{{ result | json }}</pre>

          <div class="mt-3">
            <h6>Scrape With Strategy</h6>
            <div class="d-flex gap-2 flex-wrap align-items-end">
              <div class="form-text">
                Recommended: {{ result?.data?.strategy }}
              </div>
              <button
                class="btn btn-outline-primary btn-sm"
                (click)="scrapeWith(result?.data?.strategy || 'Static HTML')"
                [disabled]="!result"
              >
                Run
              </button>
            </div>
            <div *ngIf="scraped" class="mt-2">
              <div class="d-flex gap-2 mb-2">
                <button
                  class="btn btn-sm btn-outline-success"
                  (click)="export1.downloadJSON(scraped, 'scraped.json')"
                >
                  Export JSON
                </button>
                <button
                  class="btn btn-sm btn-outline-secondary"
                  (click)="
                    export1.downloadCSV([scraped?.content], 'scraped.csv')
                  "
                >
                  Export CSV
                </button>
                <button
                  class="btn btn-sm btn-outline-primary"
                  (click)="
                    export1.downloadExcel([scraped?.content], 'scraped.xlsx')
                  "
                >
                  Export Excel
                </button>
                <!-- <button class="btn btn-sm btn-outline-dark" (click)="export1.printHtml('<pre>'+ (scraped | json) +'</pre>', 'Scraped')">Print/PDF</button> -->
              </div>
              <pre>{{ scraped | json }}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  standalone: false,
})
export class StrategySelectorComponent {
  url = '';
  loading = false;
  result: any = null;
  scraped: any = null;

  constructor(
    private api: ScrapeService,
    private store: ResultStoreService,
    public export1: ExportService,
  ) {}

  run() {
    if (!this.url) return;
    this.loading = true;
    this.result = null;
    this.api.selectStrategy(this.url).subscribe({
      next: (r) => {
        this.result = r;
        this.loading = false;
        this.store.set(r);
      },
      error: (e) => {
        this.result = e?.error || e;
        this.loading = false;
        this.store.set(this.result);
      },
    });
  }

  print() {
    const data = this.result?.data || {};
    const html = `
      <h1>Scraping Strategy</h1>
      <p><strong>URL:</strong> ${this.url}</p>
      <table><tbody>
        ${Object.keys(data)
          .map((k) => `<tr><th>${k}</th><td>${(data as any)[k]}</td></tr>`)
          .join('')}
      </tbody></table>`;
    this.export1.printHtml(html, 'Strategy');
  }

  scrapeWith(strategy: string) {
    if (!this.url) return;
    this.scraped = null;
    this.api.scrapeWithStrategy(this.url, strategy).subscribe({
      next: (r) => (this.scraped = r?.data || r),
      error: (e) => (this.scraped = { error: e?.error || e }),
    });
  }
}
