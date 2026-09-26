export function createAdmissionGate(limit) {
  let active = 0;
  return () => {
    if (active >= limit) return null;
    active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
    };
  };
}

// checkLiveness serializes browser work within this process. Keep requests
// waiting for that queue bounded so a busy route can answer 429 promptly.
export const admitLivenessRequest = createAdmissionGate(4);
