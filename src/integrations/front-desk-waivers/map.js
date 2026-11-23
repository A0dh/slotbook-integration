// Maps a row from the front-desk tablet's waiver export to a CRM member.
//
// Export columns: waiver_id, signed_at, full_name, email, date_of_birth, postcode, phone

/**
 * @param {Record<string, string>} row
 */
export function mapWaiver(row) {
  const fullName = row.full_name.trim();
  const lastSpace = fullName.lastIndexOf(' ');
  if (lastSpace === -1) throw new Error('full_name has no surname');

  return {
    firstName: fullName.slice(0, lastSpace),
    lastName: fullName.slice(lastSpace + 1),
    email: row.email.trim(),
    dateOfBirth: row.date_of_birth.trim(),
    postcode: row.postcode.trim().toUpperCase() || undefined,
    phone: row.phone.trim() || undefined,
    source: 'front-desk-waivers',
    sourceRef: row.waiver_id,
  };
}
