/**
 * Pure view-model builders (S1, S2, S3).
 *
 * Handlers hand these functions raw ledger records, events and profile data and
 * get back exactly the shape a screen renders. Keeping the derivation here
 * means the same numbers and labels are tested without a browser, and the page
 * never has to interpret a raw record or a raw event line.
 */
import { CODES } from '../core/result.mjs';

export const FOLLOW_UP_DAYS = 7;

const TODAY = () => new Date().toISOString().slice(0, 10);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const valueOf = (node) => (isObject(node) && Object.hasOwn(node, 'value') ? node.value : node);
const keyOf = (record) => record?.identityKey ?? null;
const label = (record) => [record?.company, record?.role].filter(Boolean).join(' - ') || 'this application';

/** Per-record gap count; the global gap list is only a fallback for old rows. */
const gapCountFor = (record, gaps) => (Array.isArray(record?.blocked) ? record.blocked.length : gaps.length);

/** The identifier the CLI job routes accept: identity key, board id, or the URL. */
export function identifier(record) {
  if (record?.identityKey) return String(record.identityKey);
  if (record?.linkedinId !== undefined && record.linkedinId !== null) return String(record.linkedinId);
  const url = String(record?.url ?? '');
  const boardId = url.match(/\/jobs\/view\/([A-Za-z0-9_-]+)/) ?? url.match(/\/jobs?\/([A-Za-z0-9_-]+)/);
  return boardId ? boardId[1] : url;
}

/** Source names are stored as display labels in older rows; normalise for filters. */
export function sourceOf(record) {
  const raw = record?.source ?? record?.channel ?? '';
  return String(raw).trim().toLowerCase() || 'unknown';
}

// ---- score arithmetic -----------------------------------------------------

const asPoint = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = value.match(/[+-]?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }
  return null;
};

function chipFrom(entry, source) {
  if (typeof entry === 'number') return { label: source === 'penalty' ? 'penalty' : 'rubric', points: entry, source };
  if (typeof entry === 'string') {
    const points = asPoint(entry);
    const text = points === null ? entry : entry.replace(/[+-]?\d+(?:\.\d+)?/, '').replace(/[()]/g, '').trim();
    return points === null ? null : { label: text || source, points, source };
  }
  if (!isObject(entry)) return null;
  const points = asPoint(entry.points ?? entry.delta ?? entry.weight ?? entry.score);
  if (points === null) return null;
  return {
    label: String(entry.label ?? entry.reason ?? entry.key ?? source),
    points,
    source,
  };
}

/** Stored rubrics win: `scoreReasons`, `reasons` and `penalties` keep their labels. */
function storedChips(record) {
  const chips = [];
  for (const [field, source] of [
    ['scoreReasons', 'stored'],
    ['breakdown', 'stored'],
    ['reasons', 'stored'],
    ['penalties', 'penalty'],
  ]) {
    if (!Array.isArray(record?.[field])) continue;
    for (const entry of record[field]) {
      const chip = chipFrom(entry, source);
      if (chip) chips.push(chip);
    }
  }
  return chips;
}

// Older rows record their arithmetic only inside the notes, as `IT vendor (-1)`.
const NOTE_POINT = /([A-Za-z][A-Za-z0-9 .,/+&-]*?)\s*\(([+-]\d+(?:\.\d+)?)\)/g;

function noteChips(record) {
  const notes = typeof record?.notes === 'string' ? record.notes : '';
  const chips = [];
  for (const match of notes.matchAll(NOTE_POINT)) {
    const text = match[1].trim().replace(/^[,;.\s]+/, '');
    if (!text) continue;
    chips.push({ label: text, points: Number(match[2]), source: 'notes' });
  }
  return chips;
}

/**
 * The score is a recorded human judgement, not a computed total. When the
 * record carries a breakdown we show it; otherwise we recover what the notes
 * state and name the remainder `other` instead of pretending it was computed.
 */
export function scoreBreakdown(record) {
  const score = typeof record?.score === 'number' ? record.score : null;
  let chips = storedChips(record);
  if (chips.length === 0) chips = noteChips(record);

  const listed = chips.reduce((sum, chip) => sum + chip.points, 0);
  if (score !== null && chips.length === 0) {
    chips = [{ label: 'recorded score', points: score, source: 'recorded' }];
  } else if (score !== null && listed !== score) {
    chips = [...chips, { label: 'other recorded points', points: score - listed, source: 'recorded' }];
  }

  const total = chips.reduce((sum, chip) => sum + chip.points, 0);
  return {
    score,
    chips,
    listed,
    total,
    equals: score === null ? false : total === score,
  };
}

// ---- follow-ups -----------------------------------------------------------

