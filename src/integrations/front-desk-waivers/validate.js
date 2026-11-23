// Checks a mapped waiver before it goes to the CRM.

/**
 * @param {ReturnType<typeof import('./map.js').mapWaiver>} member
 * @returns {string[]} problems; empty when valid
 */
export function validateWaiver(member) {
  const problems = [];
  if (!member.firstName) problems.push('First name is missing');
  if (!member.lastName) problems.push('Last name is missing');
  if (!member.email.includes('@')) problems.push('Email address is not valid');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(member.dateOfBirth)) problems.push('Date of birth is not YYYY-MM-DD');
  return problems;
}
