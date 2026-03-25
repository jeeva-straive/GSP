import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NgZone } from '@angular/core';

interface ExtractStateSnapshot {
  columns: string[];
  rows: Array<Record<string, string>>;
  statusText: string;
  nextPageSelector: string;
  maxPages: number;
  rowCount: number;
  isPaginating: boolean;
  timestamp?: number;
  frameGuid?: string | null;
  columnMap?: Record<string, string>;
  columnBindings?: Record<
    string,
    {
      label: string;
      listSelector?: string;
      detailSelector?: string;
      createdAt?: number;
    }
  >;
  labelSuggestions?: Record<string, string>;
  detailSelectors?: Record<string, string>;
  customFields?: string[];
  baseAnchorSelector?: string | null;
  baseAnchorHref?: string | null;
  baseItemSelector?: string | null;
  baseItemSignature?: {
    tag: string;
    classes?: string[];
    role?: string | null;
  } | null;
  loadMoreMode?: boolean;
  siblingsHrefs?: string[];
  panelCollapsed?: boolean;
  panelPos?: { left: number; top: number } | null;
}

interface ExtractStateEvent {
  sessionId: string;
  state?: ExtractStateSnapshot | null;
}

type ElectronExtractAction =
  | 'extract-all'
  | 'extract-details'
  | 'extract-pages'
  | 'clear'
  | 'clear-all'
  | 'save-next-selector'
  | 'save-max-pages'
  | 'save-load-more'
  | 'stop-pagination';

type ElectronAPIShape = {
  onExtractStateUpdate?: (
    cb: (payload: ExtractStateEvent) => void,
  ) => (() => void) | void;
  triggerExtractAction?: (
    sessionId: string,
    action: ElectronExtractAction,
    payload?: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: string } | void>;
  getExtractState?: (
    sessionId: string,
  ) => Promise<ExtractStateSnapshot | null | undefined>;
};

declare global {
  interface Window {
    electronAPI?: ElectronAPIShape;
  }
}

