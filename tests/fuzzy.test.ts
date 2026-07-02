import { describe, expect, test } from 'bun:test';
import { fuzzyRank } from '@/tools/fuzzy.ts';

interface Row {
  name: string;
  email?: string;
}

const rows: Row[] = [
  { name: 'general' },
  { name: 'gen-announcements' },
  { name: 'random' },
  { name: 'ada', email: 'ada@example.io' },
];

describe('fuzzyRank', () => {
  test('ranks the exact match first', () => {
    const ranked = fuzzyRank('general', rows, [{ name: 'name' }]);
    expect(ranked[0]?.name).toBe('general');
  });

  test('tolerates a small typo', () => {
    const ranked = fuzzyRank('genral', rows, [{ name: 'name' }]);
    expect(ranked.map((r) => r.name)).toContain('general');
    expect(ranked.map((r) => r.name)).not.toContain('random');
  });

  test('searches across multiple weighted keys', () => {
    const ranked = fuzzyRank('example', rows, [
      { name: 'name', weight: 2 },
      { name: 'email', weight: 1 },
    ]);
    expect(ranked[0]?.name).toBe('ada');
  });

  test('empty query or empty list yields nothing', () => {
    expect(fuzzyRank('', rows, [{ name: 'name' }])).toEqual([]);
    expect(fuzzyRank('general', [], [{ name: 'name' }])).toEqual([]);
  });
});
