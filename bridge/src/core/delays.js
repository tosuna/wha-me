export const replyDelayMs = (rng = Math.random) => 180000 + rng() * 180000;
// Persona chats (banter): answer right away. Not 0: a busy chat reschedules with this delay (bridge.js), so 0 would spin.
export const personaDelayMs = (rng = Math.random) => 1000 + rng() * 1000;
export const typingMs = (text, rng = Math.random) => (text.length / 4) * 1000 * (0.8 + rng() * 0.4);
export const bubbleGapMs = (rng = Math.random) => 1500 + rng() * 2500;
// Shadow sends nothing to contacts: only a short debounce so a burst of messages still becomes one run.
export const shadowDelayMs = () => 15000;