@Component({
  selector: 'app-parent-tree',
  template: `
    <div class="inspector-panel">
      <div class="inspector-controls">
        <button
          class="primary"
          (click)="startInspector()"
          [disabled]="isStartingInspector"
        >
          {{ sessionId ? 'Restart Inspector' : 'Start Inspector' }}
        </button>
        <input type="text" [(ngModel)]="targetUrl" placeholder="Target URL" />
        <span class="session-chip" *ngIf="sessionId">
          Session: {{ sessionId }}
        </span>
      </div>

      <section class="render-table-card">
        <header>
          <div>
            <h3>Extracted Table</h3>
            <small>
              {{ extractState.statusText || 'Idle' }} • Rows:
              {{ extractState.rowCount }}
            </small>
          </div>
          <div class="header-actions">
            <button
              (click)="clearTable()"
              [disabled]="!sessionId || !extractState.rowCount"
            >
              Clear
            </button>
            <button (click)="resetAll()" class="danger" [disabled]="!sessionId">
              Clear All
            </button>
          </div>
        </header>

        <div class="action-error" *ngIf="actionError">
          {{ actionError }}
        </div>

        <div class="action-row">
          <button
            (click)="runAction('extract-all')"
            class="success"
            [disabled]="!sessionId"
          >
            Extract All
          </button>
          <button
            (click)="extractDetails()"
            class="accent"
            [disabled]="!sessionId"
          >
            Extract Details
          </button>
          <button
            (click)="extractPages()"
            class="success"
            [disabled]="!sessionId"
          >
            Extract + Pages
          </button>
          <button (click)="exportCsv()" [disabled]="!extractState.rows.length">
            Export CSV
          </button>
          <button
            (click)="runAction('stop-pagination')"
            [disabled]="!sessionId || !extractState.isPaginating"
          >
            Stop Paging
          </button>
          <button (click)="listUrls()" [disabled]="urlListLoading || !targetUrl">
            listURL
          </button>
        </div>

        <div class="pagination-row">
          <label>
            Next selector
            <input
              type="text"
              [(ngModel)]="localNextSelector"
              placeholder="CSS selector"
            />
          </label>
          <button (click)="saveNextSelector()" [disabled]="!sessionId">
            Save
          </button>
          <label>
            Max pages
            <input type="number" min="1" [(ngModel)]="localMaxPages" />
          </label>
          <button (click)="saveMaxPages()" [disabled]="!sessionId">Save</button>
          <label class="loadmore-toggle">
            <input
              type="checkbox"
              [(ngModel)]="loadMoreMode"
              (change)="saveLoadMoreMode()"
            />
            Load more
          </label>
        </div>

        <div
          class="table-wrapper"
          *ngIf="extractState.columns.length; else emptyState"
        >
          <table>
            <thead>
              <tr>
                <th *ngFor="let col of extractState.columns">{{ col }}</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let row of extractState.rows; let rowIndex = index">
                <td *ngFor="let col of extractState.columns">
                  {{ row[col] || '' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <ng-template #emptyState>
          <div class="empty">
            No rows yet. Use the actions above to extract.
          </div>
        </ng-template>

        <div class="url-list-panel" *ngIf="urlListVisible">
          <div class="url-list-header">
            <h4>Collected URLs ({{ urlList.length }})</h4>
            <button type="button" (click)="urlListVisible = false">Close</button>
          </div>
          <div
            class="alert alert-info"
            *ngIf="urlListLoading"
            style="margin-bottom: 8px"
          >
            Collecting links from the page...
          </div>
          <div
            class="action-error"
            *ngIf="!urlListLoading && urlListError"
            style="margin-bottom: 8px"
          >
            {{ urlListError }}
          </div>
          <div
            class="url-list-body"
            *ngIf="!urlListLoading && !urlListError && urlList.length"
          >
            <ol>
              <li *ngFor="let link of urlList">
                <a [href]="link" target="_blank" rel="noreferrer">{{ link }}</a>
              </li>
            </ol>
          </div>
          <div
            class="empty"
            *ngIf="!urlListLoading && !urlListError && !urlList.length"
          >
            No links detected yet.
          </div>
        </div>
      </section>
    </div>
  `,
  styles: [
    `
      .inspector-panel {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .inspector-controls {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .inspector-controls input {
        flex: 1 1 auto;
        padding: 6px 10px;
      }
      button {
        border: none;
        border-radius: 4px;
        padding: 6px 10px;
        cursor: pointer;
        background: #555;
        color: #fff;
      }
      button.primary {
        background: #2d8cf0;
      }
      button.success {
        background: #3cb371;
      }
      button.accent {
        background: #e6a23c;
      }
      button.danger {
        background: #b85c00;
      }
      button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .session-chip {
        font-size: 12px;
        background: #eee;
        color: #333;
        padding: 4px 8px;
        border-radius: 12px;
      }
      .render-table-card {
        border: 1px solid #ddd;
        border-radius: 8px;
        padding: 16px;
        background: #fff;
      }
      .render-table-card header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }
      .header-actions {
        display: flex;
        gap: 8px;
      }
      .action-error {
        background: #fff3cd;
        color: #856404;
        border: 1px solid #ffeeba;
        padding: 8px 10px;
        border-radius: 6px;
        margin-bottom: 12px;
        font-size: 13px;
      }
      .action-row,
      .pagination-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 12px;
      }
      .pagination-row label {
        display: flex;
        flex-direction: column;
        font-size: 12px;
        color: #555;
      }
      .pagination-row input {
        padding: 4px 8px;
        min-width: 160px;
      }
      .loadmore-toggle {
        flex-direction: row;
        align-items: center;
        font-weight: 500;
        margin-top: 2%;
      }
      .loadmore-toggle input {
        min-width: auto;
        margin-right: 4px;
      }
      .table-wrapper {
        overflow: auto;
        max-height: 420px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        text-align: left;
        border-bottom: 1px solid #eee;
        padding: 6px;
        word-break: break-word;
      }
      .url-list-panel {
        margin-top: 16px;
        padding: 12px;
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        background: #fafafa;
      }
      .url-list-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }
      .url-list-header h4 {
        margin: 0;
        font-size: 16px;
      }
      .url-list-body {
        max-height: 200px;
        overflow-y: auto;
      }
      .url-list-body ol {
        margin: 0;
        padding-left: 20px;
      }
      .url-list-body li + li {
        margin-top: 4px;
      }
      .empty {
        text-align: center;
        padding: 24px;
        color: #888;
      }
    `,
  ],
})
export class ScraperComponent implements OnInit, OnDestroy {
  targetUrl = 'https://www.scheppfamily.com/obituaries/obituary-listings';
  sessionId: string | null = null;
  isStartingInspector = false;
  extractState: ExtractStateSnapshot = {
    columns: [],
    rows: [],
    statusText: 'Idle',
    nextPageSelector: '',
    maxPages: 5,
    rowCount: 0,
    isPaginating: false,
    columnMap: {},
    columnBindings: {},
    labelSuggestions: {},
    detailSelectors: {},
    customFields: [],
    baseAnchorSelector: null,
    baseAnchorHref: null,
    baseItemSelector: null,
    baseItemSignature: null,
    loadMoreMode: false,
    siblingsHrefs: [],
    panelCollapsed: false,
    panelPos: null,
  };
  localNextSelector = '';
  localMaxPages: number | null = null;
  loadMoreMode = false;
  actionError: string | null = null;
  urlListVisible = false;
  urlList: string[] = [];
  urlListLoading = false;
  urlListError: string | null = null;
  private cleanupFns: Array<() => void> = [];

