// Maps a Chalk Shop order webhook to a CRM member and booking.
//
// Chalk Shop is the gym's online shop. It sends one webhook per order of a
// day pass or a course place. Example: data/chalk-shop/webhooks/

const SESSION_TYPES = { 'day-pass': 'bouldering', course: 'course' };

/**
 * @param {any} order
 */
export function mapOrder(order) {
  const { customer, item } = order;
  return {
    member: {
      firstName: customer.firstName.trim(),
      lastName: customer.lastName.trim(),
      email: customer.email.trim(),
      dateOfBirth: customer.dateOfBirth,
      source: 'chalk-shop',
      sourceRef: order.orderId,
    },
    booking: {
      sessionStart: item.sessionStart,
      sessionType: SESSION_TYPES[item.kind] ?? 'other',
      amountPence: item.pricePence,
      source: 'chalk-shop',
      sourceRef: order.orderId,
    },
  };
}
