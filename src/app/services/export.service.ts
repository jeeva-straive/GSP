import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ExportService {
  downloadJSON(data: any, filename = 'data.json') {
    const blob = new Blob([JSON.stringify(data ?? {}, null, 2)], {
      type: 'application/json',
    });
    this.downloadBlob(blob, filename);
  }

  downloadCSV(rows: any[], filename = 'data.csv') {
    const csv = this.toCSV(rows || []);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    this.downloadBlob(blob, filename);
  }

  downloadExcel(rows: any[], filename = 'data.xlsx') {
    const xml = this.toSpreadsheetML(rows || []);
    const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
    this.downloadBlob(blob, filename);
  }

  // Opens a print window from provided HTML; use browser "Save as PDF"
  printHtml(html: string, title = 'Document') {
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.open();
    win.document.write(`<!doctype html><html><head><title>${title}</title>
      <meta charset="utf-8" />
      <style>body{font-family: Arial, sans-serif; margin: 24px;} table{border-collapse:collapse;width:100%} th,td{border:1px solid #ccc;padding:8px;text-align:left}</style>
      </head><body>${html}</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => {
      try {
        win.print();
      } catch {}
    }, 300);
  }

  private downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  private toCSV(arr: any[]): string {
    if (!Array.isArray(arr) || arr.length === 0) return '';
    const headers = Array.from(
      arr.reduce((set, obj) => {
        Object.keys(obj || {}).forEach((k) => set.add(k));
        return set;
      }, new Set<string>()),
    );
    const esc = (v: any) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const lines = [headers.join(',')];
    for (const row of arr)
      lines.push(headers.map((h: any) => esc((row as any)[h])).join(','));
    return lines.join('\n');
  }

  // Minimal SpreadsheetML for Excel (single sheet)
  private toSpreadsheetML(arr: any[]): string {
    if (!Array.isArray(arr) || arr.length === 0) {
      return `<?xml version="1.0"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet">\n<Worksheet ss:Name="Sheet1" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Table/></Worksheet></Workbook>`;
    }
    const headers = Array.from(
      arr.reduce((set, obj) => {
        Object.keys(obj || {}).forEach((k) => set.add(k));
        return set;
      }, new Set<string>()),
    );
    const cell = (v: any) =>
      `<Cell><Data ss:Type="String">${this.xmlEscape(v)}</Data></Cell>`;
    const row = (cells: string[]) => `<Row>${cells.join('')}</Row>`;
    const headerRow = row(headers.map((h) => cell(h)));
    const dataRows = arr
      .map((r) => row(headers.map((h: any) => cell((r as any)[h] ?? ''))))
      .join('');
    return (
      `<?xml version="1.0"?>` +
      `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">` +
      `<Worksheet ss:Name="Sheet1"><Table>` +
      headerRow +
      dataRows +
      `</Table></Worksheet></Workbook>`
    );
  }

  private xmlEscape(v: any) {
    const s = String(v ?? '');
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
