// People are often saved with one of their groups as a name prefix
// ("IITB Vaibhav (Civil)" in the "IITB" group). Wherever we show the name we
// also show the group alongside it (a chip, pill, or the group screen itself),
// so repeating it in the name is just clutter. `displayNameFor` strips a
// leading, whole-word token that matches one of the contact's OWN groups,
// turning "IITB Vaibhav (Civil)" → "Vaibhav (Civil)".
//
// Only a leading match followed by a separator is stripped, so "IITB" never
// chops "IITBombay". When several groups prefix the name (e.g. both "IIT" and
// "IIT Bombay"), the longest match wins so the whole prefix comes off.
export const displayNameFor = (profile) => {
  const name = (profile?.contact?.name || '').trim();
  if (!name) return name;
  const lower = name.toLowerCase();

  let best = '';
  (profile?.groups || []).forEach((g) => {
    const gName = (g?.name || '').trim();
    if (!gName || gName.length <= best.length) return;
    if (!lower.startsWith(gName.toLowerCase())) return;
    const rest = name.slice(gName.length);
    // Whole-word only: the group name must be the entire string or be followed
    // by a separator.
    if (rest === '' || /^[\s\-_]/.test(rest)) best = gName;
  });

  if (!best) return name;
  const stripped = name.slice(best.length).replace(/^[\s\-_]+/, '').trim();
  // Never strip away the whole name (a contact literally named after the group).
  return stripped || name;
};
