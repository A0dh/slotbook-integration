// Checks a mapped Chalk Shop order before it goes to the CRM.

/**
 * @param {ReturnType<typeof import('./map.js').mapOrder>} order
 * @returns {string[]} problems; empty when valid
 */
export function validateOrder({ member, booking }) {
  const problems = [];
  if (!member.firstName || !member.lastName) problems.push('Customer name is missing');
  if (!member.email.includes('@')) problems.push('Email address is not valid');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(member.dateOfBirth ?? '')) problems.push('Date of birth is not YYYY-MM-DD');
  if (Number.isNaN(Date.parse(booking.sessionStart))) problems.push('Session start is not a valid date');
  if (!Number.isInteger(booking.amountPence) || booking.amountPence < 0) problems.push('Price is not a whole number of pence');
  return problems;
}