/** The board's existing rule: a submitted record is due seven days after it was sent. */
export function followUpDate(record) {
  if (record?.follow_up) return String(record.follow_up);
  if (!record?.applied) return null;
  const date = new Date(`${record.applied}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + FOLLOW_UP_DAYS);
  return date.toISOString().slice(0, 10);
}

export function isFollowUpDue(record, today = TODAY()) {
  if (record?.status !== 'submitted') return false;
  const due = followUpDate(record);
  return due !== null && due <= String(today);
}

// ---- one primary action per row ------------------------------------------

function jobAction(record, actionLabel, path, body) {
  const gapCount = Number(record?.gapCount) || 0;
  return {
    label: actionLabel,
    kind: 'job',
    path,
    body,
    ...(gapCount > 0 ? { gapCount } : {}),
  };
}

/**
 * The action a row offers is derived only from its ledger state, so the same
 * record never shows two competing calls to action.
 */
export function primaryAction(record, { gapCount = 0, today = TODAY() } = {}) {
  const id = identifier(record);
  const key = encodeURIComponent(identifier(record));
  switch (record?.status) {
    case 'blocked':
      if (gapCount > 0) {
        return {
          label: `Answer ${gapCount} question${gapCount === 1 ? '' : 's'}`,
          kind: 'navigate',
          href: '#/connections',
        };
      }
      return { label: 'Re-run prepare', kind: 'job', path: '/api/prepare', body: { id } };
    case 'prepared':
      return {
        label: 'Submit',
        kind: 'submit',
        path: '/api/apply',
        body: { id, dryRun: false },
      };
    case 'submitted':
      return isFollowUpDue(record, today)
        ? { label: 'Follow up', kind: 'navigate', href: key ? `#/application/${key}` : '#/postings' }
        : { label: 'Open application', kind: 'navigate', href: key ? `#/application/${key}` : '#/postings' };
    case 'interview':
    case 'rejected':
    case 'offer':
    case 'skipped':
      return { label: 'Open application', kind: 'navigate', href: key ? `#/application/${key}` : '#/postings' };
    default:
      return jobAction(record, 'Prepare', '/api/prepare', { id });
  }
}

// ---- timeline and events -------------------------------------------------

function eventText(event) {
  switch (event?.action) {
    case 'prepared':
      return 'Application prepared, ready for a human review';
    case 'blocked':
      return 'Preparation blocked; a question still needs an answer';
    case 'applied':
      return 'Application submitted';
    case 'status':
      return `Status moved to ${event.status ?? 'a new state'}`;
    case 'letter':
      return `Letter revision ${event.revision ?? ''} ${event.origin ?? 'stored'}`.trim();
    case 'login':
      return 'Session refreshed';
    default:
      return String(event?.action ?? 'activity').replaceAll('-', ' ');
  }
}

const eventOk = (event) =>
  !['blocked', 'failed', 'refused', 'error'].includes(String(event?.action ?? '')) && event?.ok !== false;

const eventFix = (event) => {
  if (event?.fix) return event.fix;
  if (event?.action === 'blocked') return CODES['blocked-question'].fix;
  if (event?.action === 'failed' || event?.action === 'refused' || event?.action === 'error') {
    return 'open the application to retry from its current state';
  }
  return null;
};

/** Timeline for one identity, oldest first, so the newest step is last. */
export function timelineFor(events = [], key) {
  return events
    .filter((event) => event?.key === key)
    .map((event) => ({
      ts: event.ts ?? null,
      action: event.action ?? 'activity',
      text: eventText(event),
      outcome: eventOk(event) ? 'ok' : 'attention',
      detail: event.blockedReason ?? null,
      evidence: {
        url: event.url ?? null,
        screenshot: event.screenshot ?? null,
        letterRevision: event.letterRevision ?? null,
      },
    }));
}

function recentFrom(events, records) {
  const byKey = new Map(records.map((record) => [keyOf(record), record]));
  return [...events]
    .reverse()
    .slice(0, 8)
    .map((event) => {
      const record = byKey.get(event.key);
      return {
        ts: event.ts ?? null,
        text: `${label(record)}: ${eventText(event)}`,
        outcome: eventOk(event) ? 'ok' : 'attention',
        fix: eventOk(event) ? null : eventFix(event),
        href: event.key ? `#/application/${event.key}` : '#/today',
      };
    });
}

// ---- answers and provenance ---------------------------------------------

function* answerLeaves(node, path = '') {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) yield* answerLeaves(node[i], `${path}[${i}]`);
    return;
  }
  if (!isObject(node)) return;
  if (Object.hasOwn(node, 'value')) {
    yield { key: path || 'profile', value: node.value, source: node.source, scope: node.scope };
    return;
  }
  for (const [part, child] of Object.entries(node)) {
    yield* answerLeaves(child, path ? `${path}.${part}` : part);
  }
}

