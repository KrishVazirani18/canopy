// Types for title-case.mjs, which the window imports too.
/** "Billing page copy" → "Billing Page Copy". Anything that is not a string comes back as it is. */
export function titleCase<T>(title: T): T;
