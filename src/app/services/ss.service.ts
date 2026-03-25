import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

import { BehaviorSubject, firstValueFrom } from 'rxjs';

export interface ScrapeNode {
  url: string;
  title?: string;
  depth: number;
  parent?: string;
  children: ScrapeNode[];
  status?: 'pending' | 'processing' | 'done' | 'failed';
}

@Injectable({ providedIn: 'root' })
export class ScraperService {
  private visited = new Set<string>();
  private maxDepth = 2;
  progress$ = new BehaviorSubject<number>(0);

  constructor(private http: HttpClient) {}

  async scrapeTree(rootUrl: string): Promise<ScrapeNode> {
    const rootNode: ScrapeNode = {
      url: rootUrl,
      depth: 0,
      children: [],
      status: 'processing',
    };

    const queue: ScrapeNode[] = [rootNode];
    this.visited.add(rootUrl);
    let processed = 0;
    let total = queue.length;
    while (queue.length > 0) {
      const currentNode = queue.shift()!;
      currentNode.status = 'processing';

      processed++;
      this.progress$.next(
        Math.round((processed / (processed + queue.length)) * 100),
      );

      try {
        const html = await this.fetchHtml(currentNode.url);
        const links = this.extractLinks(html, currentNode.url);

        for (let link of links) {
          if (!this.visited.has(link) && currentNode.depth < this.maxDepth) {
            this.visited.add(link);

            const childNode: ScrapeNode = {
              url: link,
              depth: currentNode.depth + 1,
              parent: currentNode.url,
              children: [],
              status: 'pending',
            };

            currentNode.children.push(childNode);
            queue.push(childNode);
          }
        }

        currentNode.status = 'done';
      } catch (err) {
        currentNode.status = 'failed';
      }
    }

    return rootNode;
  }

  private fetchHtml(url: string): Promise<string> {
    return firstValueFrom(this.http.get(url, { responseType: 'text' }));
  }

  private extractLinks(html: string, baseUrl: string): string[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const anchors = Array.from(doc.querySelectorAll('a'));

    return anchors
      .map((a) => a.getAttribute('href'))
      .filter((href) => !!href)
      .map((href) => new URL(href!, baseUrl).href)
      .filter((url) => !url.includes('#'));
  }
}
