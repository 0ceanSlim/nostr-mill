/**
 * MILL — kinds.js
 * Human-readable names for Nostr event kinds, for the signing consent card.
 *
 * Table adapted from grain's client/nostr_kinds.go, which sources the Event
 * Kinds section of github.com/nostr-protocol/nips README. Labels here are
 * rephrased for a consent sentence — the card reads "wants you to sign a
 * {label}", so labels are noun phrases the user might actually recognise
 * ("Reaction", not "User Metadata (NIP-01)"). The NIP is kept separately for
 * the details view rather than baked into the label.
 *
 * Intentionally not exhaustive — only labels we can stand behind. Unknown
 * kinds fall back to the event's `alt` tag, then to "Event kind N". Update by
 * reading the upstream README, not by inventing labels.
 */

// kind → [label, nip]
const KINDS = {
  0:     ['Profile Update',            'NIP-01'],
  1:     ['Note',                      'NIP-01'],
  2:     ['Relay Recommendation',      'deprecated'],
  3:     ['Follow List',               'NIP-02'],
  4:     ['Encrypted Message',         'NIP-04, deprecated'],
  5:     ['Deletion Request',          'NIP-09'],
  6:     ['Repost',                    'NIP-18'],
  7:     ['Reaction',                  'NIP-25'],
  8:     ['Badge Award',               'NIP-58'],
  9:     ['Chat Message',              'NIP-C7'],
  13:    ['Seal',                      'NIP-59'],
  14:    ['Direct Message',            'NIP-17'],
  15:    ['File Message',              'NIP-17'],
  16:    ['Repost',                    'NIP-18'],
  17:    ['Website Reaction',          'NIP-25'],
  20:    ['Picture Post',              'NIP-68'],
  21:    ['Video Post',                'NIP-71'],
  22:    ['Short Video',               'NIP-71'],
  40:    ['Channel Creation',          'NIP-28'],
  41:    ['Channel Metadata',          'NIP-28'],
  42:    ['Channel Message',           'NIP-28'],
  43:    ['Channel Message Hide',      'NIP-28, deprecated'],
  44:    ['Channel User Mute',         'NIP-28, deprecated'],
  1059:  ['Gift Wrap',                 'NIP-59'],
  1063:  ['File Metadata',             'NIP-94'],
  1311:  ['Live Chat Message',         'NIP-53'],
  1984:  ['Report',                    'NIP-56'],
  1985:  ['Label',                     'NIP-32'],
  9734:  ['Zap Request',               'NIP-57'],
  9735:  ['Zap Receipt',               'NIP-57'],
  10000: ['Mute List',                 'NIP-51'],
  10001: ['Pin List',                  'NIP-51'],
  10002: ['Relay List',                'NIP-65'],
  10003: ['Bookmark List',             'NIP-51'],
  10004: ['Communities List',          'NIP-51'],
  10005: ['Public Chats List',         'NIP-51'],
  10006: ['Blocked Relays List',       'NIP-51'],
  10007: ['Search Relays List',        'NIP-51'],
  10015: ['Interests List',            'NIP-51'],
  10030: ['Emoji List',                'NIP-51'],
  22242: ['Relay Authentication',      'NIP-42'],
  27235: ['HTTP Authentication',       'NIP-98'],
  30000: ['Follow Set',                'NIP-51'],
  30002: ['Relay Set',                 'NIP-51'],
  30003: ['Bookmark Set',              'NIP-51'],
  30004: ['Curation Set',              'NIP-51'],
  30008: ['Profile Badges',            'NIP-58'],
  30009: ['Badge Definition',          'NIP-58'],
  30015: ['Interest Set',              'NIP-51'],
  30017: ['Stall',                     'NIP-15'],
  30018: ['Product',                   'NIP-15'],
  30023: ['Article',                   'NIP-23'],
  30024: ['Article Draft',             'NIP-23'],
  30030: ['Emoji Set',                 'NIP-51'],
  30078: ['App Data',                  'NIP-78'],
  30311: ['Live Event',                'NIP-53'],
  30315: ['Status Update',             'NIP-38'],
  30402: ['Classified Listing',        'NIP-99'],
  30403: ['Classified Listing Draft',  'NIP-99'],
  31922: ['Calendar Event',            'NIP-52'],
  31923: ['Calendar Event',            'NIP-52'],
  31924: ['Calendar',                  'NIP-52'],
  31925: ['Calendar RSVP',             'NIP-52'],
  31989: ['App Recommendation',        'NIP-89'],
  31990: ['App Handler',               'NIP-89'],
  34550: ['Community Definition',      'NIP-72'],
};

/** Raw table lookup. Returns [label, nip] or undefined. */
export function kindEntry(kind) { return KINDS[kind]; }

/** The NIP a kind is defined by, or '' if unknown. */
export function kindNip(kind) { return KINDS[kind]?.[1] || ''; }

/**
 * Human-readable name for what's being signed.
 *
 * Fallback chain mirrors Amber's: known kind → the event's own `alt` tag
 * (NIP-31, which exists precisely so unknown kinds can describe themselves)
 * → a bare "Event kind N". Never returns an empty string.
 */
export function kindLabel(event) {
  const kind = typeof event === 'number' ? event : event?.kind;
  const hit = KINDS[kind];
  if (hit) return hit[0];

  const group = kindGroupLabel(kind);
  if (group) return group;

  if (event && Array.isArray(event.tags)) {
    const alt = event.tags.find(t => t?.[0] === 'alt')?.[1];
    if (alt && alt.trim()) return alt.trim();
  }
  return kind === undefined || kind === null ? 'Unknown Event' : `Event kind ${kind}`;
}

/**
 * Indefinite article for a label, so the consent sentence reads "an Article"
 * rather than "a Article". Vowel-letter test is wrong for a few words
 * ("a User Status"), but every label in the table above is regular.
 */
export function kindArticle(label) {
  return /^[aeiou]/i.test(String(label || '')) ? 'an' : 'a';
}

/**
 * Ranges get one generic label rather than 2000 individual entries.
 * NIP-90 data-vending-machine kinds are allocated in blocks, so the specific
 * number carries less meaning than the block does.
 */
export function kindGroupLabel(kind) {
  if (kind >= 5000 && kind <= 5999) return 'Job Request';
  if (kind >= 6000 && kind <= 6999) return 'Job Result';
  if (kind >= 7000 && kind <= 7999) return 'Job Feedback';
  return null;
}

// ── Permission categories ─────────────────────────────────────────────────────
// The coarse buckets shown on the setup screen. Runtime grants are per-kind
// (matching Amber), but the pre-approval policy is chosen per category — six
// choices is a screen a person will actually read; 60 is not.
export function categoryForKind(kind) {
  if (kind === 1 || kind === 6 || kind === 7 || kind === 16) return 'notes';
  if (kind === 0) return 'profile';
  if (kind === 3) return 'contacts';
  if (kind === 4 || kind === 14 || kind === 1059 || kind === 13) return 'dms';
  if (kind === 9734 || kind === 9735) return 'zaps';
  return 'other';
}

export function categoryFor(event) {
  return categoryForKind(typeof event === 'number' ? event : event?.kind);
}
