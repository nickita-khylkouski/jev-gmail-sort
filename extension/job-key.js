// A reply, read/star change or different owner can change a ranking without changing thread ids.
export const jobKey = (rows, q, owner) => JSON.stringify([q, owner, rows]);
