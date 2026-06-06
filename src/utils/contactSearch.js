// Shared contact search helper. Lower-cases + flattens the bag of fields each
// contact carries so a single substring query can match across name, company,
// role, city, label, phone, email, etc. Precompute once per contact and run
// String.includes per keystroke — cheap even with a few thousand contacts.
export const buildSearchHaystack = (c) => {
  const parts = [
    c.name,
    c.company,
    c.jobTitle,
    c.department,
    c.note,
    c.label,
    c.phone,
    c.normalized,
    ...((c.postalAddresses || []).flatMap((a) => [a.city, a.state, a.country, a.label])),
    ...((c.emailAddresses || []).map((e) => e.email)),
    ...((c.numbers || []).flatMap((n) => [n.phone, n.label])),
  ];
  return parts
    .filter(Boolean)
    .map((s) => String(s).toLowerCase())
    .join('   ');
};
