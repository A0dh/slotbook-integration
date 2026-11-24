// Sends validated SlotBook bookings to the CRM in chunks, deciding along the way what the CRM's
// existing data means for each one. Used by both the webhook (a chunk of one) and the backfill.
//
// Per chunk:
//   1. A booking id seen before in this run is a duplicate.
//   2. Decide per booking (decideMember): identity conflicts and the guardian rule, against what
//      the CRM holds for its email. The CRM never updates a member, so whatever it already holds
//      is what the booking will be attached to.
//   3. Create first, look up only when needed: an email not seen yet in this run is assumed new
//      and its member created. Only when the CRM answers that it already held the email
//      (`created: false`), or every booking for it was refused as new, is it looked up and
//      decided again. A fresh backfill then needs almost no lookups, and a member batch whose
//      response was lost (timeout, 5xx) is retried into `created: false` and checked rather
//      than failed.
//   4. Create the bookings, with idempotency keys so a retry or a re-run never creates a second
//      booking.

import { isValidGuardian } from '../../lib/validators.js';
import { isMinorAt } from './validate.js';

/**
 * @typedef {import('./map.js').MappedBooking} MappedBooking
 * @typedef {import('./map.js').Guardian} Guardian
 * @typedef {import('../../pipeline/run.js').SendOutcome} SendOutcome
 * @typedef {{ id?: string, dateOfBirth?: string, guardian?: unknown }} KnownMember a CRM member, or one this chunk is about to create
 * @typedef {{ ok: true, guardian?: Guardian, recovered: boolean } | { ok: false, reason: string }} Decision
 */

/**
 * The guardian rule and identity check for one booking, given what the CRM holds for its email.
 * Pure, so every case can be tested without a CRM.
 * @param {MappedBooking} item
 * @param {KnownMember | null} known
 * @param {Guardian | undefined} guardianFromOtherBookings a guardian given on another booking by the same climber
 * @returns {Decision}
 */
export function decideMember(item, known, guardianFromOtherBookings) {
  const { member, booking } = item;
  // Same email, different date of birth: probably a different person (e.g. a parent booking a
  // child with their own email). Attaching the booking would put it on the wrong record.
  if (known && known.dateOfBirth !== member.dateOfBirth) return { ok: false, reason: 'identity_conflict' };

  if (!isMinorAt(member.dateOfBirth, booking.sessionStart)) return { ok: true, guardian: member.guardian, recovered: false };

  // Under 18: the CRM record the booking lands on must have a guardian contact.
  if (known) return isValidGuardian(known.guardian) ? { ok: true, recovered: false } : { ok: false, reason: 'guardian_not_on_crm_record' };
  if (member.guardian) return { ok: true, guardian: member.guardian, recovered: false };
  if (guardianFromOtherBookings) return { ok: true, guardian: guardianFromOtherBookings, recovered: true };
  // Tell staff apart "none given" and "given but unusable" (dropped in mapping).
  return { ok: false, reason: item.flags.includes('guardian_dropped') ? 'guardian_unusable' : 'guardian_required' };
}

/**
 * Decides every booking for one email, in order, against what the CRM holds for it (`base`;
 * null: nobody). With nobody, the first accepted booking defines the member to create and the
 * later ones are checked against that member.
 * @param {MappedBooking[]} items
 * @param {number[]} indexes
 * @param {KnownMember | null} base
 * @param {(email: string, dateOfBirth: string) => Guardian | undefined} guardianFor
 */
function decideGroup(items, indexes, base, guardianFor) {
  /** @type {number[]} */
  const accepted = [];
  /** @type {[number, string][]} */
  const rejected = [];
  /** @type {number[]} */
  const recovered = [];
  let current = base;
  /** @type {object | undefined} */
  let create;
  for (const i of indexes) {
    const { member } = items[i];
    const decision = decideMember(items[i], current, guardianFor(member.email, member.dateOfBirth));
    if (!decision.ok) {
      rejected.push([i, decision.reason]);
      continue;
    }
    if (decision.recovered) recovered.push(i);
    if (!current) {
      const { guardian: _, ...rest } = member;
      create = decision.guardian ? { ...rest, guardian: decision.guardian } : rest;
      current = create;
    }
    accepted.push(i);
  }
  return { accepted, rejected, recovered, create };
}

/**
 * @param {{
 *   crm: Pick<import('../../pipeline/crm-client.js').CrmClient, 'findMemberByEmail' | 'upsertMembers' | 'createBookings'>,
 *   summary: Pick<import('../../pipeline/summary.js').RunSummary, 'flag'>,
 *   guardianFor?: (email: string, dateOfBirth: string) => Guardian | undefined,
 *   signal?: AbortSignal,
 * }} deps
 * @returns {(items: MappedBooking[]) => Promise<SendOutcome[]>}
 */