const shortLabel = (key) => {
  const tail = String(key).split('.').at(-1).replaceAll(/\[\d+\]/g, '');
  return tail
    .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll(/[-_]/g, ' ')
    .replace(/^\w/, (letter) => letter.toUpperCase());
};

/**
 * Every usable answer with where it came from. The profile records provenance
 * per leaf and one generation date, which is the date a confirmed answer was
 * last checked against answers.md.
 */
export function answersWithProvenance(profile) {
  const date = profile?.meta?.generatedAt ?? null;
  const answers = [];
  for (const leaf of answerLeaves(profile)) {
    if (leaf.key === 'meta' || !['confirmed', 'derived'].includes(leaf.source)) continue;
    answers.push({
      key: leaf.key,
      label: shortLabel(leaf.key),
      value: leaf.value,
      scope: leaf.scope ?? null,
      provenance: {
        kind: leaf.source,
        text:
          leaf.source === 'confirmed'
            ? `confirmed by Maul${date ? ` on ${date}` : ''}`
            : 'derived from career.json',
        date: leaf.source === 'confirmed' ? date : null,
      },
    });
  }
  return answers;
}

// ---- screens -------------------------------------------------------------

export function todayView({ records = [], events = [], sessions = [], gaps = [], today = TODAY() } = {}) {
  const latest = new Map();
  for (const event of events) if (event?.key) latest.set(event.key, event);

  const needsYou = [];
  for (const record of records) {
    const key = identifier(record);
    const head = { key, company: record.company ?? null, role: record.role ?? null };
    if (record.status === 'blocked') {
      needsYou.push({
        ...head,
        kind: 'blocked',
        reason: record.blockedReason ?? 'a screening answer still needs you',
        fix: CODES['blocked-question'].fix,
        action: primaryAction(record, { gapCount: gapCountFor(record, gaps), today }),
      });
      continue;
    }
    if (record.status === 'prepared') {
      needsYou.push({
        ...head,
        kind: 'prepared',
        reason: 'the form is prepared and waiting for a human submit',
        fix: 'review the application, then submit it here',
        action: primaryAction(record, { today }),
      });
      continue;
    }
    const event = key ? latest.get(key) : null;
    if (event && !eventOk(event) && event.action !== 'blocked') {
      needsYou.push({
        ...head,
        kind: 'failed',
        reason: eventText(event),
        fix: eventFix(event),
        action: { ...primaryAction({ ...record, status: record.status === 'prepared' ? 'resolved' : record.status }, { today }), label: 'Re-run' },
      });
    }
  }

  const followUpsDue = records
    .filter((record) => isFollowUpDue(record, today))
    .map((record) => ({
      key: identifier(record),
      company: record.company ?? null,
      role: record.role ?? null,
      applied: record.applied ?? null,
      due: followUpDate(record),
    }));

  return {
    needsYou,
    followUpsDue,
    sessions,
    recent: recentFrom(events, records),
    empty: needsYou.length === 0 && followUpsDue.length === 0 && events.length === 0,
  };
}

/** Board order: best score first, newest posting first within a score. */
export function boardOrder(a, b) {
  const score = (b.score ?? -1) - (a.score ?? -1);
  if (score !== 0) return score;
  return String(b.posted ?? '').localeCompare(String(a.posted ?? ''));
}

