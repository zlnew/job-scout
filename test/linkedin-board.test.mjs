import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchJobDescription, resolveApplyTarget, searchJobs } from '../boards/linkedin.mjs';

const SEARCH_HTML = `
<div class="base-card" data-entity-urn="urn:li:jobPosting:111">
  <h3 class="base-search-card__title">Backend Engineer (Golang)</h3>
  <h4 class="base-search-card__subtitle"><a href="https://www.linkedin.com/company/acme">Acme</a></h4>
  <span class="job-search-card__location">Jakarta, Indonesia</span>
  <time datetime="2026-11-01"></time>
</div>
<div class="base-card" data-entity-urn="urn:li:jobPosting:111">
  <h3 class="base-search-card__title">Backend Engineer (Golang) duplicate</h3>
  <h4 class="base-search-card__subtitle"><a href="https://www.linkedin.com/company/acme">Acme</a></h4>
  <span class="job-search-card__location">Jakarta, Indonesia</span>
  <time datetime="2026-11-02"></time>
</div>
<div class="base-card" data-entity-urn="urn:li:jobPosting:222">
  <h3 class="base-search-card__title">Platform Engineer</h3>
  <h4 class="base-search-card__subtitle"><a href="https://www.linkedin.com/company/beta">Beta</a></h4>
  <span class="job-search-card__location">Bandung, Indonesia</span>
  <time datetime="2026-10-20"></time>
</div>
<div class="base-card" data-entity-urn="urn:li:jobPosting:333">
  <h3 class="base-search-card__title">DevOps Engineer</h3>
  <h4 class="base-search-card__subtitle"><a href="https://www.linkedin.com/company/gamma">Gamma</a></h4>
  <span class="job-search-card__location">Remote</span>
  <time datetime="2026-10-10"></time>
</div>
`;

test('searchJobs parses cards, filters denied titles, and dedupes by id', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, text: async () => SEARCH_HTML };
  };

  const candidates = await searchJobs({
    queries: ['backend engineer golang'],
    location: 'Jakarta',
    pages: 1,
    fetchImpl,
    delayMs: 0,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0], /keywords=backend%20engineer%20golang/);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.id), ['111', '222']);
  assert.deepEqual(candidates[0], {
    id: '111',
    title: 'Backend Engineer (Golang)',
    company: 'Acme',
    location: 'Jakarta, Indonesia',
    posted: '2026-11-01',
    url: 'https://www.linkedin.com/jobs/view/111',
    query: 'backend engineer golang',
  });
  assert.equal(candidates[1].title, 'Platform Engineer');
});

test('searchJobs skips a failing query instead of failing the sweep', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => '' });
  const original = console.error;
  const seen = [];
  console.error = (line) => seen.push(line);
  try {
    const candidates = await searchJobs({ queries: ['one'], fetchImpl, delayMs: 0 });
    assert.deepEqual(candidates, []);
    assert.match(seen[0], /skip one p0: 429/);
  } finally {
    console.error = original;
  }
});

test('fetchJobDescription strips tags and decodes entities', async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => `
      <div class="show-more-less-html__markup show-more-less-html__markup--clamp-after-5">
        <p>Build &amp; ship APIs</p>
        <ul><li>C++ &lt;systems&gt; &#39;quotes&#39; &quot;double&quot;&nbsp;end</li></ul>
      </div>`,
  });

  const description = await fetchJobDescription('111', { fetchImpl });
  assert.equal(description, "Build & ship APIs C++ <systems> 'quotes' \"double\" end");
});

test('resolveApplyTarget returns Easy Apply without clicking', async () => {
  const page = {
    goto: async () => {},
    waitForSelector: async () => {},
    url: () => 'https://www.linkedin.com/jobs/view/111',
    $$eval: async () => [{ tag: 'button', href: '', text: 'Easy Apply' }],
    locator: () => {
      throw new Error('the apply control must not be clicked');
    },
  };

  const result = await resolveApplyTarget({ id: '111', page });
  assert.equal(result.kind, 'easy-apply');
  assert.equal(result.applyUrl, null);
  assert.equal(result.id, '111');
});
