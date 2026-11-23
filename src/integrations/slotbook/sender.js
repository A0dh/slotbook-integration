// Sends validated SlotBook bookings to the CRM in chunks, deciding along the way what the CRM's
// existing data means for each one. Used by both the webhook (a chunk of one) and the backfill.
//
// Per chunk:
//   1. A booking id seen before in this run is a duplicate.
//   2. Look up each email in the CRM (once per run), because the CRM never updates a member:
//      whatever it already holds is what the booking will be attached to.
//   3. Decide per booking (decideMember): identity conflicts and the guardian rule.
//   4. Create the members that don't exist yet, then the bookings, with idempotency keys so a
//      retry or a re-run never creates a second booking.

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

    // 2. What the CRM already holds for each email. A lookup has already been retried when it
    // throws, so the CRM is down: fail the rest of the chunk rather than wait on each record.
    const lookedUp = [];
    let lookupError;
    for (const i of fresh) {
      if (lookupError) {
        fail(i, lookupError);
        continue;
      }
      const { email } = items[i].member;
      if (!known.has(email)) {
        try {
          known.set(email, await crm.findMemberByEmail(email, options));
        } catch (err) {
          lookupError = err;
          fail(i, err);
          continue;
        }
      }
      lookedUp.push(i);
    }

    // 3. Decide; the first new booking for an email defines the member to create.
    /** @type {Map<string, { member: object, indexes: number[] }>} */
    const toCreate = new Map();
    const accepted = [];
    /** Flags decided here, recorded only if the booking is imported. */
    const recovered = new Set();
    for (const i of lookedUp) {
      const { member } = items[i];
      const pending = toCreate.get(member.email);
      const decision = decideMember(items[i], pending ? pending.member : known.get(member.email) ?? null, guardianFor(member.email, member.dateOfBirth));
      if (!decision.ok) {
        reject(i, decision.reason);
        continue;
      }
      if (decision.recovered) recovered.add(i);
      if (pending) pending.indexes.push(i);
      else if (!known.get(member.email)) {
        const { guardian: _, ...rest } = member;
        const newMember = decision.guardian ? { ...rest, guardian: decision.guardian } : rest;
        toCreate.set(member.email, { member: newMember, indexes: [i] });
      }
      accepted.push(i);
    }

    // 4a. Create new members.
    const creating = [...toCreate.values()];
    if (creating.length > 0) {
      try {
        const results = await crm.upsertMembers(creating.map((c) => c.member), options);
        creating.forEach(({ member, indexes }, n) => {
          const result = results.find((r) => r.index === n);
          if (result?.id && result.created === false) {
            // Created by another request since our lookup (e.g. two webhooks at once). The CRM
            // keeps its own details, unchecked here: fail, so a retry checks the stored record.
            known.delete(member.email);
            for (const i of indexes) fail(i, new Error('Member was created meanwhile; retry to check it'));
          } else if (result?.id && result.status < 300) known.set(member.email, { id: result.id, dateOfBirth: member.dateOfBirth, guardian: member.guardian });
          else for (const i of indexes) {
            if (result?.status === 422) reject(i, `member_refused_by_crm(${Object.keys(result.error?.fields ?? {}).join(',')})`);
            else fail(i, new Error(result ? `CRM responded ${result.status} for the member` : 'No result for the member'));
          }
        });
      } catch (err) {
        for (const { indexes } of creating) for (const i of indexes) fail(i, err);
      }
    }

    // 4b. Create bookings for everything still accepted.
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