export function createSender({ crm, summary, guardianFor = () => undefined, signal }) {
  /** Booking ids already handled in this run. */
  const seen = new Set();
  /** @type {Map<string, KnownMember | null>} email → what the CRM holds (null: nobody) */
  const known = new Map();
  const options = { signal };

  return async function sendBatch(items) {
    /** @type {SendOutcome[]} */
    const outcomes = new Array(items.length);
    const reject = (i, reason) => (outcomes[i] = { status: 'rejected', reasons: [reason] });
    const fail = (i, err) => (outcomes[i] = { status: 'failed', error: err.message });

    // 1. Duplicates within the run.
    const fresh = [];
    items.forEach((item, i) => {
      if (seen.has(item.bookingId)) return reject(i, 'duplicate_booking');
      seen.add(item.bookingId);
      fresh.push(i);
    });

    // 2. Decide each email's bookings against what is known. A lookup has already been retried
    // when it throws, so the CRM is down: fail the rest of the chunk's lookups rather than wait.
    /** @type {Map<string, number[]>} email → its bookings in this chunk, in order */
    const byEmail = new Map();
    for (const i of fresh) {
      const { email } = items[i].member;
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(i);
    }

    const accepted = [];
    /** Flags decided here, recorded only if the booking is imported. */
    const recovered = new Set();
    const settle = ({ accepted: ok, rejected, recovered: rec }) => {
      for (const [i, reason] of rejected) reject(i, reason);
      for (const i of rec) recovered.add(i);
      accepted.push(...ok);
    };
    let lookupError;
    /** Looks the email up into `known`; false (its bookings failed) when the CRM can't answer. */
    const lookUp = async (email, indexes) => {
      if (!lookupError) {
        try {
          known.set(email, await crm.findMemberByEmail(email, options));
          return true;
        } catch (err) {
          lookupError = err;
        }
      }
      for (const i of indexes) fail(i, lookupError);
      return false;
    };

    /** @type {{ email: string, indexes: number[], decided: ReturnType<typeof decideGroup> }[]} */
    const toCreate = [];
    const toLookUp = [];
    for (const [email, indexes] of byEmail) {
      const base = known.get(email) ?? null;
      const decided = decideGroup(items, indexes, base, guardianFor);
      if (decided.create) toCreate.push({ email, indexes, decided });
      // Refused as a new member (e.g. an under-18 with no guardian): an existing record might
      // still take it, so check what the CRM holds, unless this run already did.
      else if (!known.has(email)) toLookUp.push({ email, indexes });
      else settle(decided);
    }
    for (const { email, indexes } of toLookUp) {
      if (await lookUp(email, indexes)) settle(decideGroup(items, indexes, known.get(email) ?? null, guardianFor));
    }

    // 3. Create new members. `created: false` means the CRM already held the email (another
    // request, or our own batch retried after a lost response) and kept its own details: look it
    // up and decide again against what it holds.
    if (toCreate.length > 0) {
      const heldAlready = [];
      try {
        const results = await crm.upsertMembers(toCreate.map((c) => c.decided.create), options);
        toCreate.forEach((c, n) => {
          const result = results.find((r) => r.index === n);
          const member = /** @type {MappedBooking['member']} */ (c.decided.create);
          if (result?.id && result.created === false) heldAlready.push(c);
          else if (result?.id && result.status < 300) {
            known.set(c.email, { id: result.id, dateOfBirth: member.dateOfBirth, guardian: member.guardian });
            settle(c.decided);
          } else {
            for (const [i, reason] of c.decided.rejected) reject(i, reason);
            for (const i of c.decided.accepted) {
              if (result?.status === 422) reject(i, `member_refused_by_crm(${Object.keys(result.error?.fields ?? {}).join(',')})`);
              else fail(i, new Error(result ? `CRM responded ${result.status} for the member` : 'No result for the member'));
            }
          }
        });
      } catch (err) {
        for (const { indexes } of toCreate) for (const i of indexes) fail(i, err);
      }
      for (const { email, indexes } of heldAlready) {
        if (!(await lookUp(email, indexes))) continue;
        if (known.get(email)) settle(decideGroup(items, indexes, known.get(email), guardianFor));
        else for (const i of indexes) fail(i, new Error('CRM reported the member as existing but has no record of it'));
      }
    }

    // 4. Create bookings for everything still accepted.
    const ready = accepted.filter((i) => !outcomes[i] && known.get(items[i].member.email)?.id);
    for (const i of accepted) if (!outcomes[i] && !ready.includes(i)) fail(i, new Error('No member id'));
    if (ready.length === 0) return outcomes;

    try {
      const results = await crm.createBookings(
        ready.map((i) => ({
          memberId: known.get(items[i].member.email)?.id,
          ...items[i].booking,
          idempotencyKey: `slotbook:${items[i].bookingId}`,
        })),
        options,
      );
      ready.forEach((i, n) => {
        const result = results.find((r) => r.index === n);
        if (result && result.status < 300) {
          outcomes[i] = { status: 'imported' };
          for (const code of items[i].flags) summary.flag(items[i].bookingId, code);
          if (recovered.has(i)) summary.flag(items[i].bookingId, 'guardian_recovered');
        } else if (result?.status === 409) reject(i, 'conflicts_with_crm');
        else if (result?.status === 422) reject(i, `booking_refused_by_crm(${Object.keys(result.error?.fields ?? {}).join(',')})`);
        else fail(i, new Error(result ? `CRM responded ${result.status} for the booking` : 'No result for the booking'));
      });
    } catch (err) {
      for (const i of ready) fail(i, err);
    }
    return outcomes;
  };
}
