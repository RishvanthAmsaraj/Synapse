// Regression tests for the image-query normalization + search ladder.
//
// The "different picture won't load" bug: conversational qualifiers
// ("different", "another", "some other") survived into the search query, so
// Wikipedia/Commons returned no result and the canvas showed "No image found".
//
// Run:  node --import tsx --test src/images.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanQuery, buildQueryLadder, fetchWikipediaImage } from './images.js';

// ---------------------------------------------------------------------------
// cleanQuery — pure normalization (deterministic, no network)
// ---------------------------------------------------------------------------

test('cleanQuery strips conversational qualifiers (the bug)', () => {
  assert.equal(cleanQuery('different blue whale'), 'blue whale');
  assert.equal(cleanQuery('another blue whale'), 'blue whale');
  assert.equal(cleanQuery('a different picture of a blue whale'), 'blue whale');
  assert.equal(cleanQuery('some other whale'), 'whale');
});

test('cleanQuery strips media nouns and determiners', () => {
  assert.equal(cleanQuery('a picture of a lion'), 'lion');
  assert.equal(cleanQuery('diagram of a binary search tree'), 'binary search tree');
  assert.equal(cleanQuery('show me a visualization of the water cycle'), 'water cycle');
});

test('cleanQuery leaves real titles intact (word-boundary aware)', () => {
  assert.equal(cleanQuery('Finding Nemo'), 'Finding Nemo');
  assert.equal(cleanQuery('New York'), 'New York');
  assert.equal(cleanQuery('blue whale'), 'blue whale');
});

test('cleanQuery never returns empty for a pure-filler query', () => {
  // Falls back to the original string rather than "".
  assert.equal(cleanQuery('a'), 'a');
  assert.equal(cleanQuery('you'), 'you');
});

// ---------------------------------------------------------------------------
// buildQueryLadder — degradation order (deterministic, no network)
// ---------------------------------------------------------------------------

test('ladder strips leading qualifiers only after the full query', () => {
  // "new" is NOT in cleanQuery (protects "New York"), so the cleaned first
  // rung is "new dog"; the ladder then strips leading "new" to reach "dog".
  const ladder = buildQueryLadder('a new picture of a dog');
  assert.equal(ladder[0], 'new dog');
  assert.ok(ladder.includes('dog'));
});

test('ladder always offers progressively simpler rungs', () => {
  const ladder = buildQueryLadder('crimson macaw in flight');
  assert.equal(ladder[0], 'crimson macaw in flight'); // full cleaned query first
  assert.ok(ladder.length >= 2, 'ladder should degrade, not stay at one rung');
  assert.ok(ladder.includes('flight'));               // ends at a single word
});

// ---------------------------------------------------------------------------
// fetchWikipediaImage — integration (network; validates the actual fix)
// ---------------------------------------------------------------------------

test('fetch resolves a normal query', async () => {
  const url = await fetchWikipediaImage('blue whale');
  assert.ok(url, 'expected a URL for "blue whale"');
  assert.match(url!, /^https?:\/\//);
});

test('fetch resolves a "different X" query (THE regression)', async () => {
  const url = await fetchWikipediaImage('different blue whale');
  assert.ok(url, 'expected "different blue whale" to resolve via the ladder');
});

test('fetch resolves an "another X" query', async () => {
  const url = await fetchWikipediaImage('another golden gate bridge');
  assert.ok(url, 'expected "another golden gate bridge" to resolve');
});