  constructor(
    private http: HttpClient,
    private ngZone: NgZone,
  ) {}

  ngOnInit(): void {
    this.registerExtractStateListener();
  }

  ngOnDestroy(): void {
    this.cleanupFns.forEach((fn) => {
      try {
        fn();
      } catch {}
    });
  }

  private get electronApi(): ElectronAPIShape | undefined {
    return window.electronAPI;
  }

  private registerExtractStateListener(): void {
    const api = this.electronApi;
    if (!api?.onExtractStateUpdate) {
      return;
    }
    const dispose = api.onExtractStateUpdate((payload) => {
      if (!payload || !payload.state) return;
      if (!this.sessionId || payload.sessionId !== this.sessionId) return;
      this.ngZone.run(() => {
        this.applyExtractState(payload.state || undefined);
      });
    });
    if (typeof dispose === 'function') {
      this.cleanupFns.push(dispose);
    }
  }

  private applyExtractState(snapshot?: Partial<ExtractStateSnapshot> | null) {
    if (!snapshot) return;
    const columns = Array.isArray(snapshot.columns)
      ? [...snapshot.columns]
      : [...this.extractState.columns];
    const rows = Array.isArray(snapshot.rows)
      ? [...snapshot.rows]
      : [...this.extractState.rows];
    const nextPageSelector =
      typeof snapshot.nextPageSelector === 'string'
        ? snapshot.nextPageSelector
        : this.extractState.nextPageSelector;
    const maxPages =
      typeof snapshot.maxPages === 'number'
        ? snapshot.maxPages
        : this.extractState.maxPages;
    const rowCount =
      typeof snapshot.rowCount === 'number' ? snapshot.rowCount : rows.length;
    const loadMoreMode =
      typeof snapshot.loadMoreMode === 'boolean'
        ? snapshot.loadMoreMode
        : this.loadMoreMode;
    this.extractState = {
      ...this.extractState,
      ...snapshot,
      columns,
      rows,
      nextPageSelector,
      maxPages,
      rowCount,
      loadMoreMode,
      isPaginating:
        typeof snapshot.isPaginating === 'boolean'
          ? snapshot.isPaginating
          : this.extractState.isPaginating,
      statusText: snapshot.statusText ?? this.extractState.statusText,
    };
    this.localNextSelector = nextPageSelector || '';
    this.localMaxPages = maxPages || 1;
    this.loadMoreMode = !!loadMoreMode;
    console.log('Updated extract state', this.extractState);
  }

  private async refreshExtractState() {
    if (!this.sessionId || !this.electronApi?.getExtractState) return;
    try {
      const snapshot = await this.electronApi.getExtractState(this.sessionId);
      console.log('Fetched extract state', snapshot);
      this.ngZone.run(() => this.applyExtractState(snapshot || undefined));
    } catch (err) {
      console.error('Failed to fetch extract state', err);
    }
  }

