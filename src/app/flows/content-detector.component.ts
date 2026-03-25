import { Component } from '@angular/core';
import { ScrapeService } from '../scrape.service';
import { ResultStoreService } from '../services/result-store.service';
import { ExportService } from '../services/export.service';

@Component({
  selector: 'app-content-detector',
  template: `
    <div class="card">
      <div class="card-header">Content Detector</div>
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
              Detect
            </button>
          </div>
          <div>
            <label class="form-label d-block">&nbsp;</label>
            <button
              class="btn btn-outline-secondary"
              (click)="fetchFilters()"
              [disabled]="loading || !url"
            >
              Fetch Filters
            </button>
          </div>
        </div>
        <div *ngIf="loading" class="alert alert-info mt-3">Detecting...</div>
        <div *ngIf="result" class="mt-3">
          <div class="d-flex gap-2 mb-2">
            <button
              class="btn btn-sm btn-outline-success"
              (click)="export1.downloadJSON(result, 'content.json')"
            >
              Export JSON
            </button>
            <button
              class="btn btn-sm btn-outline-secondary"
              (click)="export1.downloadCSV([result?.data], 'content.csv')"
            >
              Export CSV
            </button>
            <button
              class="btn btn-sm btn-outline-primary"
              (click)="export1.downloadExcel([result?.data], 'content.xlsx')"
            >
              Export Excel
            </button>
            <button class="btn btn-sm btn-outline-dark" (click)="print()">
              Print/PDF
            </button>
          </div>
          <pre>{{ result | json }}</pre>

          <div class="mt-3">
            <h6>Actions</h6>
            <div class="d-flex align-items-end gap-2 flex-wrap">
              <div class="form-text">
                Detected types: {{ result?.data?.types | json }}
              </div>
              <div class="ms-auto"></div>
              <div>
                <button
                  class="btn btn-outline-primary btn-sm"
                  (click)="extractKV()"
                >
                  Extract Key/Value
                </button>
              </div>
              <div class="d-flex align-items-end gap-2">
                <div>
                  <label class="form-label">Max Links</label>
                  <input
                    type="number"
                    class="form-control form-control-sm"
                    [(ngModel)]="extractLimit"
                    style="width:100px"
                  />
                </div>
                <div>
                  <label class="form-label">Delay (ms)</label>
                  <input
                    type="number"
                    class="form-control form-control-sm"
                    [(ngModel)]="extractDelay"
                    style="width:100px"
                  />
                </div>
                <div>
                  <label class="form-label">Concurrency</label>
                  <input
                    type="number"
                    class="form-control form-control-sm"
                    [(ngModel)]="extractConcurrency"
                    style="width:100px"
                  />
                </div>
                <div>
                  <label class="form-label d-block">&nbsp;</label>
                  <button
                    class="btn btn-outline-secondary btn-sm"
                    (click)="extractLinks()"
                    [disabled]="extracting || !result?.data?.linksList?.length"
                  >
                    Extract From Links
                  </button>
                </div>
              </div>
            </div>

            <!-- Filters UI -->
            <div class="mt-3" *ngIf="filtersLoading">
              <div class="alert alert-info">Fetching filters...</div>
            </div>
            <div class="mt-3" *ngIf="filtersError">
              <div class="alert alert-danger">{{ filtersError }}</div>
            </div>
            <div class="mt-3" *ngIf="filters">
              <h6>Available Filters</h6>
              <!-- Anchor-based parameters -->
              <div *ngIf="filters?.anchorParams?.length">
                <div class="mb-2" *ngFor="let p of filters.anchorParams">
                  <div class="fw-semibold">{{ p.key }}</div>
                  <div class="d-flex flex-wrap gap-3 mt-1">
                    <label
                      *ngFor="let opt of p.options"
                      class="form-check-label"
                    >
                      <input
                        type="checkbox"
                        class="form-check-input me-1"
                        [checked]="isAnchorSelected(p.key, opt.value)"
                        (change)="onAnchorChange(p.key, opt.value, $any($event.target))"
                      />
                      {{ opt.label || opt.value }}
                    </label>
                  </div>
                </div>
              </div>

              <!-- Form-based fields -->
              <div *ngIf="filters?.forms?.length" class="mt-3">
                <div
                  class="mb-3"
                  *ngFor="let f of filters.forms; let fi = index"
                >
                  <div class="mb-2 fw-semibold">
                    Form {{ fi + 1 }} ({{ f.method }} {{ f.action || '' }})
                  </div>
                  <div class="row g-3">
                    <div class="col-12 col-md-6" *ngFor="let field of f.fields">
                      <div *ngIf="field.kind === 'select'">
                        <label class="form-label">{{
                          field.label || field.name
                        }}</label>
                        <select
                          class="form-select form-select-sm"
                          [(ngModel)]="formModel[field.name]"
                        >
                          <option
                            *ngFor="let o of field.options"
                            [value]="o.value"
                          >
                            {{ o.label }}
                          </option>
                        </select>
                      </div>
                      <div *ngIf="field.kind === 'checkbox'">
                        <div class="form-label">
                          {{ field.label || field.name }}
                        </div>
                        <div class="d-flex flex-wrap gap-3">
                          <label
                            *ngFor="let o of field.options"
                            class="form-check-label"
                          >
                            <input
                              type="checkbox"
                              class="form-check-input me-1"
                              [checked]="isFormOptionSelected(field.name, o.value)"
                              (change)="onFormOptionChange(field.name, o.value, true, $any($event.target))"
                            />
                            {{ o.label || o.value }}
                          </label>
                        </div>
                      </div>
                      <div *ngIf="field.kind === 'radio'">
                        <div class="form-label">
                          {{ field.label || field.name }}
                        </div>
                        <div class="d-flex flex-wrap gap-3">
                          <label
                            *ngFor="let o of field.options"
                            class="form-check-label"
                          >
                            <input
                              type="radio"
                              class="form-check-input me-1"
                              [name]="'rad_' + field.name"
                              [value]="o.value"
                              [checked]="formModel[field.name] === o.value"
                              (change)="formModel[field.name] = o.value"
                            />
                            {{ o.label || o.value }}
                          </label>
                        </div>
                      </div>
                       <div *ngIf="field.kind === 'textarea'">
                         <label class="form-label">{{ field.label || field.name }}</label>
                         <textarea class="form-control form-control-sm" [(ngModel)]="formModel[field.name]"></textarea>
                       </div>
                       <div
                         *ngIf="
                           field.kind !== 'select' &&
                           field.kind !== 'checkbox' &&
                           field.kind !== 'radio' &&
                           field.kind !== 'textarea'
                         "
                       >
                         <label class="form-label">{{ field.label || field.name }}</label>
                         <input
                           class="form-control form-control-sm"
                           [attr.type]="
                             field.kind === 'date' ? 'date' :
                             (field.kind === 'datetime-local' ? 'datetime-local' :
                             (field.kind === 'time' ? 'time' :
                             (field.kind === 'number' ? 'number' : 'text')))
                           "
                           [(ngModel)]="formModel[field.name]"
                         />
                       </div>
                    </div>
                  </div>
                </div>
              </div>

              <div class="mt-2 d-flex gap-2">
                <button
                  class="btn btn-sm btn-primary"
                  (click)="submitFilters()"
                >
                  Submit Filters
                </button>
                <button
                  class="btn btn-sm btn-outline-secondary"
                  (click)="clearFilters()"
                >
                  Clear
                </button>
              </div>
            </div>
            <!-- End Filters UI -->

            <div *ngIf="keyValue" class="mt-2">
              <h6>Key/Value Result</h6>
              <pre>{{ keyValue | json }}</pre>
            </div>

            <div *ngIf="extracting" class="alert alert-warning mt-2">
              Fetching content from links...
            </div>
            <div
              *ngIf="extractedFromLinks?.length"
              class="table-responsive mt-2"
            >
              <table class="table table-sm table-bordered">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>URL</th>
                    <th>Status</th>
                    <th>Title</th>
                    <th>H1</th>
                    <th>Text Len</th>
                  </tr>
                </thead>
                <tbody>
                  <tr *ngFor="let item of extractedFromLinks; let i = index">
                    <td>{{ i + 1 }}</td>
                    <td class="text-truncate" style="max-width:320px">
                      <a [href]="item.url" target="_blank" rel="noopener">{{
                        item.url
                      }}</a>
                    </td>
                    <td>{{ item.status || (item.error ? 'ERR' : '') }}</td>
                    <td>{{ item.content?.title }}</td>
                    <td>{{ item.content?.pageHeading }}</td>
                    <td>{{ (item.content?.textContent || '').length }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  standalone: false,
})
export class ContentDetectorComponent {
  url = '';
  loading = false;
  result: any = null;
  extracting = false;
  extractedFromLinks: any[] = [];
  extractLimit = 10;
  extractDelay = 500;
  extractConcurrency = 3;
  keyValue: any = null;
  // Filters UI state
  filters: any = null;
  filtersLoading = false;
  filtersError = '';
  selectedAnchor: { [k: string]: string[] } = {};
  formModel: { [k: string]: any } = {};

  constructor(
    private api: ScrapeService,
    private store: ResultStoreService,
    public export1: ExportService,
  ) {}

  run() {
    if (!this.url) return;
    this.loading = true;
    this.result = null;
    this.api.detectContent(this.url).subscribe({
      next: (r) => {
        this.result = r;
        this.loading = false;
        this.store.set(r);
        this.keyValue = null;
        this.extractedFromLinks = [];
        this.filtersError = '';
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
      <h1>Content Detector</h1>
      <p><strong>URL:</strong> ${this.url}</p>
      <table><tbody>
        ${Object.keys(data)
          .map((k) => `<tr><th>${k}</th><td>${(data as any)[k]}</td></tr>`)
          .join('')}
      </tbody></table>`;
    this.export1.printHtml(html, 'Content Detector');
  }

  extractKV() {
    if (!this.url) return;
    this.keyValue = null;
    this.api.extractKeyValue(this.url).subscribe({
      next: (r) => {
        this.keyValue = r?.data || r;
      },
      error: (e) => {
        this.keyValue = { error: e?.error || e };
      },
    });
  }

  // -------- Filters handling --------
  fetchFilters() {
    if (!this.url) return;
    this.filters = null;
    this.filtersError = '';
    this.filtersLoading = true;
    this.api.detectFilters(this.url).subscribe({
      next: (r) => {
        this.filters = r?.data || r;
        this.filtersLoading = false;
        // initialize anchor selection buckets
        this.selectedAnchor = {};
        (this.filters?.anchorParams || []).forEach(
          (p: any) => (this.selectedAnchor[p.key] = []),
        );
      },
      error: (e) => {
        this.filtersLoading = false;
        this.filtersError =
          typeof e?.error === 'string'
            ? e.error
            : e?.error?.error || 'Failed to detect filters';
      },
    });
  }

  isAnchorSelected(key: string, value: string) {
    const arr = this.selectedAnchor?.[key] || [];
    return arr.includes(value);
  }

  onAnchorChange(key: string, value: string, target: any) {
    const current = this.selectedAnchor[key] || [];
    if (target.checked) {
      if (!current.includes(value))
        this.selectedAnchor[key] = [...current, value];
    } else {
      this.selectedAnchor[key] = current.filter((v: string) => v !== value);
    }
  }

  isFormOptionSelected(name: string, value: string) {
    const v = this.formModel?.[name];
    if (Array.isArray(v)) return v.includes(value);
    return false;
  }

  onFormOptionChange(
    name: string,
    value: string,
    isCheckbox: boolean,
    target: any,
  ) {
    if (isCheckbox) {
      const arr = Array.isArray(this.formModel[name])
        ? this.formModel[name]
        : [];
      if (target.checked) {
        if (!arr.includes(value)) this.formModel[name] = [...arr, value];
      } else {
        this.formModel[name] = arr.filter((v: string) => v !== value);
      }
    }
  }

  submitFilters() {
    const params: any = {};
    // anchor selections
    Object.keys(this.selectedAnchor || {}).forEach((k) => {
      const arr = (this.selectedAnchor[k] || []).filter((x) => !!x);
      if (arr.length) params[k] = arr;
    });
    // form values
    Object.keys(this.formModel || {}).forEach((k) => {
      const v = this.formModel[k];
      if (Array.isArray(v)) {
        if (v.length) params[k] = v;
      } else if (v !== undefined && v !== null && String(v).trim().length) {
        params[k] = v;
      }
    });
    if (!Object.keys(params).length) return;
    this.api.buildFilteredUrl(this.url, params).subscribe({
      next: (r) => {
        const finalUrl = r?.data?.finalUrl || r?.finalUrl || '';
        if (finalUrl) {
          this.url = finalUrl;
          this.run();
        }
      },
      error: () => {},
    });
  }

  clearFilters() {
    this.selectedAnchor = {};
    this.formModel = {};
    this.filtersError = '';
  }

  extractLinks() {
    const list: string[] = this.result?.data?.linksList || [];
    if (!list.length) return;
    this.extracting = true;
    this.extractedFromLinks = [];
    this.api
      .extractLinksContent(
        list,
        this.extractLimit,
        this.extractDelay,
        this.extractConcurrency,
      )
      .subscribe({
        next: (r) => {
          this.extractedFromLinks = r?.data || [];
          this.extracting = false;
        },
        error: (e) => {
          this.extractedFromLinks = [{ error: e?.error || e }];
          this.extracting = false;
        },
      });
  }
}

