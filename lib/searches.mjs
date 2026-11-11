// Default fungsi.id searches, shared by the scan stage and the dashboard so
// "Scan now" uses exactly the same set the CLI does.
export const DEFAULT_SEARCHES = [
  { query: 'backend', city: 'jakarta' },
  { query: 'back end', city: 'jakarta' },
  { query: 'full stack', city: 'jakarta' },
  { query: 'software engineer', city: 'jakarta' },
  { query: 'backend', remote: true },
  { query: 'engineer', city: 'bekasi' },
];
