import { Component } from '@angular/core';
import { ScrapeService } from '../scrape.service';
import { ResultStoreService } from '../services/result-store.service';
import { ExportService } from '../services/export.service';

@Component({
  selector: 'app-data-extractor',
  template: `
    <div class="card">
      <div class="card-header">Data Extractor</div>
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
              Extract
            </button>
          </div>
        </div>
        <div *ngIf="loading" class="alert alert-info mt-3">Extracting...</div>
        <div *ngIf="errorMessage" class="alert alert-danger mt-3">
          {{ errorMessage }}
        </div>
        <div *ngIf="result" class="mt-3">
          <div class="d-flex gap-2 mb-3">
            <button
              class="btn btn-sm btn-outline-success"
              (click)="
                export1.downloadJSON(result?.data?.links || [], 'links.json')
              "
              [disabled]="!result?.data?.links?.length"
            >
              Export Links JSON
            </button>
            <button
              class="btn btn-sm btn-outline-secondary"
              (click)="
                export1.downloadCSV(result?.data?.links || [], 'links.csv')
              "
              [disabled]="!result?.data?.links?.length"
            >
              Export Links CSV
            </button>
            <button
              class="btn btn-sm btn-outline-primary"
              (click)="
                export1.downloadExcel(result?.data?.links || [], 'links.xlsx')
              "
              [disabled]="!result?.data?.links?.length"
            >
              Export Links Excel
            </button>
            <button
              class="btn btn-sm btn-outline-dark"
              (click)="print()"
              [disabled]="!result"
            >
              Print/PDF
            </button>
          </div>
          <div class="table-responsive" *ngIf="result?.data?.links?.length">
            <table class="table table-sm table-striped">
              <thead>
                <tr>
                  <th>Text</th>
                  <th>Href</th>
                  <th>Title Attr</th>
                  <th>Text Coverage %</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let l of result.data.links; let idx = index">
                  <td>{{ l.text }}</td>
                  <td>
                    <a [href]="l.href" target="_blank" rel="noopener">{{
                      l.href
                    }}</a>
                  </td>
                  <td>{{ l.titleAttr }}</td>
                  <td>{{ l.textCoveragePct }}</td>
                  <td>
                    <button class="btn btn-sm btn-outline-primary" (click)="extractSingle(l.href, idx)" [disabled]="extractingMap[idx]">Extract</button>
                    <span *ngIf="extractingMap[idx]" class="ms-2 text-info">Extracting...</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Extract content from selected/visible links -->
          <div class="mt-3">
            <div class="d-flex align-items-end gap-2 mb-2 flex-wrap">
              <div>
                <label class="form-label">Max Links</label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  class="form-control"
                  [(ngModel)]="extractLimit"
                  style="width: 120px;"
                />
              </div>
              <div>
                <label class="form-label">Delay (ms)</label>
                <input
                  type="number"
                  min="0"
                  class="form-control"
                  [(ngModel)]="extractDelay"
                  style="width: 120px;"
                />
              </div>
              <div>
                <label class="form-label">Concurrency</label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  class="form-control"
                  [(ngModel)]="extractConcurrency"
                  style="width: 120px;"
                />
              </div>
              <div>
                <label class="form-label d-block">&nbsp;</label>
                <button
                  class="btn btn-outline-primary"
                  (click)="extractFromLinks()"
                  [disabled]="extracting || !result?.data?.links?.length"
                >
                  Extract From Links
                </button>
              </div>
              <div>
                <label class="form-label d-block">&nbsp;</label>
                <button
                  class="btn btn-success"
                  (click)="
                    export1.downloadJSON(extracted || [], 'links-content.json')
                  "
                  [disabled]="!extracted?.length"
                >
                  Download JSON
                </button>
              </div>
              <div>
                <label class="form-label d-block">&nbsp;</label>
                <button
                  class="btn btn-secondary"
                  (click)="
                    export1.downloadCSV(
                      flattenExtractedForCsv(extracted),
                      'links-content.csv'
                    )
                  "
                  [disabled]="!extracted?.length"
                >
                  Download CSV
                </button>
              </div>
              <div>
                <label class="form-label d-block">&nbsp;</label>
                <button
                  class="btn btn-primary"
                  (click)="
                    export1.downloadExcel(
                      flattenExtractedForCsv(extracted),
                      'links-content.xlsx'
                    )
                  "
                  [disabled]="!extracted?.length"
                >
                  Download Excel
                </button>
              </div>
            </div>

            <div *ngIf="extracting" class="alert alert-warning">
              Fetching content from links...
            </div>

            <div *ngIf="extracted?.length" class="table-responsive mt-3">
              <table class="table table-sm table-bordered">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>URL</th>
                    <th>Status</th>
                    <th>Title</th>
                    <th>H1</th>
                    <th>Text Len</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <tr *ngFor="let item of extracted; let i = index">
                    <td>{{ i + 1 }}</td>
                    <td class="text-truncate" style="max-width: 320px;">
                      <a [href]="item.url" target="_blank" rel="noopener">{{
                        item.url
                      }}</a>
                    </td>
                    <td>{{ item.status || (item.error ? 'ERR' : '') }}</td>
                    <td>{{ item.content?.title }}</td>
                    <td>{{ item.content?.pageHeading }}</td>
                    <td>{{ (item.content?.textContent || '').length }}</td>
                    <td>
                      <button
                        class="btn btn-sm btn-outline-secondary"
                        (click)="showExtract(item)"
                      >
                        View
                    </button>
                    <button
                      class="btn btn-sm btn-outline-success ms-1"
                      (click)="
                        export1.downloadJSON(item, 'link-content.json')
                      "
                    >
                      JSON
                    </button>
                    <button class="btn btn-sm btn-outline-secondary ms-1" (click)="exportRowCSV(item)">CSV</button>
                    <button class="btn btn-sm btn-outline-primary ms-1" (click)="exportRowExcel(item)">Excel</button>
                  </td>
                </tr>
                </tbody>
              </table>
            </div>

            <details *ngIf="selectedExtract" class="mt-2">
              <summary>Selected Extract JSON</summary>
              <pre class="mt-2">{{ selectedExtract | json }}</pre>
            </details>
          </div>
          <details class="mt-3">
            <summary>Raw</summary>
            <pre>{{ result | json }}</pre>
          </details>
        </div>
      </div>
    </div>
  `,
  standalone: false,
})
export class DataExtractorComponent {
  url = '';
  loading = false;
  result: any = null;
  extracting = false;
  extracted: any[] = [];
  extractLimit = 10;
  extractDelay = 500;
  extractConcurrency = 3;
  selectedExtract: any = null;
  errorMessage = '';
  extractingMap: { [k: number]: boolean } = {};
  bulkProgressPct = 0;
  processedCount = 0;
  totalToProcess = 0;

