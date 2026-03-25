import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ResultStoreService {
  private lastResult$ = new BehaviorSubject<any>(null);

  set(result: any) {
    this.lastResult$.next(result);
  }

  get$(): Observable<any> {
    return this.lastResult$.asObservable();
  }

  getSnapshot(): any {
    return this.lastResult$.getValue();
  }
}