export function countByStatus(records = []) {
  const counts = {};
  for (const record of records) {
    const status = record.status ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

export function postingsView({ records = [], filters = {}, gaps = [], today = TODAY() } = {}) {
  const minScore = filters.minScore === undefined || filters.minScore === '' ? null : Number(filters.minScore);
  const status = filters.status ? String(filters.status) : null;
  const source = filters.source ? String(filters.source).toLowerCase() : null;

  const rows = records
    .filter((record) => (status ? record.status === status : true))
    .filter((record) => (source ? sourceOf(record) === source : true))
    .filter((record) => (minScore === null || Number.isNaN(minScore) ? true : (record.score ?? -1) >= minScore))
    .sort(boardOrder)
    .map((record) => ({
      key: identifier(record),
      company: record.company ?? null,
      role: record.role ?? null,
      status: record.status ?? 'unknown',
      score: record.score ?? null,
      scoreBreakdown: scoreBreakdown(record),
      source: sourceOf(record),
      seenOn: record.seenOn ?? null,
      posted: record.posted ?? null,
      applied: record.applied ?? null,
      followUpDue: isFollowUpDue(record, today),
      action: primaryAction(record, { gapCount: record.status === 'blocked' ? gapCountFor(record, gaps) : 0, today }),
    }));

  return {
    rows,
    counts: countByStatus(records),
    statuses: [...new Set(records.map((record) => record.status ?? 'unknown'))].sort(),
    sources: [...new Set(records.map(sourceOf))].sort(),
    filters: { status, minScore: minScore === null || Number.isNaN(minScore) ? null : minScore, source },
  };
}

function letterView(letter) {
  if (!letter) return { current: null, revisions: [] };
  const revisions = (letter.revisions ?? []).map((entry) => ({
    revision: entry.revision,
    createdAt: entry.createdAt ?? null,
    origin: entry.origin ?? 'generated',
    words: entry.words ?? 0,
    note: entry.note ?? null,
    current: entry.revision === letter.current,
  }));
  return {
    current: {
      revision: letter.current,
      origin: letter.origin ?? 'generated',
      createdAt: letter.createdAt ?? null,
      words: letter.words ?? 0,
      note: letter.note ?? null,
      text: letter.text ?? '',
    },
    revisions,
  };
}

export function applicationView({ record, events = [], profile = null, letter = null, lastRun = null, today = TODAY() } = {}) {
  const key = keyOf(record);
  const refusals = [];
  for (const question of Array.isArray(record?.blocked) ? record.blocked : []) {
    refusals.push({
      field: question.label ?? question.key ?? null,
      message: question.reason ?? 'no usable answer was found',
      fix: CODES['blocked-question'].fix,
    });
  }
  if (record?.blockedReason) {
    for (const message of String(record.blockedReason).split('; ').filter(Boolean)) {
      refusals.push({ field: null, message, fix: CODES['blocked-question'].fix });
    }
  }
  const warnings = (Array.isArray(record?.warnings) ? record.warnings : []).map((warning) =>
    typeof warning === 'string' ? { message: warning } : { message: warning.message ?? String(warning), fix: warning.fix ?? null },
  );

  const latest = lastRun ?? timelineFor(events, key).at(-1) ?? null;
  return {
    record: {
      key: identifier(record),
      company: record?.company ?? null,
      role: record?.role ?? null,
      status: record?.status ?? 'unknown',
      score: record?.score ?? null,
      scoreBreakdown: scoreBreakdown(record),
      source: sourceOf(record),
      posted: record?.posted ?? null,
      applied: record?.applied ?? null,
      url: record?.url ?? null,
      applyUrl: record?.applyUrl ?? null,
      applyKind: record?.applyKind ?? null,
      screenshot: record?.screenshot ?? null,
      followUpDue: isFollowUpDue(record, today),
      letterRevision: record?.letterRevision ?? null,
    },
    timeline: timelineFor(events, key),
    answers: profile ? answersWithProvenance(profile) : [],
    letter: letterView(letter),
    lastRun: latest
      ? {
          at: latest.ts,
          action: latest.action,
          outcome: latest.outcome,
          refusals,
          warnings,
        }
      : refusals.length > 0 || warnings.length > 0
        ? { at: null, action: 'blocked', outcome: 'attention', refusals, warnings }
        : null,
    action: primaryAction(record, { gapCount: refusals.length, today }),
  };
}

/** Connections & rules: what the agent can reach and what it refuses to do. */
export function rulesView(profile) {
  const blockedTopics = (profile?.blockedTopics ?? []).map((entry) =>
    typeof entry === 'string'
      ? { key: entry, label: shortLabel(entry), reason: null }
      : { key: entry.key, label: entry.label ?? shortLabel(entry.key ?? 'blocked topic'), reason: entry.reason ?? entry.why ?? null },
  );
  const comp = profile?.compensation ?? {};
  const titles = profile?.titles ?? {};
  return {
    blockedTopics,
    scoring: {
      level: valueOf(titles.level) ?? null,
      yearsExperience: valueOf(titles.yearsExperience) ?? null,
      trackOrder: valueOf(titles.trackOrder) ?? {},
      accepted: valueOf(titles.accepted) ?? [],
      bareSoftwareEngineer: valueOf(titles.bareSoftwareEngineer) ?? null,
    },
    compensation: {
      currency: valueOf(comp.currency) ?? null,
      floor: valueOf(comp.floor) ?? null,
      target: valueOf(comp.target) ?? null,
      targetMin: valueOf(comp.targetMin) ?? null,
      targetMax: valueOf(comp.targetMax) ?? null,
      policy: valueOf(comp.policy) ?? null,
      benefits: valueOf(comp.benefits) ?? [],
    },
    never: [
      'Automate LinkedIn Easy Apply',
      'Invent an experience or screening answer',
      'Answer a blocked topic instead of asking',
      'Click submit without a human confirmation',
    ],
  };
}