  constructor(
    private api: ScrapeService,
    private store: ResultStoreService,
    public export1: ExportService,
  ) {}

  run() {
    if (!this.url) return;
    this.loading = true;
    this.result = null;
    this.api.extractData(this.url).subscribe({
      next: (r) => {
        this.result = r;
        this.loading = false;
        this.store.set(r);
        this.errorMessage = '';
        // Auto-extract content from links if available
        if (this.result?.data?.links?.length) {
          this.extractFromLinks();
        }
      },
      error: (e) => {
        this.result = e?.error || e;
        this.loading = false;
        this.store.set(this.result);
        this.errorMessage =
          typeof e?.error === 'string'
            ? e.error
            : 'Failed to extract base page links';
      },
    });
  }

  print() {
    const links = this.result?.data?.links || [];
    const html = `
      <h1>Extracted Links</h1>
      <table><thead><tr><th>Text</th><th>Href</th><th>Title</th><th>Coverage %</th></tr></thead>
      <tbody>${links.map((l: any) => `<tr><td>${l.text}</td><td>${l.href}</td><td>${l.titleAttr}</td><td>${l.textCoveragePct}</td></tr>`).join('')}</tbody></table>`;
    this.export1.printHtml(html, 'Extracted Links');
  }

  extractFromLinks() {
    if (!this.result?.data?.links?.length) return;
    const hrefs = (this.result.data.links as any[])
      .map((l) => l.href)
      .filter(Boolean);
    this.extracting = true;
    this.extracted = [];
    // Estimate progress locally while batches complete
    const total = Math.min(this.extractLimit, hrefs.length);
    const toProcess = hrefs.slice(0, total);
    this.totalToProcess = toProcess.length;
    this.processedCount = 0;
    this.bulkProgressPct = 0;
    const step = Math.max(1, Math.floor(this.totalToProcess / Math.max(1, this.extractConcurrency)));
    // Use backend concurrency but update progress between sequential calls
    const runBatch = (batch: string[]) => new Promise<void>((resolve) => {
      this.api.extractLinksContent(batch, batch.length, this.extractDelay, this.extractConcurrency).subscribe({
        next: (r) => {
          const data = r?.data || [];
          this.extracted = this.extracted.concat(data);
          this.processedCount += batch.length;
          this.bulkProgressPct = Math.min(100, Math.round((this.processedCount / Math.max(1, this.totalToProcess)) * 100));
          resolve();
        },
        error: () => { resolve(); }
      });
    });
    const batchSize = Math.min(Math.max(1, this.extractConcurrency * 2), 20);
    (async () => {
      for (let i = 0; i < toProcess.length; i += batchSize) {
        const batch = toProcess.slice(i, i + batchSize);
        await runBatch(batch);
      }
      this.extracting = false;
    })();
  }

  flattenExtractedForCsv(arr: any[] = []) {
    return (arr || []).map((x: any) => ({
      url: x?.url,
      status: x?.status,
      title: x?.content?.title,
      h1: x?.content?.pageHeading,
      textLen: (x?.content?.textContent || '').length,
      images: Array.isArray(x?.content?.images) ? x.content.images.length : 0,
      tables: Array.isArray(x?.content?.tables) ? x.content.tables.length : 0,
    }));
  }

  showExtract(item: any) {
    this.selectedExtract = item;
  }

  extractSingle(href: string, idx: number) {
    if (!href) return;
    this.extractingMap[idx] = true;
    this.api.extractOne(href).subscribe({
      next: (r) => {
        const data = r?.data || r;
        // Append or replace in preview collection
        this.extracted.push(data);
        this.extractingMap[idx] = false;
      },
      error: (e) => {
        this.extracted.push({ url: href, error: e?.error || e });
        this.extractingMap[idx] = false;
      }
    });
  }

  exportRowCSV(item: any) {
    const flat = this.flattenExtractedForCsv([item]);
    this.export1.downloadCSV(flat, 'link-content.csv');
  }

  exportRowExcel(item: any) {
    const flat = this.flattenExtractedForCsv([item]);
    this.export1.downloadExcel(flat, 'link-content.xlsx');
  }
}