  async runAction(
    action: ElectronExtractAction,
    payload?: Record<string, unknown>,
  ) {
    if (!this.sessionId || !this.electronApi?.triggerExtractAction) return;
    try {
      this.actionError = null;
      const result = await this.electronApi.triggerExtractAction(
        this.sessionId,
        action,
        payload || {},
      );
      if (
        result &&
        typeof result === 'object' &&
        'success' in result &&
        (result as any).success === false
      ) {
        const errMsg =
          (result as { success: boolean; error?: string }).error ||
          'Inspector action failed';
        throw new Error(errMsg);
      }
      await this.refreshExtractState();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Action ${action} failed`;
      console.error(`Action ${action} failed`, err);
      this.actionError = message;
    }
  }

  async startInspector() {
    if (!this.targetUrl) return;
    this.isStartingInspector = true;
    this.http
      .get<{
        success: boolean;
        sessionId: string;
      }>('http://localhost:3000/hover-link-inspector', {
        params: { url: this.targetUrl },
      })
      .subscribe({
        next: async (resp) => {
          this.sessionId = resp.sessionId;
          this.actionError = null;
          await this.refreshExtractState();
          this.isStartingInspector = false;
        },
        error: (err) => {
          console.error('Failed to start inspector', err);
          this.actionError =
            'Unable to start inspector. Check the console for details.';
          this.isStartingInspector = false;
        },
      });
  }

  extractPages() {
    const maxPagesValue = Math.max(1, Number(this.localMaxPages) || 1);
    this.localMaxPages = maxPagesValue;
    this.runAction('extract-pages', {
      maxPages: maxPagesValue,
      nextSelector: this.localNextSelector || '',
      loadMoreMode: this.loadMoreMode,
    });
  }

  extractDetails() {
    const maxPagesValue = Math.max(1, Number(this.localMaxPages) || 1);
    this.localMaxPages = maxPagesValue;
    this.runAction('extract-details', {
      maxPages: maxPagesValue,
      nextSelector: this.localNextSelector || '',
      loadMoreMode: this.loadMoreMode,
    });
  }

  clearTable() {
    this.runAction('clear');
  }

  resetAll() {
    this.runAction('clear-all');
  }

  saveNextSelector() {
    this.runAction('save-next-selector', {
      nextSelector: this.localNextSelector || '',
    });
  }

  saveMaxPages() {
    const value = Math.max(1, Number(this.localMaxPages) || 1);
    this.localMaxPages = value;
    this.runAction('save-max-pages', { maxPages: value });
  }

  saveLoadMoreMode() {
    this.extractState.loadMoreMode = !!this.loadMoreMode;
    this.runAction('save-load-more', { enabled: this.loadMoreMode });
  }

  listUrls() {
    if (!this.targetUrl) {
      this.urlListVisible = true;
      this.urlList = [];
      this.urlListError = 'Enter a target URL before listing links.';
      return;
    }
    this.urlListVisible = true;
    this.urlListLoading = true;
    this.urlListError = null;
    this.urlList = [];
    this.http
      .get<{
        success: boolean;
        links?: string[];
        error?: string;
      }>('http://localhost:3000/list-urls', {
        params: { url: this.targetUrl },
      })
      .subscribe({
        next: (resp) => {
          this.urlListLoading = false;
          if (!resp.success) {
            this.urlListError =
              resp.error || 'Unable to extract links for this page.';
            this.urlList = [];
            return;
          }
          this.urlList = resp.links || [];
        },
        error: (err) => {
          this.urlListLoading = false;
          this.urlList = [];
          this.urlListError =
            err?.message || 'Unexpected error while extracting links.';
        },
      });
  }

  exportCsv() {
    if (!this.extractState.columns.length || !this.extractState.rows.length) {
      return;
    }
    const esc = (value: string) => `"${(value || '').replace(/"/g, '""')}"`;
    const header = this.extractState.columns.map(esc).join(',');
    const body = this.extractState.rows
      .map((row) =>
        this.extractState.columns.map((col) => esc(row[col] || '')).join(','),
      )
      .join('\n');
    const csv = `${header}\n${body}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `extract-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

}
