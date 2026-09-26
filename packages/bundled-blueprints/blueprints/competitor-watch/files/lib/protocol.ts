export type Competitor = { id: string; name: string; url: string; notes: string; lastChecked: string | null;
  lastFingerprint?: string; lastFindingId?: string };
export type Finding = { id: string; competitorId: string; observedAt: string; sourceUrl: string; summary: string; content: string; fingerprint: string };
export type WatchSnapshot = { revision: number; competitors: Competitor[]; findings: Finding[] };
export interface WatchStub {
  getWatchlist(): Promise<WatchSnapshot>;
  addCompetitor(input: { name: string; url: string; notes?: string }): Promise<Competitor>;
  removeCompetitor(id: string): Promise<void>;
  recordSnapshot(input: { competitorId: string; sourceUrl: string; content: string; summary: string }): Promise<{ changed: boolean; findingId: string }>;
}
