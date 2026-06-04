// Strip all non-digit characters. Keeps full length (country code intact).
export const normalizePhoneNumber = (phone) =>
  phone?.replace(/\D/g, '') || '';

// Last-10-digit normalisation lets us match phone numbers across any format
// ('9876543210', '+919876543210', '919876543210', etc.) by ignoring country
// codes and non-digit characters.
export const normalizeLast10 = (p) =>
  (p || '').toString().replace(/\D/g, '').slice(-10);
